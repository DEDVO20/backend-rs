import { supabase } from '../../lib/supabase.js'
import { redis } from '../../lib/redis.js'
import { logger } from '../../lib/logger.js'
import type { AuthUser } from '../../middleware/auth.js'
import { normalizeNit } from '../participations/participations.domain.js'
import { SIIGO_CONFIG, validateSiigoConfig } from './siigo.config.js'
import { formatDate, incrementalStartDate, matchCompanyByNit, normalizeDateText, sleep } from './siigo.helpers.js'
import {
  buildVentaLinesPorProducto,
  getComprobanteSiigo,
  lineToExcelRow,
  type SiigoDocType,
  type SiigoSalesLineInput,
} from './siigo.calculator.js'
import { SiigoApiClient } from './siigo.client.js'
import { siigoCatalogCache } from './siigo.cache.js'
import { buildSiigoExcelBuffer } from './siigo.exporter.js'
import type { ListSiigoSalesQuery, SyncSiigoBody } from './siigo.schema.js'

const INTERNAL_ROLES = ['admin', 'rs_admin', 'rs_staff', 'contador']
const REDIS_FALLBACK_LOGS_KEY = 'siigo:sync_logs:v1'
const FETCH_PAGE_SIZE = 1000       // max-rows por defecto de PostgREST
const REPLACE_DOCS_PER_CALL = 100  // documentos por llamada a siigo_replace_doc_lines

export interface SyncLogEntry {
  id: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'completed' | 'failed'
  start_date: string
  end_date: string
  seller_filter: string
  invoices_count: number
  credit_notes_count: number
  lines_count: number
  http_requests_count: number
  duration_sec: number
  error_message?: string | null
  triggered_by?: string | null
}

type CompanyRef = {
  id: string
  name: string
  nit: string | null
  normNit: string
}

type ClientCompany = { id: string; name: string; nit: string | null }

/** Alcance de la consulta: los clientes quedan aislados por company_id */
type SalesScope = {
  isInternal: boolean
  companyId: string | null
  clientCompany: ClientCompany | null
  denied: boolean
}

/** Parámetros de public.siigo_sales_lines_filtered */
type SalesFilterArgs = {
  p_company_id:   string | null
  p_start:        string | null
  p_end:          string | null
  p_period:       string | null
  p_doc_type:     string | null
  p_product_code: string | null
  p_nit:          string | null
  p_search:       string | null
}

type SalesSummary = {
  totalFacturas: number
  totalNotasCredito: number
  totalLineas: number
  totalBruto: number
  totalDescuento: number
  totalSubtotal: number
  totalImpuestos: number
  totalRetenciones: number
  totalNeto: number
}

type SalesReport = {
  summary: SalesSummary
  monthly: unknown[]
  byProduct: unknown[]
  byCustomer: unknown[]
  catalogs: { products: unknown[]; customers: unknown[] }
}

type ProcessedDoc = { id: string; comprobante: string; lines: SiigoSalesLineInput[] }

const EMPTY_REPORT: SalesReport = {
  summary: {
    totalFacturas: 0,
    totalNotasCredito: 0,
    totalLineas: 0,
    totalBruto: 0,
    totalDescuento: 0,
    totalSubtotal: 0,
    totalImpuestos: 0,
    totalRetenciones: 0,
    totalNeto: 0,
  },
  monthly: [],
  byProduct: [],
  byCustomer: [],
  catalogs: { products: [], customers: [] },
}

// PostgREST responde 416 (PGRST103) cuando el offset supera el total de filas
const isRangeNotSatisfiable = (error: { code?: string } | null) => error?.code === 'PGRST103'

export class SiigoService {
  private static memoryLogs: SyncLogEntry[] = []
  private static isSyncRunning = false

  static get running(): boolean {
    return this.isSyncRunning
  }

  /** Listado de empresas para cruzar NIT de Siigo -> company_id */
  static async loadCompanies(): Promise<CompanyRef[]> {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, nit')

    if (error) throw new Error(`No se pudieron cargar las empresas: ${error.message}`)

    return (data ?? []).map((c: any) => ({
      id:      c.id,
      name:    c.name ?? '',
      nit:     c.nit ?? null,
      normNit: normalizeNit(c.nit ?? ''),
    }))
  }

