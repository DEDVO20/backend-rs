import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import { normalizeNit } from '../participations/participations.domain.js'
import { SIIGO_CONFIG, validateSiigoConfig } from './siigo.config.js'
import { matchCompanyByNit, sleep } from './siigo.helpers.js'
import { SiigoApiClient } from './siigo.client.js'
import { SiigoService } from './siigo.service.js'
import {
  MESES,
  convertirFilas,
  esXlsx,
  localizarEncabezados,
  periodo,
  readWorkbook,
} from './siigo.trialBalance.js'
import type { AuthUser } from '../../middleware/auth.js'
import type { ListSiigoCollectionsQuery, ListTrialBalanceQuery, SyncTrialBalanceBody } from './siigo.schema.js'

const REPORT_URL = `${SIIGO_CONFIG.SIIGO_BASE_URL}/v1/test-balance-report-by-thirdparty`
const DOWNLOAD_TRIES = 5

type Obj = Record<string, any>

export interface TrialBalanceSyncLog {
  id: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'completed' | 'failed'
  mode: 'current' | 'year'
  year: number
  months_ok: number
  months_failed: number
  rows_count: number
  http_requests_count: number
  duration_sec: number
  details: Record<string, string>
  error_message?: string | null
  triggered_by?: string | null
}

/** Hoy en hora de Colombia (YYYY-MM-DD) */
function todayBogota(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
}

/** Siigo genera el archivo de forma asíncrona: se espera y reintenta hasta recibir un XLSX válido */
async function downloadXlsx(url: string): Promise<ArrayBuffer> {
  for (let intento = 0; intento < DOWNLOAD_TRIES; intento++) {
    await sleep(intento === 0 ? 4000 : 2000 * 2 ** intento)
    try {
      const resp = await fetch(url)
      if (resp.status !== 200) continue
      const buffer = await resp.arrayBuffer()
      if (esXlsx(new Uint8Array(buffer))) return buffer
    } catch (err: any) {
      logger.debug({ err: err.message }, 'Descarga del balance de prueba fallida, reintentando')
    }
  }
  throw new Error('No se pudo descargar un XLSX válido desde Siigo.')
}

