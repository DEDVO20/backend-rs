import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import { SIIGO_CONFIG } from './siigo.config.js'
import { buildQueryString, dbError, matchCompanyByNit, sleep } from './siigo.helpers.js'
import type { SiigoApiClient } from './siigo.client.js'
import { SiigoConnections } from './siigo.connections.js'
import { SiigoService } from './siigo.service.js'
import { convertirFilas, localizarEncabezados, readWorkbook } from './siigo.trialBalance.js'
import { downloadXlsx, fileUrlOf, todayBogota } from './siigo.trialBalance.service.js'
import {
  ACCOUNTS_CARTERA,
  buildReceivables,
  customerControls,
  findControl,
  invoicesWithBalance,
  round2,
  sellerNameOf,
  toReceivableInvoice,
  type CustomerControl,
} from './siigo.receivables.js'
import type { AuthUser } from '../../middleware/auth.js'
import type { ListReceivablesQuery, ReceivablesReportQuery, SyncReceivablesBody } from './siigo.schema.js'

const REPORT_URL = `${SIIGO_CONFIG.SIIGO_BASE_URL}/v1/test-balance-report-by-thirdparty`
const USERS_URL = `${SIIGO_CONFIG.SIIGO_BASE_URL}/v1/users`

type Obj = Record<string, any>

export interface ReceivablesSyncLog {
  id: string
  connection_id: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'completed' | 'failed'
  cut_date: string
  invoices_scanned: number
  invoices_count: number
  customers_count: number
  total_balance: number
  http_requests_count: number
  duration_sec: number
  details: Record<string, string | number>
  error_message?: string | null
  triggered_by?: string | null
}

function resultsOf(resp: any): Obj[] {
  if (Array.isArray(resp)) return resp
  const list = resp?.results || resp?.data || resp?.items
  return Array.isArray(list) ? list : []
}

export class SiigoReceivablesService {
  /** Conexiones con una sincronización de cartera en curso */
  private static runningSyncs = new Set<string>()

  static isRunning(connectionId: string): boolean {
    return this.runningSyncs.has(connectionId)
  }

  /** Listado paginado completo de un recurso de Siigo */
  private static async paged(api: SiigoApiClient, url: string, params: Record<string, string> = {}): Promise<Obj[]> {
    const out: Obj[] = []
    for (let page = 1; page <= SIIGO_CONFIG.RECEIVABLES_MAX_PAGES; page++) {
      const resp = await api.fetchWithRetry(url + buildQueryString({ ...params, page, page_size: SIIGO_CONFIG.PAGE_SIZE }))
      const rows = resultsOf(resp)
      if (!rows.length) break
      out.push(...rows)

      const total = Number(resp?.pagination?.total_results || 0)
      if (total > 0 && page * SIIGO_CONFIG.PAGE_SIZE >= total) break
      if (rows.length < SIIGO_CONFIG.PAGE_SIZE) break
      await sleep(SIIGO_CONFIG.SLEEP_BETWEEN_DOCS_MS)
    }
    return out
  }

  /**
   * Saldo contable de cartera por cliente: UN balance de prueba por tercero de enero a la fecha
   * (todas las cuentas y terceros), del que se toman 130505 y 13051001.
   */
  private static async loadControls(api: SiigoApiClient, cutDate: string, details: Obj): Promise<Map<string, CustomerControl>> {
    const year = Number(cutDate.slice(0, 4))
    const month = Number(cutDate.slice(5, 7))
    const resp = await api.fetchWithRetry(REPORT_URL, {
      method: 'POST',
      body: JSON.stringify({ year, month_start: 1, month_end: month, includes_tax_difference: false }),
    })
    const reporte = localizarEncabezados(readWorkbook(await downloadXlsx(fileUrlOf(resp))))
    if (!reporte) throw new Error('El balance de prueba de Siigo no trae las columnas contables esperadas.')

    const { lines } = convertirFilas(reporte, year, month, cutDate)
    const controls = customerControls(lines)
    details['Terceros con saldo en 130505 / 13051001'] = controls.size
    if (!controls.size) {
      throw new Error(`El balance de prueba no trae saldos por tercero en las cuentas ${ACCOUNTS_CARTERA.join(' ni ')}; se conserva la cartera anterior.`)
    }
    return controls
  }

  /** Vendedores (usuarios de Siigo) por id; si falla, la cartera sigue sin nombres de vendedor */
  private static async loadSellers(api: SiigoApiClient, details: Obj): Promise<Map<string, string>> {
    try {
      const users = await this.paged(api, USERS_URL)
      return new Map(users.filter(u => u.id !== undefined && u.id !== null).map(u => [String(u.id), sellerNameOf(u)]))
    } catch (err: any) {
      details['Vendedores'] = `No se pudieron consultar: ${err.message}`.slice(0, 300)
      return new Map()
    }
  }