  private static normalizeRow(r: any): SiigoSalesLineInput {
    return {
      siigo_doc_id:        String(r.siigo_doc_id ?? r.comprobante ?? ''),
      line_index:          Number(r.line_index ?? 0),
      doc_type:            r.doc_type === 'NOTA_CREDITO' ? 'NOTA_CREDITO' : 'FACTURA',
      comprobante:         String(r.comprobante ?? ''),
      doc_date:            String(r.doc_date ?? '').slice(0, 10),
      period:              String(r.period ?? String(r.doc_date ?? '').slice(0, 7)),
      customer_nit:        String(r.customer_nit ?? ''),
      normalized_nit:      String(r.normalized_nit || normalizeNit(r.customer_nit ?? '')),
      company_id:          r.company_id ?? null,
      sucursal:            String(r.sucursal ?? ''),
      customer_name:       String(r.customer_name ?? ''),
      seller_id:           String(r.seller_id ?? ''),
      product_code:        String(r.product_code ?? ''),
      product_description: String(r.product_description ?? ''),
      gross_value:         Number(r.gross_value ?? 0),
      discount:            Number(r.discount ?? 0),
      subtotal:            Number(r.subtotal ?? 0),
      tax_charge:          Number(r.tax_charge ?? 0),
      tax_retention:       Number(r.tax_retention ?? 0),
      total_charges:       Number(r.total_charges ?? 0),
      total_discounts:     Number(r.total_discounts ?? 0),
      total:               Number(r.total ?? 0),
    }
  }

  /**
   * Reemplaza en Supabase las líneas de los documentos procesados (borra + inserta en
   * una transacción por lote). Elimina líneas huérfanas y las de documentos anulados.
   */
  static async replaceDocLines(docs: ProcessedDoc[]): Promise<number> {
    let inserted = 0
    for (let i = 0; i < docs.length; i += REPLACE_DOCS_PER_CALL) {
      const chunk = docs.slice(i, i + REPLACE_DOCS_PER_CALL)
      const { data, error } = await supabase.rpc('siigo_replace_doc_lines', {
        p_doc_ids:      chunk.map(d => d.id),
        p_comprobantes: chunk.map(d => d.comprobante).filter(Boolean),
        p_lines:        chunk.flatMap(d => d.lines),
      })
      if (error) throw new Error(`No se pudieron guardar las líneas de Siigo: ${error.message}`)
      inserted += Number(data ?? 0)
    }
    return inserted
  }

  /** Vincula a su empresa las líneas que quedaron sin company_id (p. ej. empresas creadas después) */
  static async relinkCompanies(companies: CompanyRef[]): Promise<number> {
    const { data, error } = await supabase.rpc('siigo_unlinked_nits')
    if (error) throw new Error(`No se pudieron consultar NIT sin vincular: ${error.message}`)

    let relinked = 0
    for (const nit of (data ?? []) as string[]) {
      const company = matchCompanyByNit(companies, nit)
      if (!company) continue
      const { error: updError } = await supabase
        .from('siigo_sales_lines')
        .update({ company_id: company.id })
        .is('company_id', null)
        .eq('normalized_nit', nit)
      if (updError) {
        logger.warn({ nit, err: updError.message }, 'No se pudo vincular NIT de Siigo a empresa')
        continue
      }
      relinked++
    }
    return relinked
  }