function fileUrlOf(resp: unknown): string {
  const r = resp as Obj
  const url = typeof resp === 'string' ? resp : (r?.file_url || r?.fileUrl || r?.data?.file_url || r?.data?.fileUrl)
  if (!url || !/^https:\/\//i.test(String(url))) throw new Error('Siigo no devolvió file_url válido.')
  return String(url)
}

export class SiigoTrialBalanceService {
  private static isSyncRunning = false

  static get running(): boolean {
    return this.isSyncRunning
  }

  /** Último mes a importar del año (mes actual si es el año en curso) */
  static lastMonthOf(year: number, today = todayBogota()): number {
    const currentYear = Number(today.slice(0, 4))
    if (year < currentYear) return 12
    if (year > currentYear) return 0
    return Number(today.slice(5, 7))
  }

  /** Importa un mes: genera el reporte, descarga el XLSX y reemplaza el mes completo */
  private static async importPeriod(
    api: SiigoApiClient,
    companies: Awaited<ReturnType<typeof SiigoService.loadCompanies>>,
    year: number,
    month: number,
    today: string,
  ): Promise<number> {
    const per = periodo(year, month)
    const diagnostics: Record<string, string | number> = {}

    try {
      const resp = await api.fetchWithRetry(REPORT_URL, {
        method: 'POST',
        body: JSON.stringify({ year, month_start: month, month_end: month, includes_tax_difference: true }),
      })
      const hojas = readWorkbook(await downloadXlsx(fileUrlOf(resp)))
      for (const h of hojas) diagnostics[`Hoja ${h.nombre}`] = `${h.filas.length} filas`

      const reporte = localizarEncabezados(hojas)
      if (!reporte) throw new Error('No se identificaron las columnas contables.')

      const { lines, detectados, antesDeDuplicados } = convertirFilas(reporte, year, month, today)
      diagnostics['Registros contables detectados'] = detectados
      diagnostics['Filas antes / después de eliminar duplicados'] = `${antesDeDuplicados} / ${lines.length}`
      if (!detectados) throw new Error('El archivo no trae registros reconocibles.')
      if (!lines.length) throw new Error('No se encontraron filas de detalle por tercero.')

      const rows = lines.map(l => {
        const company = l.identification ? matchCompanyByNit(companies, l.identification) : null
        return { ...l, normalized_nit: normalizeNit(l.identification), company_id: company?.id ?? null }
      })

      const { data, error } = await supabase.rpc('siigo_replace_trial_balance_period', { p_period: per, p_lines: rows })
      if (error) throw new Error(`No se pudo guardar el balance de ${per}: ${error.message}`)

      const count = Number(data ?? rows.length)
      const now = new Date().toISOString()
      await supabase.from('siigo_trial_balance_periods').upsert({
        period:          per,
        status:          'OK',
        rows_count:      count,
        cut_date:        rows[0]!.cut_date,
        last_attempt_at: now,
        last_success_at: now,
        detail:          `Actualizado correctamente. Rango: ${MESES[month - 1]} a ${MESES[month - 1]}`,
        diagnostics,
      })
      return count
    } catch (err: any) {
      // Se conservan los datos anteriores del mes; solo se registra el error
      await supabase.from('siigo_trial_balance_periods').upsert({
        period:          per,
        status:          'ERROR',
        last_attempt_at: new Date().toISOString(),
        detail:          String(err?.message ?? err).slice(0, 2000),
        diagnostics,
      })
      throw err
    }
  }

  /**
   * Importa el balance de prueba por tercero.
   * - mode 'current': solo el mes en curso (actualización diaria).
   * - mode 'year': de enero al mes actual (o diciembre si es un año cerrado).
   */
  static async syncFromSiigo(input: SyncTrialBalanceBody = { mode: 'current' }, triggeredBy?: string): Promise<TrialBalanceSyncLog> {
    if (this.isSyncRunning) {
      throw Object.assign(new Error('Ya hay una importación del balance de prueba en curso.'), { statusCode: 409 })
    }
    const configErrors = validateSiigoConfig()
    if (configErrors.length) throw Object.assign(new Error(configErrors.join('. ')), { statusCode: 400 })

    const today = todayBogota()
    const year = input.year ?? Number(today.slice(0, 4))
    const last = this.lastMonthOf(year, today)
    if (last < 1) throw Object.assign(new Error(`El año ${year} aún no ha comenzado.`), { statusCode: 400 })
    const months = input.mode === 'year' ? Array.from({ length: last }, (_, i) => i + 1) : [last]

    const startTime = Date.now()
    const details: Record<string, string> = {}
    let monthsOk = 0
    let rows = 0
    this.isSyncRunning = true

    const api = new SiigoApiClient()
    try {
      await api.getAccessToken()
      const companies = await SiigoService.loadCompanies()

      for (const month of months) {
        const per = periodo(year, month)
        try {
          const count = await this.importPeriod(api, companies, year, month, today)
          rows += count
          monthsOk++
          details[per] = `OK · ${count} filas`
        } catch (err: any) {
          details[per] = `ERROR · ${err.message}`
          logger.warn({ period: per, err: err.message }, 'Balance de prueba: mes no importado')
        }
      }

      const failed = months.length - monthsOk
      const log: TrialBalanceSyncLog = {
        id:                  crypto.randomUUID(),
        started_at:          new Date(startTime).toISOString(),
        finished_at:         new Date().toISOString(),
        status:              monthsOk > 0 ? 'completed' : 'failed',
        mode:                input.mode,
        year,
        months_ok:           monthsOk,
        months_failed:       failed,
        rows_count:          rows,
        http_requests_count: api.urlFetchCount,
        duration_sec:        Math.round((Date.now() - startTime) / 1000),
        details,
        error_message:       monthsOk > 0 ? null : Object.values(details).join(' | ').slice(0, 2000),
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
        mode:                input.mode,
        year,
        months_ok:           monthsOk,
        months_failed:       months.length - monthsOk,
        rows_count:          rows,
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

  private static async saveSyncLog(log: TrialBalanceSyncLog) {
    const { error } = await supabase.from('siigo_trial_balance_sync_logs').insert(log)
    if (error) logger.warn({ err: error.message }, 'No se pudo guardar el log del balance de prueba')
  }

  static async getSyncLogs(): Promise<{ isSyncRunning: boolean; logs: TrialBalanceSyncLog[] }> {
    const { data, error } = await supabase
      .from('siigo_trial_balance_sync_logs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(20)
    if (error) throw new Error(`No se pudieron consultar los logs del balance de prueba: ${error.message}`)
    return { isSyncRunning: this.isSyncRunning, logs: (data ?? []) as TrialBalanceSyncLog[] }
  }

  /**
   * Series para las gráficas del balance. Los clientes solo ven las filas donde su empresa
   * es el tercero; los internos ven el balance global o el de una empresa (companyId).
   */
  static async getChartsReport(query: ListSiigoCollectionsQuery, user: AuthUser) {
    const scope = await SiigoService.resolveScope(query, user)
    const { logs } = await this.getSyncLogs()
    const base = { scope: scope.companyId ? 'company' : 'global', clientCompany: scope.clientCompany, lastSync: logs[0] ?? null }
    if (scope.denied) return { ...base, latestPeriod: null, monthly: [], byAccount: [], topCartera: [] }

    const { data, error } = await supabase.rpc('siigo_trial_balance_series', {
      p_from:       query.startDate?.slice(0, 7) ?? null,
      p_to:         query.endDate?.slice(0, 7) ?? null,
      p_company_id: scope.companyId,
    })
    if (error) throw new Error(`No se pudieron calcular las gráficas del balance: ${error.message}`)
    const r = (data ?? {}) as Obj
    return {
      ...base,
      latestPeriod: r.latestPeriod ?? null,
      monthly:      r.monthly ?? [],
      byAccount:    r.byAccount ?? [],
      topCartera:   r.topCartera ?? [],
    }
  }

  /** Consulta de un mes: filas paginadas, totales por clase, cuadre y control de periodos */
  static async list(query: ListTrialBalanceQuery) {
    const [{ data: periods, error: pErr }, { logs, isSyncRunning }] = await Promise.all([
      supabase.from('siigo_trial_balance_periods').select('*').order('period', { ascending: false }),
      this.getSyncLogs(),
    ])
    if (pErr) throw new Error(`No se pudo consultar el control de periodos: ${pErr.message}`)

    // Por defecto, el último mes importado correctamente
    const period = query.period ?? periods?.find(p => p.status === 'OK' || p.last_success_at)?.period ?? null
    const base = { period, periods: periods ?? [], isSyncRunning, lastSync: logs[0] ?? null }
    if (!period) return { ...base, data: [], total: 0, page: 1, limit: query.limit, totals: null, byClass: [] }

    const args = {
      p_period:     period,
      p_account:    query.account?.replace(/\D/g, '') || null,
      p_company_id: query.companyId ?? null,
      p_search:     query.search?.trim() || null,
    }
    const from = (query.page - 1) * query.limit

    const [pageRes, reportRes] = await Promise.all([
      supabase
        .rpc('siigo_trial_balance_filtered', args, { count: 'exact' })
        .order('account_code', { ascending: true })
        .order('identification', { ascending: true })
        .range(from, from + query.limit - 1),
      supabase.rpc('siigo_trial_balance_report', args),
    ])
    if (pageRes.error && pageRes.error.code !== 'PGRST103') {
      throw new Error(`No se pudo consultar el balance de prueba: ${pageRes.error.message}`)
    }
    if (reportRes.error) throw new Error(`No se pudo calcular el resumen del balance: ${reportRes.error.message}`)

    const num = (r: Obj, k: string) => Number(r[k] ?? 0)
    return {
      ...base,
      data: ((pageRes.data ?? []) as Obj[]).map(r => ({
        ...r,
        initial_balance: num(r, 'initial_balance'),
        debit:           num(r, 'debit'),
        credit:          num(r, 'credit'),
        final_balance:   num(r, 'final_balance'),
      })),
      total:   pageRes.count ?? 0,
      page:    query.page,
      limit:   query.limit,
      totals:  (reportRes.data as Obj)?.totals ?? null,
      byClass: (reportRes.data as Obj)?.byClass ?? [],
    }
  }
}
