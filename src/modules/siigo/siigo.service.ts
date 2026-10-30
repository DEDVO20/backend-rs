import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import type { AuthUser } from '../../middleware/auth.js'
import { normalizeNit } from '../participations/participations.domain.js'
import { formatDate, incrementalStartDate, matchCompanyByNit, normalizeDateText, sleep } from './siigo.helpers.js'
import { SIIGO_CONFIG } from './siigo.config.js'
import {
  buildVentaLinesPorProducto,
  getComprobanteSiigo,
  lineToExcelRow,
  type SiigoDocType,
  type SiigoSalesLineInput,
} from './siigo.calculator.js'
import { SiigoConnections, type SiigoConnectionRow } from './siigo.connections.js'
import { buildSiigoExcelBuffer } from './siigo.exporter.js'
import type { ListSiigoSalesQuery, SyncSiigoBody } from './siigo.schema.js'

const INTERNAL_ROLES = ['admin', 'rs_admin', 'rs_staff', 'contador']
const FETCH_PAGE_SIZE = 1000       // max-rows por defecto de PostgREST
const REPLACE_DOCS_PER_CALL = 100  // documentos por llamada a siigo_replace_doc_lines

export interface SyncLogEntry {
  id: string
  connection_id: string
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

/** Libros consultados: la cuenta de Siigo (conexión) dueña de los datos */
export type SiigoBooks = { connectionId: string; label: string; companyId: string | null; isPlatform: boolean }

/**
 * Alcance de una consulta:
 * - books: de quién son los libros. Clientes → su propia empresa; internos → la elegida (Finto por defecto).
 * - companyId: tercero dentro de esos libros (solo internos; p. ej. un cliente en los libros de Finto).
 * - denied: cliente sin empresa o sin conexión de Siigo activa (notConnected).
 */
export type SalesScope = {
  isInternal: boolean
  books: SiigoBooks | null
  companyId: string | null
  clientCompany: ClientCompany | null
  denied: boolean
  notConnected: boolean
}

/** Parámetros de public.siigo_sales_lines_filtered */
type SalesFilterArgs = {
  p_connection:   string
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

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

export function booksOf(row: SiigoConnectionRow): SiigoBooks {
  return { connectionId: row.id, label: row.label, companyId: row.company_id, isPlatform: row.is_platform }
}

export class SiigoService {
  /** Conexiones con una sincronización de facturación en curso */
  private static runningSyncs = new Set<string>()

  static isRunning(connectionId: string): boolean {
    return this.runningSyncs.has(connectionId)
  }

  /** Conexión a sincronizar: la indicada o, por defecto, la de Finto */
  static async connectionFor(connectionId?: string | null): Promise<SiigoConnectionRow> {
    if (!connectionId) return SiigoConnections.platform()
    const row = await SiigoConnections.byId(connectionId)
    if (!row) throw httpError('Conexión de Siigo no encontrada', 404)
    return row
  }

  /** Listado de empresas para cruzar NIT de Siigo -> company_id (tercero) */
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
   * Reemplaza las líneas de los documentos procesados de una conexión (borra + inserta en
   * una transacción por lote). Elimina líneas huérfanas y las de documentos anulados.
   */
  static async replaceDocLines(connectionId: string, docs: ProcessedDoc[]): Promise<number> {
    let inserted = 0
    for (let i = 0; i < docs.length; i += REPLACE_DOCS_PER_CALL) {
      const chunk = docs.slice(i, i + REPLACE_DOCS_PER_CALL)
      const { data, error } = await supabase.rpc('siigo_replace_doc_lines', {
        p_connection:   connectionId,
        p_doc_ids:      chunk.map(d => d.id),
        p_comprobantes: chunk.map(d => d.comprobante).filter(Boolean),
        p_lines:        chunk.flatMap(d => d.lines),
      })
      if (error) throw new Error(`No se pudieron guardar las líneas de Siigo: ${error.message}`)
      inserted += Number(data ?? 0)
    }
    return inserted
  }

  /** Vincula al tercero las líneas sin company_id (p. ej. empresas creadas después) */
  static async relinkCompanies(connectionId: string, companies: CompanyRef[]): Promise<number> {
    const { data, error } = await supabase.rpc('siigo_unlinked_nits', { p_connection: connectionId })
    if (error) throw new Error(`No se pudieron consultar NIT sin vincular: ${error.message}`)

    let relinked = 0
    for (const nit of (data ?? []) as string[]) {
      const company = matchCompanyByNit(companies, nit)
      if (!company) continue
      const { error: updError } = await supabase
        .from('siigo_sales_lines')
        .update({ company_id: company.id })
        .eq('connection_id', connectionId)
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

  /** Sincroniza facturas y notas crédito de UNA cuenta de Siigo */
  static async syncFromSiigo(input: SyncSiigoBody, triggeredBy?: string) {
    const conn = await this.connectionFor(input.connectionId)
    if (this.runningSyncs.has(conn.id)) {
      throw httpError(`Ya hay una sincronización de facturación en curso para ${conn.label}. Espera a que termine.`, 409)
    }
    const api = SiigoConnections.client(conn)
    const settings = SiigoConnections.settings(conn)

    const now = new Date()
    const sellerFilter = input.sellerFilter !== undefined ? input.sellerFilter : settings.sellerFilter
    let startDate: string
    let endDate = input.endDate ? normalizeDateText(input.endDate) : formatDate(now)

    if (input.mode === 'incremental') {
      endDate = formatDate(now)
      startDate = incrementalStartDate(
        await this.getLastCompletedEndDate(conn.id, sellerFilter),
        SIIGO_CONFIG.SYNC_OVERLAP_DAYS,
        settings.salesStartYear,
      )
    } else if (input.mode === 'range' && input.startDate) {
      startDate = normalizeDateText(input.startDate)
    } else if (input.mode === 'days') {
      const past = new Date()
      past.setDate(past.getDate() - (input.days || 15))
      startDate = formatDate(past)
    } else {
      const year = input.year || settings.salesStartYear
      startDate = `${year}-01-01`
    }

    const startTime = Date.now()
    this.runningSyncs.add(conn.id)

    try {
      await api.getAccessToken()

      const invoices = await api.listDocumentIds(SIIGO_CONFIG.INVOICES_URL, startDate, endDate, 'Facturas', sellerFilter)
      const creditNotes = await api.listDocumentIds(SIIGO_CONFIG.CREDIT_NOTES_URL, startDate, endDate, 'Notas Crédito', sellerFilter)

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
            const docLines = await buildVentaLinesPorProducto(doc, source.docType, source.sign, api, startDate, endDate, sellerFilter)
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
            logger.warn({ id, connection: conn.label, err: err.message }, `No se pudo procesar ${source.label} Siigo`)
          }
          await sleep(SIIGO_CONFIG.SLEEP_BETWEEN_DOCS_MS)
        }
      }

      // Documentos anulados/borrador: se eliminan sus líneas
      for (const doc of [...invoices.excluded, ...creditNotes.excluded]) {
        processed.push({ id: doc.id, comprobante: doc.comprobante, lines: [] })
      }

      await api.catalog.flushToDatabase()
      const linesCount = await this.replaceDocLines(conn.id, processed)
      await this.relinkCompanies(conn.id, companies)

      const logEntry: SyncLogEntry = {
        id:                  crypto.randomUUID(),
        connection_id:       conn.id,
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
        duration_sec:        Math.round((Date.now() - startTime) / 1000),
        triggered_by:        triggeredBy ?? null,
      }
      await this.saveSyncLog(logEntry)
      return logEntry
    } catch (err: any) {
      await this.saveSyncLog({
        id:                  crypto.randomUUID(),
        connection_id:       conn.id,
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
        duration_sec:        Math.round((Date.now() - startTime) / 1000),
        error_message:       err.message,
        triggered_by:        triggeredBy ?? null,
      })
      throw err
    } finally {
      this.runningSyncs.delete(conn.id)
    }
  }

  /** Última fecha cubierta por una sync completada de la conexión con el mismo filtro de vendedor */
  private static async getLastCompletedEndDate(connectionId: string, sellerFilter: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('siigo_sync_logs')
      .select('end_date')
      .eq('connection_id', connectionId)
      .eq('status', 'completed')
      .eq('seller_filter', sellerFilter || 'Todos')
      .order('end_date', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw new Error(`No se pudo consultar la última sync de Siigo: ${error.message}`)
    return data?.end_date ? String(data.end_date) : null
  }

  private static async saveSyncLog(entry: SyncLogEntry): Promise<void> {
    const { error } = await supabase.from('siigo_sync_logs').insert(entry)
    if (error) logger.warn({ err: error.message }, 'No se pudo guardar el log de sync de facturación Siigo')
  }

  static async getSyncLogs(connectionId: string): Promise<{ isSyncRunning: boolean; logs: SyncLogEntry[] }> {
    const { data, error } = await supabase
      .from('siigo_sync_logs')
      .select('*')
      .eq('connection_id', connectionId)
      .order('started_at', { ascending: false })
      .limit(20)
    if (error) throw new Error(`No se pudieron consultar los logs de Siigo: ${error.message}`)
    return { isSyncRunning: this.isRunning(connectionId), logs: (data ?? []) as SyncLogEntry[] }
  }

  /**
   * Determina de quién son los libros y el tercero:
   * - Cliente: libros de su propia empresa (sin conexión → denied/notConnected). Nunca ve los de Finto.
   * - Interno: libros de la conexión indicada (Finto por defecto) y, opcionalmente, un tercero.
   */
  static async resolveScope(query: { connectionId?: string; companyId?: string }, user: AuthUser): Promise<SalesScope> {
    const isInternal = INTERNAL_ROLES.includes(user.role)

    if (!isInternal) {
      if (!user.companyId) {
        return { isInternal, books: null, companyId: null, clientCompany: null, denied: true, notConnected: true }
      }
      const [conn, company] = await Promise.all([
        SiigoConnections.byCompany(user.companyId),
        this.companyInfo(user.companyId),
      ])
      if (!conn || !conn.active) {
        return { isInternal, books: null, companyId: null, clientCompany: company, denied: true, notConnected: true }
      }
      return { isInternal, books: booksOf(conn), companyId: null, clientCompany: company, denied: false, notConnected: false }
    }

    const conn = await this.connectionFor(query.connectionId)
    const companyId = query.companyId ?? null
    const clientCompany = companyId ? await this.companyInfo(companyId) : null
    return { isInternal, books: booksOf(conn), companyId, clientCompany, denied: false, notConnected: false }
  }

  private static async companyInfo(companyId: string): Promise<ClientCompany | null> {
    const { data, error } = await supabase.from('companies').select('id, name, nit').eq('id', companyId).maybeSingle()
    if (error) throw new Error(`No se pudo consultar la empresa: ${error.message}`)
    return data ? { id: data.id, name: data.name ?? '', nit: data.nit ?? null } : null
  }

  private static filterArgs(scope: SalesScope, query: ListSiigoSalesQuery): SalesFilterArgs {
    return {
      p_connection:   scope.books!.connectionId,
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
    const { logs, isSyncRunning } = scope.books
      ? await this.getSyncLogs(scope.books.connectionId)
      : { logs: [], isSyncRunning: false }

    let rows: SiigoSalesLineInput[] = []
    let total = 0
    let report = EMPTY_REPORT

    if (!scope.denied) {
      const args = this.filterArgs(scope, query)
      const from = (page - 1) * limit
      const [pageResult, reportResult] = await Promise.all([
        this.fetchLinesPage(args, from, from + limit - 1, false, true),
        this.fetchReport(args),
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
      books: scope.books,
      notConnected: scope.notConnected,
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
    const report = scope.denied ? EMPTY_REPORT : await this.fetchReport(this.filterArgs(scope, query))
    const { logs } = scope.books ? await this.getSyncLogs(scope.books.connectionId) : { logs: [] }

    return {
      books:         scope.books,
      notConnected:  scope.notConnected,
      clientCompany: scope.clientCompany,
      lastSync:      logs[0] ?? null,
      summary:       this.toSummary(report.summary),
      monthly:       report.monthly,
      byProduct:     report.byProduct,
      byCustomer:    report.byCustomer,
    }
  }

  /** El dueño de los libros siempre ve el desglose por cliente de SUS libros */
  private static async fetchReport(args: SalesFilterArgs): Promise<SalesReport> {
    const { data, error } = await supabase.rpc('siigo_sales_report', { ...args, p_include_customers: true })
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

    const logInfo: Record<string, string | number> = {
      'Fecha generación':         new Date().toLocaleString('es-CO'),
      'Libros (cuenta Siigo)':    scope.books?.label ?? '—',
      'Tercero filtrado':         scope.isInternal && clientCompany ? `${clientCompany.name} (${clientCompany.nit ?? ''})` : 'Todos',
      'Periodo filtrado':         `${query.startDate || 'Inicio'} a ${query.endDate || 'Hoy'}`,
      'Facturas incluidas':       facturasCount,
      'Notas crédito incluidas':  ncCount,
      'Líneas de producto':       excelRows.length,
    }

    const buffer = await buildSiigoExcelBuffer(excelRows, logInfo)
    const name = (scope.isInternal ? clientCompany?.name : null) ?? scope.books?.label ?? 'general'
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'general'
    const filename = `informe_ventas_siigo_${slug}_${formatDate(new Date())}.xlsx`

    return { buffer, filename }
  }
}
