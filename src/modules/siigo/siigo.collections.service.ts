import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import type { AuthUser } from '../../middleware/auth.js'
import { normalizeNit } from '../participations/participations.domain.js'
import { SIIGO_CONFIG, validateSiigoConfig } from './siigo.config.js'
import { matchCompanyByNit, round2, sleep } from './siigo.helpers.js'
import { getCodigoProductoFromItem } from './siigo.calculator.js'
import { SiigoApiClient } from './siigo.client.js'
import { siigoCatalogCache } from './siigo.cache.js'
import { SiigoService } from './siigo.service.js'
import {
  TOLERANCIA,
  consecutivosFaltantesRC,
  crearRangosMensuales,
  expandirMovimientosVoucher,
  extractThirdIdentification,
  extractThirdNameFromVoucher,
  fechaVoucher,
  fusionarListaVouchers,
  fusionarRespuestaVoucher,
  listaUnica,
  newResolutionState,
  nombresRCPorCatalogo,
  normalizarFecha,
  obtenerNombreRecibo,
  primeroNoVacio,
  registrarAplicacionesFactura,
  type CollectionInvoiceLookup,
} from './siigo.collections.js'
import type { ListSiigoCollectionsQuery, SyncSiigoCollectionsBody } from './siigo.schema.js'

const SLEEP_BETWEEN_VOUCHERS_MS = 700

type Obj = Record<string, any>

export interface CollectionLine {
  voucher_id: string
  line_index: number
  collection_date: string
  period: string
  receipt: string
  customer_nit: string
  normalized_nit: string
  company_id: string | null
  customer_name: string
  invoice: string
  product_code: string
  product_description: string
  installment: string
  due_date: string | null
  applied_value: number
  movement_class: string
  account: string
  observations: string
}

export interface CollectionSyncLog {
  id: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'completed' | 'failed'
  start_date: string
  end_date: string
  vouchers_count: number
  lines_count: number
  total_applied: number
  http_requests_count: number
  duration_sec: number
  details: Record<string, number | string>
  error_message?: string | null
  triggered_by?: string | null
}

type CollectionFilterArgs = {
  p_company_id: string | null
  p_start:      string | null
  p_end:        string | null
  p_nit:        string | null
  p_search:     string | null
}

type CollectionReport = {
  summary: {
    totalRecaudado: number
    recibos: number
    movimientos: number
    facturas: number
    anticipos: number
    clientes: number
  }
  monthly: unknown[]
  byProduct: unknown[]
  byCustomer: unknown[]
}

const EMPTY_REPORT: CollectionReport = {
  summary: { totalRecaudado: 0, recibos: 0, movimientos: 0, facturas: 0, anticipos: 0, clientes: 0 },
  monthly: [],
  byProduct: [],
  byCustomer: [],
}