  /**
   * Calcula la cartera a hoy (hora Colombia) y reemplaza la foto de la conexión.
   * Si algo falla antes de guardar, se conserva la cartera anterior.
   */
  static async syncFromSiigo(input: SyncReceivablesBody = {}, triggeredBy?: string): Promise<ReceivablesSyncLog> {
    const conn = await SiigoService.connectionFor(input.connectionId)
    if (this.runningSyncs.has(conn.id)) {
      throw Object.assign(new Error(`Ya hay una sincronización de cartera en curso para ${conn.label}.`), { statusCode: 409 })
    }
    const api = SiigoConnections.client(conn)
    const cutDate = todayBogota()
    const startTime = Date.now()
    const details: Record<string, string | number> = { 'Fecha de corte': cutDate, 'Cuentas de control': ACCOUNTS_CARTERA.join(' + ') }
    let scanned = 0
    this.runningSyncs.add(conn.id)

    const finish = async (partial: Partial<ReceivablesSyncLog>): Promise<ReceivablesSyncLog> => {
      const log: ReceivablesSyncLog = {
        id:                  crypto.randomUUID(),
        connection_id:       conn.id,
        started_at:          new Date(startTime).toISOString(),
        finished_at:         new Date().toISOString(),
        status:              'completed',
        cut_date:            cutDate,
        invoices_scanned:    scanned,
        invoices_count:      0,
        customers_count:     0,
        total_balance:       0,
        http_requests_count: api.urlFetchCount,
        duration_sec:        Math.round((Date.now() - startTime) / 1000),
        details,
        error_message:       null,
        triggered_by:        triggeredBy ?? null,
        ...partial,
      }
      await this.saveSyncLog(log)
      return log
    }

    try {
      await api.getAccessToken()

      const raw = await this.paged(api, SIIGO_CONFIG.INVOICES_URL, { date_end: cutDate })
      scanned = raw.length
      details['Facturas consultadas'] = scanned
      if (!scanned) throw new Error('Siigo no devolvió facturas; se conserva la cartera anterior.')

      const invoices = raw.map(toReceivableInvoice)
      details['Facturas con saldo (API)'] = invoicesWithBalance(invoices, cutDate).length

      const [controls, sellers, companies] = await Promise.all([
        this.loadControls(api, cutDate, details),
        this.loadSellers(api, details),
        SiigoService.loadCompanies(),
      ])

      const lines = buildReceivables(invoices, controls, cutDate)

      // Nombre del cliente: el que trae la factura, el del balance de prueba o el catálogo de Siigo
      const byId = new Map(invoices.map(i => [i.invoice_id, i]))
      const names = new Map<string, string>()
      const rows: Obj[] = []
      for (const l of lines) {
        const inv = byId.get(l.invoice_id)!
        const key = `${l.identification}|${l.branch}`
        let name = names.get(key) ?? inv.customer_name_inline
        if (!name) {
          name = findControl(controls, l.identification, l.branch)?.name
            || await api.getCustomerName(inv.customer_id || l.identification, String(l.branch))
            || l.identification
        }
        names.set(key, name)

        rows.push({
          ...l,
          customer_name: name,
          seller_name:   l.seller_id ? sellers.get(l.seller_id) ?? '' : '',
          company_id:    matchCompanyByNit(companies, l.identification)?.id ?? null,
        })
      }

      const reduction = round2(lines.reduce((s, l) => s + l.control_reduction, 0))
      details['Reducción por control contable'] = reduction
      if (!rows.length) throw new Error('Ninguna factura quedó con saldo tras el control contable; se conserva la cartera anterior.')

      const { error } = await supabase.rpc('siigo_replace_receivables', {
        p_connection: conn.id,
        p_cut_date:   cutDate,
        p_lines:      rows,
      })
      if (error) throw dbError(`No se pudo guardar la cartera: ${error.message}`, error)

      return await finish({
        invoices_count:  rows.length,
        customers_count: new Set(rows.map(r => r.normalized_nit || r.identification)).size,
        total_balance:   round2(rows.reduce((s, r) => s + Number(r.balance), 0)),
      })
    } catch (err: any) {
      logger.warn({ connection: conn.label, err: err.message }, 'Cartera Siigo no sincronizada')
      await finish({ status: 'failed', error_message: String(err.message).slice(0, 2000) })
      throw err
    } finally {
      this.runningSyncs.delete(conn.id)
    }
  }