  /** Sincroniza facturas y notas crédito desde la API de Siigo */
  static async syncFromSiigo(input: SyncSiigoBody, triggeredBy?: string) {
    if (this.isSyncRunning) {
      const err = new Error('Ya hay una sincronización con Siigo en curso. Por favor espera a que termine.')
      ;(err as any).statusCode = 409
      throw err
    }

    const configErrors = validateSiigoConfig()
    if (configErrors.length > 0) {
      const err = new Error(configErrors.join('. '))
      ;(err as any).statusCode = 400
      throw err
    }

    const now = new Date()
    const sellerFilter = input.sellerFilter !== undefined ? input.sellerFilter : SIIGO_CONFIG.SELLER_ID_FILTER
    let startDate: string
    let endDate = input.endDate ? normalizeDateText(input.endDate) : formatDate(now)

    if (input.mode === 'incremental') {
      endDate = formatDate(now)
      startDate = incrementalStartDate(
        await this.getLastCompletedEndDate(sellerFilter),
        SIIGO_CONFIG.SYNC_OVERLAP_DAYS,
        SIIGO_CONFIG.START_YEAR,
      )
    } else if (input.mode === 'range' && input.startDate) {
      startDate = normalizeDateText(input.startDate)
    } else if (input.mode === 'days') {
      const past = new Date()
      past.setDate(past.getDate() - (input.days || 15))
      startDate = formatDate(past)
    } else {
      const year = input.year || SIIGO_CONFIG.START_YEAR
      startDate = `${year}-01-01`
    }

    const startTime = Date.now()
    this.isSyncRunning = true

    const api = new SiigoApiClient()

    try {
      await api.getAccessToken()

      const invoices = await api.listDocumentIds(
        SIIGO_CONFIG.INVOICES_URL,
        startDate,
        endDate,
        'Facturas',
        sellerFilter,
      )
      const creditNotes = await api.listDocumentIds(
        SIIGO_CONFIG.CREDIT_NOTES_URL,
        startDate,
        endDate,
        'Notas Crédito',
        sellerFilter,
      )

      const companies = await this.loadCompanies()
      const processed: ProcessedDoc[] = []

      const sources: { url: string; ids: string[]; docType: SiigoDocType; sign: 1 | -1; label: string }[] = [
        { url: SIIGO_CONFIG.INVOICES_URL,     ids: invoices.ids,    docType: 'FACTURA',      sign: 1,  label: 'factura' },
        { url: SIIGO_CONFIG.CREDIT_NOTES_URL, ids: creditNotes.ids, docType: 'NOTA_CREDITO', sign: -1, label: 'nota crédito' },
      ]

      for (const source of sources) {
        for (const id of source.ids) {
          try {
            const doc = await api.fetchDocumentById(source.url, id)
            const docLines = await buildVentaLinesPorProducto(
              doc,
              source.docType,
              source.sign,
              api,
              startDate,
              endDate,
              sellerFilter,
            )
            processed.push({
              id,
              comprobante: docLines[0]?.comprobante ?? getComprobanteSiigo(doc, source.docType),
              lines: docLines.map(line => {
                const matched = matchCompanyByNit(companies, line.customer_nit)
                return {
                  ...line,
                  siigo_doc_id:   id,
                  normalized_nit: normalizeNit(line.customer_nit),
                  company_id:     matched?.id ?? null,
                  customer_name:  line.customer_name || matched?.name || '',
                }
              }),
            })
          } catch (err: any) {
            // Si el detalle falla se conservan las líneas previas del documento
            logger.warn({ id, err: err.message }, `No se pudo procesar ${source.label} Siigo`)
          }
          await sleep(SIIGO_CONFIG.SLEEP_BETWEEN_DOCS_MS)
        }
      }

      // Documentos anulados/borrador: se eliminan sus líneas
      for (const doc of [...invoices.excluded, ...creditNotes.excluded]) {
        processed.push({ id: doc.id, comprobante: doc.comprobante, lines: [] })
      }

      await siigoCatalogCache.flushToDatabase()
      const linesCount = await this.replaceDocLines(processed)
      await this.relinkCompanies(companies)

      const durationSec = Math.round((Date.now() - startTime) / 1000)
      const logEntry: SyncLogEntry = {
        id:                  crypto.randomUUID(),
        started_at:          new Date(startTime).toISOString(),
        finished_at:         new Date().toISOString(),
        status:              'completed',
        start_date:          startDate,
        end_date:            endDate,
        seller_filter:       sellerFilter || 'Todos',
        invoices_count:      invoices.ids.length,
        credit_notes_count:  creditNotes.ids.length,
        lines_count:         linesCount,
        http_requests_count: api.urlFetchCount,
        duration_sec:        durationSec,
        triggered_by:        triggeredBy ?? null,
      }

      await this.saveSyncLog(logEntry)

      return logEntry
    } catch (err: any) {
      const durationSec = Math.round((Date.now() - startTime) / 1000)
      await this.saveSyncLog({
        id:                  crypto.randomUUID(),
        started_at:          new Date(startTime).toISOString(),
        finished_at:         new Date().toISOString(),
        status:              'failed',
        start_date:          startDate,
        end_date:            endDate,
        seller_filter:       sellerFilter || 'Todos',
        invoices_count:      0,
        credit_notes_count:  0,
        lines_count:         0,
        http_requests_count: api.urlFetchCount,
        duration_sec:        durationSec,
        error_message:       err.message,
        triggered_by:        triggeredBy ?? null,
      })
      throw err
    } finally {
      this.isSyncRunning = false
    }
  }