/** Fin del mes actual en hora de Colombia (el script consulta hasta fin de mes) */
function endOfCurrentMonthBogota(): string {
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit' })
    .format(new Date())
    .slice(0, 7)
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

/** Consultas de facturas con caché por referencia (totales y productos facturados) */
class InvoiceCache implements CollectionInvoiceLookup {
  private invoices = new Map<string, Obj | null>()
  private products = new Map<string, { codigo: string; descripcion: string }[]>()

  constructor(private api: SiigoApiClient) {}

  private async invoice(ref: string): Promise<Obj | null> {
    const key = ref.trim().toUpperCase()
    if (!this.invoices.has(key)) {
      await sleep(SIIGO_CONFIG.SLEEP_BETWEEN_PRODUCT_LOOKUPS_MS)
      this.invoices.set(key, await this.api.findInvoiceByReference(key))
    }
    return this.invoices.get(key) ?? null
  }

  async getInvoiceTotal(ref: string): Promise<number> {
    const f = await this.invoice(ref)
    return f ? Math.abs(Number(f.total) || 0) : 0
  }

  /** Productos de la factura: solo informativos, nunca alteran el valor aplicado */
  async getInvoiceProducts(ref: string): Promise<{ codigo: string; descripcion: string }[]> {
    const key = ref.trim().toUpperCase()
    const cached = this.products.get(key)
    if (cached) return cached

    const productos: { codigo: string; descripcion: string }[] = []
    try {
      const f = await this.invoice(key)
      const items: Obj[] = f?.items ?? f?.products ?? f?.services ?? f?.details ?? f?.invoice_items ?? []
      for (const it of Array.isArray(items) ? items : []) {
        const codigo = getCodigoProductoFromItem(it)
        let descripcion = await this.api.getProductDescription(it)
        // getProductDescription devuelve el código o 'SIN PRODUCTO' cuando no hay descripción
        if (descripcion === 'SIN PRODUCTO' || descripcion === codigo) descripcion = ''
        if (codigo || descripcion) productos.push({ codigo, descripcion })
      }
    } catch (err: any) {
      logger.debug({ ref: key, err: err.message }, 'No se pudieron leer productos de la factura')
    }
    this.products.set(key, productos)
    return productos
  }
}

export class SiigoCollectionsService {
  private static isSyncRunning = false

  static get running(): boolean {
    return this.isSyncRunning
  }

  /* ─────────────── sincronización ─────────────── */

  /** 1. Listado del periodo mes a mes con tres variantes de consulta, fusionadas sin perder items */
  private static async listPeriod(api: SiigoApiClient, start: string, end: string, details: Obj): Promise<Obj[]> {
    let salida: Obj[] = []

    for (const rango of crearRangosMensuales(start, end)) {
      const consultas: Record<string, string>[] = [
        { date_start: `${rango.inicio}T00:00:00-05:00`, date_end: `${rango.fin}T23:59:59-05:00` },
        { date_start: rango.inicio, date_end: rango.fin },
        { created_start: `${rango.inicio}T00:00:00Z`, created_end: `${rango.fin}T23:59:59Z` },
      ]
      const partes: Obj[] = []
      const errores: string[] = []

      for (const params of consultas) {
        try {
          partes.push(...await api.listVouchers(params))
        } catch (err: any) {
          errores.push(String(err?.message ?? err))
        }
      }

      if (!partes.length && errores.length === consultas.length) {
        throw new Error(`No fue posible consultar recibos entre ${rango.inicio} y ${rango.fin}. ${errores.join(' | ')}`)
      }
      salida = fusionarListaVouchers([...salida, ...partes])
    }

    details['Recibos en listado'] = salida.length
    return salida
  }

  /** Consulta exacta por nombre de cada RC indicado y los fusiona */
  private static async recoverByName(api: SiigoApiClient, docs: Obj[], names: string[], details: Obj, label: string) {
    let salida = docs
    let recuperados = 0
    for (const name of names) {
      try {
        const found = await api.findVouchersByName(name)
        if (!found.length) continue
        for (const v of found) v.__consultadoPorNombre = true
        salida = fusionarListaVouchers([...salida, ...found])
        recuperados++
      } catch (err: any) {
        logger.debug({ name, err: err.message }, `RC no recuperado (${label})`)
      }
    }
    details[label] = recuperados
    return salida
  }

  /** 4. Completa cada voucher con la consulta por nombre y el detalle por UUID, conservando items */
  private static async completeVouchers(api: SiigoApiClient, docs: Obj[]): Promise<Obj[]> {
    const out: Obj[] = []
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]!
      if (!doc?.id) {
        out.push(doc)
        continue
      }
      if (i > 0 && i % 8 === 0) await sleep(SLEEP_BETWEEN_VOUCHERS_MS)

      let combinado: Obj = { ...doc, items: Array.isArray(doc.items) ? doc.items : [] }
      const name = String(doc.name || '').trim()

      if (name && !doc.__consultadoPorNombre) {
        try {
          for (const vn of await api.findVouchersByName(name)) combinado = fusionarRespuestaVoucher(combinado, vn)
        } catch (err: any) {
          logger.debug({ name, err: err.message }, 'Consulta de RC por nombre no disponible')
        }
      }

      try {
        combinado = fusionarRespuestaVoucher(combinado, await api.getVoucher(String(doc.id)))
      } catch (err: any) {
        logger.debug({ name: name || doc.id, err: err.message }, 'Detalle de RC no disponible')
      }

      if (!combinado.payment && doc.payment) combinado.payment = doc.payment
      if (!combinado.income && doc.income) combinado.income = doc.income
      if ((!Array.isArray(combinado.payments) || !combinado.payments.length) && Array.isArray(doc.payments)) {
        combinado.payments = doc.payments
      }
      out.push(combinado)
    }
    return out
  }

  /** Sincroniza el recaudo desde Siigo reprocesando el periodo completo en orden cronológico */
  static async syncFromSiigo(input: SyncSiigoCollectionsBody = {}, triggeredBy?: string): Promise<CollectionSyncLog> {
    if (this.isSyncRunning) {
      throw Object.assign(new Error('Ya hay una sincronización de recaudo en curso. Espera a que termine.'), { statusCode: 409 })
    }
    const configErrors = validateSiigoConfig()
    if (configErrors.length) {
      throw Object.assign(new Error(configErrors.join('. ')), { statusCode: 400 })
    }

    const startDate = input.startDate || SIIGO_CONFIG.COLLECTIONS_START_DATE
    const endDate = input.endDate || endOfCurrentMonthBogota()
    const startTime = Date.now()
    const details: Record<string, number | string> = {}
    this.isSyncRunning = true

    const api = new SiigoApiClient()
    api.maxRequests = SIIGO_CONFIG.COLLECTIONS_MAX_REQUESTS
    const invoices = new InvoiceCache(api)

    try {
      await api.getAccessToken()

      // 1. Listado del periodo
      let vouchers = await this.listPeriod(api, startDate, endDate, details)

      // 2. RC omitidos por el listado, según el próximo consecutivo del catálogo oficial
      try {
        const tipos = await api.getReceiptDocumentTypes()
        details['Tipos RC'] = tipos.length
        vouchers = await this.recoverByName(api, vouchers, nombresRCPorCatalogo(vouchers, tipos), details, 'RC recuperados por consecutivo')
      } catch (err: any) {
        details['Catálogo de tipos RC'] = `no disponible: ${err.message}`
      }

      // 3. Huecos internos entre los RC conocidos
      vouchers = await this.recoverByName(
        api, vouchers, consecutivosFaltantesRC(vouchers, SIIGO_CONFIG.COLLECTIONS_MAX_GAP_QUERIES), details, 'RC recuperados por hueco',
      )

      // 4. Detalle completo de cada recibo
      vouchers = await this.completeVouchers(api, vouchers)

      // 5. Filtro definitivo por fecha y orden cronológico (la resolución de saldos depende del orden)
      vouchers = vouchers
        .filter(v => {
          const f = fechaVoucher(v)
          return !!f && f >= startDate && f <= endDate
        })
        .sort((a, b) => fechaVoucher(a).localeCompare(fechaVoucher(b)) || String(a?.name || '').localeCompare(String(b?.name || '')))

      // 6. Movimientos por recibo
      const companies = await SiigoService.loadCompanies()
      const estado = newResolutionState()
      const lines: CollectionLine[] = []
      let total = 0

      for (const v of vouchers) {
        const voucherId = String(v.id || v.uuid || '').trim()
        const receipt = obtenerNombreRecibo(v)
        const date = fechaVoucher(v)
        const identification = extractThirdIdentification(v)
        let customerName = extractThirdNameFromVoucher(v)
        if (!customerName && identification) customerName = await api.getCustomerName(identification, '')

        const observations = String(primeroNoVacio([v.observations, v.comments, v.description, '']) || '').trim()
        const movimientos = await expandirMovimientosVoucher(v, estado, identification, invoices)
        registrarAplicacionesFactura(estado, identification, movimientos)
        if (!movimientos.length) continue

        const company = matchCompanyByNit(companies, identification)
        let lineIndex = 0

        for (const mov of movimientos) {
          if (!(Number(mov.valor) > TOLERANCIA)) continue

          let productCode = ''
          let productDescription = ''
          if (/^FV-/i.test(mov.documentoBase)) {
            const productos = await invoices.getInvoiceProducts(mov.documentoBase)
            productCode = listaUnica(productos.map(p => p.codigo)).join(' | ')
            productDescription = listaUnica(productos.map(p => p.descripcion)).join(' | ')
          }

          let obs = observations
          if (mov.descripcion || mov.clase !== 'ITEM') {
            const detalle = mov.clase === 'ITEM' ? mov.descripcion : mov.clase + (mov.descripcion ? `: ${mov.descripcion}` : '')
            obs = listaUnica([observations, detalle]).join(' | ')
          }

          lines.push({
            voucher_id:          voucherId,
            line_index:          lineIndex++,
            collection_date:     date,
            period:              date.slice(0, 7),
            receipt,
            customer_nit:        identification,
            normalized_nit:      normalizeNit(identification),
            company_id:          company?.id ?? null,
            customer_name:       customerName || company?.name || '',
            invoice:             mov.documentoBase,
            product_code:        productCode,
            product_description: productDescription,
            installment:         String(mov.quote ?? ''),
            due_date:            normalizarFecha(mov.dueDate) || null,
            applied_value:       round2(mov.valor),
            movement_class:      mov.clase,
            account:             mov.cuenta,
            observations:        obs,
          })
          total = round2(total + mov.valor)
        }
      }

      await siigoCatalogCache.flushToDatabase()
      const { data, error } = await supabase.rpc('siigo_replace_collection_lines', {
        p_start: startDate,
        p_end:   endDate,
        p_lines: lines,
      })
      if (error) throw new Error(`No se pudieron guardar las líneas de recaudo: ${error.message}`)

      details['Movimientos sin due resueltos'] = lines.filter(l => l.movement_class === 'ITEM' && !/^FV-/i.test(l.invoice)).length
      details['Anticipos / otros ingresos'] = lines.filter(l => l.movement_class === 'ANTICIPO' || l.movement_class === 'OTRO_INGRESO').length
      details['Pagos sin items'] = lines.filter(l => l.movement_class === 'PAGO_SIN_ITEMS').length

      const log: CollectionSyncLog = {
        id:                  crypto.randomUUID(),
        started_at:          new Date(startTime).toISOString(),
        finished_at:         new Date().toISOString(),
        status:              'completed',
        start_date:          startDate,
        end_date:            endDate,
        vouchers_count:      vouchers.length,
        lines_count:         Number(data ?? lines.length),
        total_applied:       total,
        http_requests_count: api.urlFetchCount,
        duration_sec:        Math.round((Date.now() - startTime) / 1000),
        details,
        triggered_by:        triggeredBy ?? null,
      }
      await this.saveSyncLog(log)
      return log
    } catch (err: any) {
      await this.saveSyncLog({
        id:                  crypto.randomUUID(),
        started_at:          new Date(startTime).toISOString(),
        finished_at:         new Date().toISOString(),
        status:              'failed',
        start_date:          startDate,
        end_date:            endDate,
        vouchers_count:      0,
        lines_count:         0,
        total_applied:       0,
        http_requests_count: api.urlFetchCount,
        duration_sec:        Math.round((Date.now() - startTime) / 1000),
        details,
        error_message:       err.message,
        triggered_by:        triggeredBy ?? null,
      })
      throw err
    } finally {
      this.isSyncRunning = false
    }
  }

  private static async saveSyncLog(log: CollectionSyncLog) {
    const { error } = await supabase.from('siigo_collection_sync_logs').insert(log)
    if (error) logger.warn({ err: error.message }, 'No se pudo guardar el log de sync de recaudo')
  }

  static async getSyncLogs(): Promise<{ isSyncRunning: boolean; logs: CollectionSyncLog[] }> {
    const { data, error } = await supabase
      .from('siigo_collection_sync_logs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(20)
    if (error) throw new Error(`No se pudieron consultar los logs de recaudo: ${error.message}`)
    return { isSyncRunning: this.isSyncRunning, logs: (data ?? []) as CollectionSyncLog[] }
  }

  /* ─────────────── consultas ─────────────── */

  private static filterArgs(companyId: string | null, query: ListSiigoCollectionsQuery): CollectionFilterArgs {
    return {
      p_company_id: companyId,
      p_start:      query.startDate || null,
      p_end:        query.endDate || null,
      p_nit:        (query.customerNit && normalizeNit(query.customerNit)) || null,
      p_search:     query.search?.trim() || null,
    }
  }

  private static async fetchReport(args: CollectionFilterArgs, includeCustomers: boolean): Promise<CollectionReport> {
    const { data, error } = await supabase.rpc('siigo_collection_report', { ...args, p_include_customers: includeCustomers })
    if (error) throw new Error(`No se pudo calcular el resumen de recaudo: ${error.message}`)
    return data as CollectionReport
  }

  private static async fetchPage(args: CollectionFilterArgs, from: number, to: number, withCount = false) {
    const { data, error, count } = await supabase
      .rpc('siigo_collection_lines_filtered', args, withCount ? { count: 'exact' } : undefined)
      .order('collection_date', { ascending: false })
      .order('receipt', { ascending: false })
      .order('line_index', { ascending: true })
      .range(from, to)

    if (error) {
      if (error.code === 'PGRST103') return { rows: [] as CollectionLine[], count: count ?? null }
      throw new Error(`No se pudieron consultar las líneas de recaudo: ${error.message}`)
    }
    return {
      rows: ((data ?? []) as any[]).map(r => ({ ...r, applied_value: Number(r.applied_value ?? 0) })) as CollectionLine[],
      count: count ?? null,
    }
  }

  private static toSummary(s: CollectionReport['summary']) {
    return {
      totalRecaudado: Number(s.totalRecaudado),
      recibos:        Number(s.recibos),
      movimientos:    Number(s.movimientos),
      facturas:       Number(s.facturas),
      anticipos:      Number(s.anticipos),
      clientes:       Number(s.clientes),
    }
  }

  /** Detalle paginado de recaudo con resumen (pestaña de recaudo del admin) */
  static async listCollections(query: ListSiigoCollectionsQuery, user: AuthUser) {
    const scope = await SiigoService.resolveScope(query, user)
    const page = query.page || 1
    const limit = query.limit || 50
    const { logs, isSyncRunning } = await this.getSyncLogs()

    let rows: CollectionLine[] = []
    let total = 0
    let report = EMPTY_REPORT

    if (!scope.denied) {
      const args = this.filterArgs(scope.companyId, query)
      const from = (page - 1) * limit
      const [pageResult, reportResult] = await Promise.all([
        this.fetchPage(args, from, from + limit - 1, true),
        this.fetchReport(args, scope.isInternal),
      ])
      rows = pageResult.rows
      report = reportResult
      total = pageResult.count ?? Number(report.summary.movimientos)
    }

    return {
      data: rows,
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
    }
  }

  /** Solo agregados de recaudo (pestaña de gráficas) */
  static async getReport(query: ListSiigoCollectionsQuery, user: AuthUser) {
    const scope = await SiigoService.resolveScope(query, user)
    const report = scope.denied ? EMPTY_REPORT : await this.fetchReport(this.filterArgs(scope.companyId, query), scope.isInternal)
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
}