  private static async saveSyncLog(log: ReceivablesSyncLog) {
    const { error } = await supabase.from('siigo_receivable_sync_logs').insert(log)
    if (error) logger.warn({ err: error.message }, 'No se pudo guardar el log de sync de cartera Siigo')
  }

  static async getSyncLogs(connectionId: string): Promise<{ isSyncRunning: boolean; logs: ReceivablesSyncLog[] }> {
    const { data, error } = await supabase
      .from('siigo_receivable_sync_logs')
      .select('*')
      .eq('connection_id', connectionId)
      .order('started_at', { ascending: false })
      .limit(20)
    if (error) throw dbError(`No se pudieron consultar los logs de cartera: ${error.message}`, error)
    return { isSyncRunning: this.isRunning(connectionId), logs: (data ?? []) as ReceivablesSyncLog[] }
  }

  /** Detalle paginado de la cartera de los libros consultados (más vencidas primero) */
  static async list(query: ListReceivablesQuery, user: AuthUser) {
    const scope = await SiigoService.resolveScope(query, user)
    const { logs, isSyncRunning } = scope.books ? await this.getSyncLogs(scope.books.connectionId) : { logs: [], isSyncRunning: false }
    const base = {
      books:        scope.books,
      notConnected: scope.notConnected,
      isSyncRunning,
      lastSync:     logs[0] ?? null,
      lastSuccess:  logs.find(l => l.status === 'completed') ?? null,
      page:         query.page,
      limit:        query.limit,
    }
    if (scope.denied || !scope.books) return { ...base, data: [], total: 0 }

    let q = supabase
      .from('siigo_receivable_lines')
      .select('*', { count: 'exact' })
      .eq('connection_id', scope.books.connectionId)
    if (scope.companyId) q = q.eq('company_id', scope.companyId)
    if (query.bucket) q = q.eq('aging_bucket', query.bucket)

    // Caracteres que rompen el filtro or() de PostgREST
    const search = query.search?.replace(/[,()*%\\]/g, ' ').trim()
    if (search) {
      const like = `%${search}%`
      q = q.or(`customer_name.ilike.${like},identification.ilike.${like},invoice_name.ilike.${like},seller_name.ilike.${like}`)
    }

    const from = (query.page - 1) * query.limit
    const { data, count, error } = await q
      .order('days_overdue', { ascending: false, nullsFirst: false })
      .order('balance', { ascending: false })
      .range(from, from + query.limit - 1)
    if (error && error.code !== 'PGRST103') throw dbError(`No se pudo consultar la cartera: ${error.message}`, error)

    const num = (v: unknown) => Number(v ?? 0)
    return {
      ...base,
      data: ((data ?? []) as Obj[]).map(r => ({
        ...r,
        total:             num(r.total),
        balance_api:       num(r.balance_api),
        control_reduction: num(r.control_reduction),
        balance:           num(r.balance),
        control_total:     r.control_total === null ? null : num(r.control_total),
      })),
      total: count ?? 0,
    }
  }

  /**
   * Agregados de la cartera para las gráficas de los libros consultados.
   * La foto es siempre la última sincronizada; el periodo solo filtra la evolución diaria.
   */
  static async getReport(query: ReceivablesReportQuery, user: AuthUser) {
    const scope = await SiigoService.resolveScope(query, user)
    const { logs, isSyncRunning } = scope.books ? await this.getSyncLogs(scope.books.connectionId) : { logs: [], isSyncRunning: false }
    const base = {
      scope:         scope.companyId ? 'company' : 'global',
      books:         scope.books,
      notConnected:  scope.notConnected,
      clientCompany: scope.clientCompany,
      isSyncRunning,
      lastSync:      logs[0] ?? null,
      lastSuccess:   logs.find(l => l.status === 'completed') ?? null,
    }
    const empty = { cutDate: null, summary: null, byBucket: [], byCustomer: [], bySeller: [], oldest: [], history: [] }
    if (scope.denied || !scope.books) return { ...base, ...empty }

    const { data, error } = await supabase.rpc('siigo_receivables_report', {
      p_connection: scope.books.connectionId,
      p_company_id: scope.companyId,
      p_from:       query.startDate ?? null,
      p_to:         query.endDate ?? null,
      // Filtros cruzados de las gráficas: solo se envían si vienen (la firma sin ellos sigue sirviendo)
      ...(query.bucket ? { p_bucket: query.bucket } : {}),
      ...(query.seller ? { p_seller: query.seller } : {}),
      ...(query.customerNit ? { p_nit: query.customerNit } : {}),
    })
    if (error) throw dbError(`No se pudieron calcular las gráficas de cartera: ${error.message}`, error)
    return { ...base, ...empty, ...((data ?? {}) as Obj) }
  }
}