  /** Última fecha cubierta por una sync completada con el mismo filtro de vendedor */
  private static async getLastCompletedEndDate(sellerFilter: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('siigo_sync_logs')
      .select('end_date')
      .eq('status', 'completed')
      .eq('seller_filter', sellerFilter || 'Todos')
      .order('end_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw new Error(`No se pudo consultar la última sync de Siigo: ${error.message}`)
    return data?.end_date ? String(data.end_date) : null
  }

  private static async saveSyncLog(entry: SyncLogEntry): Promise<void> {
    this.memoryLogs = [entry, ...this.memoryLogs.slice(0, 49)]
    try {
      await supabase.from('siigo_sync_logs').insert({
        id:                  entry.id,
        started_at:          entry.started_at,
        finished_at:         entry.finished_at,
        status:              entry.status,
        start_date:          entry.start_date,
        end_date:            entry.end_date,
        seller_filter:       entry.seller_filter,
        invoices_count:      entry.invoices_count,
        credit_notes_count:  entry.credit_notes_count,
        lines_count:         entry.lines_count,
        http_requests_count: entry.http_requests_count,
        duration_sec:        entry.duration_sec,
        error_message:       entry.error_message ?? null,
        triggered_by:        entry.triggered_by ?? null,
      })
    } catch {
      // Fallback en Redis
      try {
        await redis.set(REDIS_FALLBACK_LOGS_KEY, JSON.stringify(this.memoryLogs))
      } catch {
        // Ignore
      }
    }
  }

  static async getSyncLogs(): Promise<{ isSyncRunning: boolean; logs: SyncLogEntry[] }> {
    const { data, error } = await supabase
      .from('siigo_sync_logs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(20)

    if (!error && Array.isArray(data) && data.length > 0) {
      return { isSyncRunning: this.isSyncRunning, logs: data as SyncLogEntry[] }
    }

    if (this.memoryLogs.length === 0) {
      try {
        const raw = await redis.get(REDIS_FALLBACK_LOGS_KEY)
        if (raw) this.memoryLogs = JSON.parse(raw)
      } catch {
        // Ignore
      }
    }

    return { isSyncRunning: this.isSyncRunning, logs: this.memoryLogs }
  }

  /**
   * Determina el alcance según el rol: los clientes solo ven su empresa (por company_id,
   * sin coincidencias aproximadas de NIT); los internos pueden filtrar por empresa.
   */
  static async resolveScope(query: ListSiigoSalesQuery, user: AuthUser): Promise<SalesScope> {
    const isInternal = INTERNAL_ROLES.includes(user.role)

    if (!isInternal && !user.companyId) {
      return { isInternal, companyId: null, clientCompany: null, denied: true }
    }

    const companyId = isInternal ? (query.companyId ?? null) : user.companyId
    let clientCompany: ClientCompany | null = null

    if (companyId) {
      const { data, error } = await supabase
        .from('companies')
        .select('id, name, nit')
        .eq('id', companyId)
        .maybeSingle()
      if (error) throw new Error(`No se pudo consultar la empresa: ${error.message}`)
      clientCompany = data ? { id: data.id, name: data.name ?? '', nit: data.nit ?? null } : null
    }

    return { isInternal, companyId, clientCompany, denied: false }
  }

  private static filterArgs(scope: SalesScope, query: ListSiigoSalesQuery): SalesFilterArgs {
    return {
      p_company_id:   scope.companyId,
      p_start:        query.startDate || null,
      p_end:          query.endDate || null,
      p_period:       query.period || null,
      p_doc_type:     query.docType || null,
      p_product_code: query.productCode || null,
      p_nit:          (query.customerNit && normalizeNit(query.customerNit)) || null,
      p_search:       query.search?.trim() || null,
    }
  }

  /** Página de líneas filtradas en SQL */
  private static async fetchLinesPage(
    args: SalesFilterArgs,
    from: number,
    to: number,
    ascending: boolean,
    withCount = false,
  ): Promise<{ rows: SiigoSalesLineInput[]; count: number | null }> {
    const { data, error, count } = await supabase
      .rpc('siigo_sales_lines_filtered', args, withCount ? { count: 'exact' } : undefined)
      .order('doc_date', { ascending })
      .order('comprobante', { ascending })
      .order('line_index', { ascending: true })
      .range(from, to)

    if (error) {
      if (isRangeNotSatisfiable(error)) return { rows: [], count: count ?? null }
      throw new Error(`No se pudieron consultar las líneas de Siigo: ${error.message}`)
    }
    return { rows: ((data ?? []) as any[]).map(r => this.normalizeRow(r)), count: count ?? null }
  }

  /** Consulta paginada con KPIs, desglose mensual y por producto (para vista de consulta y dashboards) */
  static async listSales(query: ListSiigoSalesQuery, user: AuthUser) {
    const scope = await this.resolveScope(query, user)
    const page = query.page || 1
    const limit = query.limit || 50
    const { logs, isSyncRunning } = await this.getSyncLogs()

    let rows: SiigoSalesLineInput[] = []
    let total = 0
    let report = EMPTY_REPORT

    if (!scope.denied) {
      const args = this.filterArgs(scope, query)
      const from = (page - 1) * limit

      const [pageResult, reportResult] = await Promise.all([
        this.fetchLinesPage(args, from, from + limit - 1, false, true),
        this.fetchReport(args, scope.isInternal),
      ])

      report = reportResult
      rows = pageResult.rows
      total = pageResult.count ?? Number(report.summary.totalLineas)
    }

    return {
      data:  rows,
      total,
      page,
      limit,
      clientCompany: scope.clientCompany,
      isSyncRunning,
      lastSync: logs[0] ?? null,
      summary:    this.toSummary(report.summary),
      monthly:    report.monthly,
      byProduct:  report.byProduct,
      byCustomer: report.byCustomer,
      catalogs:   report.catalogs,
    }
  }

  /** Solo agregados (sin líneas): alimenta la vista de gráficas de facturación */
  static async getReport(query: ListSiigoSalesQuery, user: AuthUser) {
    const scope = await this.resolveScope(query, user)
    const report = scope.denied
      ? EMPTY_REPORT
      : await this.fetchReport(this.filterArgs(scope, query), scope.isInternal)
    const { logs } = await this.getSyncLogs()

    return {
      clientCompany: scope.clientCompany,
      lastSync:      logs[0] ?? null,
      summary:       this.toSummary(report.summary),
      monthly:       report.monthly,
      byProduct:     report.byProduct,
      byCustomer:    report.byCustomer,
    }
  }

  private static async fetchReport(args: SalesFilterArgs, includeCustomers: boolean): Promise<SalesReport> {
    const { data, error } = await supabase.rpc('siigo_sales_report', { ...args, p_include_customers: includeCustomers })
    if (error) throw new Error(`No se pudo calcular el resumen de Siigo: ${error.message}`)
    return data as SalesReport
  }

  private static toSummary(s: SalesSummary) {
    return {
      totalFacturas:     Number(s.totalFacturas),
      totalNotasCredito: Number(s.totalNotasCredito),
      totalDocumentos:   Number(s.totalFacturas) + Number(s.totalNotasCredito),
      totalLineas:       Number(s.totalLineas),
      totalBruto:        Number(s.totalBruto),
      totalDescuento:    Number(s.totalDescuento),
      totalSubtotal:     Number(s.totalSubtotal),
      totalImpuestos:    Number(s.totalImpuestos),
      totalRetenciones:  Number(s.totalRetenciones),
      totalNeto:         Number(s.totalNeto),
    }
  }

  /** Genera el archivo Excel (.xlsx) filtrado para el usuario o cliente actual */
  static async exportExcel(query: ListSiigoSalesQuery, user: AuthUser): Promise<{ buffer: Buffer; filename: string }> {
    const scope = await this.resolveScope(query, user)
    const clientCompany = scope.clientCompany

    // Orden cronológico y por comprobante igual que en consultas sigo
    const sorted: SiigoSalesLineInput[] = []
    if (!scope.denied) {
      const args = this.filterArgs(scope, query)
      for (let from = 0; ; from += FETCH_PAGE_SIZE) {
        const { rows } = await this.fetchLinesPage(args, from, from + FETCH_PAGE_SIZE - 1, true)
        sorted.push(...rows)
        if (rows.length < FETCH_PAGE_SIZE) break
      }
    }

    const excelRows = sorted.map(l => lineToExcelRow(l))
    const facturasCount = new Set(sorted.filter(x => x.doc_type === 'FACTURA').map(x => x.comprobante)).size
    const ncCount = new Set(sorted.filter(x => x.doc_type === 'NOTA_CREDITO').map(x => x.comprobante)).size
    const stats = siigoCatalogCache.getStats()

    const logInfo: Record<string, string | number> = {
      'Fecha generación':         new Date().toLocaleString('es-CO'),
      'Empresa / Alcance':        clientCompany ? `${clientCompany.name} (${clientCompany.nit ?? ''})` : 'Todos los clientes filtrados',
      'Periodo filtrado':         `${query.startDate || 'Inicio'} a ${query.endDate || 'Hoy'}`,
      'Facturas incluidas':       facturasCount,
      'Notas crédito incluidas':  ncCount,
      'Líneas de producto':       excelRows.length,
      'Clientes en caché':        stats.customersCount,
      'Productos en caché':       stats.productsCount,
    }

    const buffer = await buildSiigoExcelBuffer(excelRows, logInfo)
    const slug = clientCompany?.name
      ? clientCompany.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      : 'general'
    const filename = `informe_ventas_siigo_${slug}_${formatDate(new Date())}.xlsx`

    return { buffer, filename }
  }
}
