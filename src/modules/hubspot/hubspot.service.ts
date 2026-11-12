import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import { decryptSecret, encryptSecret } from '../../lib/secretBox.js'
import { dbError } from '../siigo/siigo.helpers.js'
import { SiigoService } from '../siigo/siigo.service.js'
import { HubspotClient } from './hubspot.client.js'
import { ownerName, stagesFromPipelines, toDealRow } from './hubspot.domain.js'
import type { AuthUser } from '../../middleware/auth.js'
import type { HubspotReportQuery, SaveHubspotConnectionBody } from './hubspot.schema.js'

const INTERNAL_ROLES = ['admin', 'rs_admin', 'rs_staff', 'contador']
const COLUMNS = 'id, company_id, is_platform, label, token_enc, active, last_test_at, last_test_ok, last_test_message, updated_at'

export interface HubspotConnectionRow {
  id: string
  company_id: string | null
  is_platform: boolean
  label: string
  token_enc: string | null
  active: boolean
  last_test_at: string | null
  last_test_ok: boolean | null
  last_test_message: string | null
  updated_at: string
}

export type HubspotConnectionPublic = Omit<HubspotConnectionRow, 'token_enc'> & { has_token: boolean; uses_env_token: boolean }

export interface HubspotSyncLog {
  id: string
  connection_id: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'completed' | 'failed'
  deals_count: number
  http_requests_count: number
  duration_sec: number
  details: Record<string, string | number>
  error_message?: string | null
  triggered_by?: string | null
}

const envToken = () => process.env.HUBSPOT_ACCESS_TOKEN?.trim() || ''

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

export class HubspotService {
  private static runningSyncs = new Set<string>()

  static isRunning(connectionId: string) {
    return this.runningSyncs.has(connectionId)
  }

  // ── Conexiones ──────────────────────────────────────────────────────────────

  static toPublic(row: HubspotConnectionRow): HubspotConnectionPublic {
    const { token_enc, ...rest } = row
    return { ...rest, has_token: Boolean(token_enc) || (row.is_platform && Boolean(envToken())), uses_env_token: row.is_platform && !token_enc && Boolean(envToken()) }
  }

  static async byCompany(companyId: string): Promise<HubspotConnectionRow | null> {
    const { data, error } = await supabase.from('hubspot_connections').select(COLUMNS).eq('company_id', companyId).maybeSingle()
    if (error) throw dbError(`No se pudo consultar la conexión de HubSpot: ${error.message}`, error)
    return data as HubspotConnectionRow | null
  }

  static async byId(id: string): Promise<HubspotConnectionRow | null> {
    const { data, error } = await supabase.from('hubspot_connections').select(COLUMNS).eq('id', id).maybeSingle()
    if (error) throw dbError(`No se pudo consultar la conexión de HubSpot: ${error.message}`, error)
    return data as HubspotConnectionRow | null
  }

  static async platform(): Promise<HubspotConnectionRow> {
    const { data, error } = await supabase.from('hubspot_connections').select(COLUMNS).eq('is_platform', true).maybeSingle()
    if (error) throw dbError(`No se pudo consultar la conexión de HubSpot de Finto: ${error.message}`, error)
    if (!data) throw httpError('Falta la conexión de HubSpot de Finto (aplica la migración 20261112_hubspot_crm.sql).', 500)
    return data as HubspotConnectionRow
  }

  static hasToken(row: HubspotConnectionRow) {
    return Boolean(row.token_enc) || (row.is_platform && Boolean(envToken()))
  }

  static client(row: HubspotConnectionRow): HubspotClient {
    if (!row.active) throw httpError(`La conexión de HubSpot "${row.label}" está inactiva.`, 400)
    if (!this.hasToken(row)) throw httpError(`La conexión de HubSpot "${row.label}" no tiene token configurado.`, 400)
    return new HubspotClient(row.token_enc ? decryptSecret(row.token_enc) : envToken())
  }

  /** Crea o actualiza la conexión de una empresa. Token vacío = conservar el actual */
  static async saveForCompany(companyId: string, input: SaveHubspotConnectionBody, userId: string): Promise<HubspotConnectionPublic> {
    const { data: company, error: cErr } = await supabase.from('companies').select('id, name').eq('id', companyId).maybeSingle()
    if (cErr) throw dbError(`No se pudo consultar la empresa: ${cErr.message}`, cErr)
    if (!company) throw httpError('Empresa no encontrada', 404)

    const changes: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId, label: company.name }
    if (input.active !== undefined) changes.active = input.active
    if (input.token?.trim()) {
      changes.token_enc = encryptSecret(input.token.trim())
      changes.last_test_ok = null
      changes.last_test_at = null
      changes.last_test_message = null
    }

    const existing = await this.byCompany(companyId)
    if (!existing && !input.token?.trim()) throw httpError('Para conectar HubSpot se requiere el token de la private app.', 400)

    const q = existing
      ? supabase.from('hubspot_connections').update(changes).eq('id', existing.id)
      : supabase.from('hubspot_connections').insert({ ...changes, company_id: companyId, is_platform: false })
    const { data, error } = await q.select(COLUMNS).single()
    if (error) throw dbError(`No se pudo guardar la conexión de HubSpot: ${error.message}`, error)
    return this.toPublic(data as HubspotConnectionRow)
  }

  /** Prueba el token leyendo un negocio y un socio (valida los dos permisos que usa la sync) */
  static async test(id: string): Promise<HubspotConnectionPublic> {
    const row = await this.byId(id)
    if (!row) throw httpError('Conexión no encontrada', 404)

    let ok = false
    let message = ''
    try {
      const api = this.client({ ...row, active: true })
      await api.get('/crm/v3/objects/deals', { limit: 1 })
      await api.get('/crm/v3/owners', { limit: 1 })
      ok = true
      message = 'Conexión correcta: HubSpot permitió leer negocios y socios.'
    } catch (err: any) {
      message = String(err?.message ?? err).slice(0, 500)
    }

    const { data, error } = await supabase
      .from('hubspot_connections')
      .update({ last_test_at: new Date().toISOString(), last_test_ok: ok, last_test_message: message })
      .eq('id', row.id)
      .select(COLUMNS)
      .single()
    if (error) throw dbError(`No se pudo guardar el resultado de la prueba: ${error.message}`, error)
    return this.toPublic(data as HubspotConnectionRow)
  }

  /** Conexiones que el cron debe sincronizar */
  static async syncTargets(): Promise<HubspotConnectionRow[]> {
    const { data, error } = await supabase.from('hubspot_connections').select(COLUMNS).eq('active', true)
    if (error) throw dbError(`No se pudieron consultar las conexiones de HubSpot: ${error.message}`, error)
    return ((data ?? []) as HubspotConnectionRow[]).filter(r => this.hasToken(r))
  }

  /**
   * HubSpot de quien se consulta:
   * - Cliente: el de su propia empresa.
   * - Interno: el de los libros elegidos en «Libros de» (connectionId de Siigo): la empresa de esa
   *   cuenta o, si son los libros de Finto, el HubSpot de Finto. También acepta companyId directo.
   */
  static async resolveScope(query: { connectionId?: string; companyId?: string }, user: AuthUser): Promise<HubspotConnectionRow | null> {
    if (!INTERNAL_ROLES.includes(user.role)) {
      return user.companyId ? this.byCompany(user.companyId) : null
    }
    if (query.companyId) return this.byCompany(query.companyId)
    const books = await SiigoService.connectionFor(query.connectionId)
    return books.company_id ? this.byCompany(books.company_id) : this.platform()
  }

  // ── Sincronización ──────────────────────────────────────────────────────────

  /** Trae todos los negocios de HubSpot y reemplaza la foto de la conexión */
  static async sync(connectionId: string, triggeredBy?: string): Promise<HubspotSyncLog> {
    const row = await this.byId(connectionId)
    if (!row) throw httpError('Conexión de HubSpot no encontrada', 404)
    if (this.runningSyncs.has(row.id)) throw httpError(`Ya hay una sincronización de HubSpot en curso para ${row.label}.`, 409)
    const api = this.client(row)

    const startTime = Date.now()
    const details: Record<string, string | number> = {}
    this.runningSyncs.add(row.id)

    const finish = async (partial: Partial<HubspotSyncLog>) => {
      const log: HubspotSyncLog = {
        id:                  crypto.randomUUID(),
        connection_id:       row.id,
        started_at:          new Date(startTime).toISOString(),
        finished_at:         new Date().toISOString(),
        status:              'completed',
        deals_count:         0,
        http_requests_count: api.requestCount,
        duration_sec:        Math.round((Date.now() - startTime) / 1000),
        details,
        error_message:       null,
        triggered_by:        triggeredBy ?? null,
        ...partial,
      }
      const { error } = await supabase.from('hubspot_sync_logs').insert(log)
      if (error) logger.warn({ err: error.message }, 'No se pudo guardar el log de sync de HubSpot')
      return log
    }

    try {
      const [pipelines, owners, deals] = await Promise.all([api.listPipelines(), api.listOwners(), api.listDeals()])
      const stages = stagesFromPipelines(pipelines)
      const ownerNames = new Map(owners.map(o => [String(o.id), ownerName(o)]))
      details['Embudos'] = pipelines.length
      details['Etapas'] = [...stages.values()].map(s => `${s.label} (${s.kind})`).join(' · ')
      details['Socios'] = ownerNames.size

      const rows = deals.map(d => toDealRow(d, stages, ownerNames))
      const { data, error } = await supabase.rpc('hubspot_replace_deals', { p_connection: row.id, p_deals: rows })
      if (error) throw dbError(`No se pudieron guardar los negocios de HubSpot: ${error.message}`, error)

      return await finish({ deals_count: Number(data ?? rows.length) })
    } catch (err: any) {
      logger.warn({ connection: row.label, err: err.message }, 'HubSpot no sincronizado')
      await finish({ status: 'failed', error_message: String(err.message).slice(0, 2000) })
      throw err
    } finally {
      this.runningSyncs.delete(row.id)
    }
  }

  static async getSyncLogs(connectionId: string): Promise<{ isSyncRunning: boolean; logs: HubspotSyncLog[] }> {
    const { data, error } = await supabase
      .from('hubspot_sync_logs')
      .select('*')
      .eq('connection_id', connectionId)
      .order('started_at', { ascending: false })
      .limit(20)
    if (error) throw dbError(`No se pudieron consultar los logs de HubSpot: ${error.message}`, error)
    return { isSyncRunning: this.isRunning(connectionId), logs: (data ?? []) as HubspotSyncLog[] }
  }

  // ── Informe ────────────────────────────────────────────────────────────────

  static async getReport(query: HubspotReportQuery, user: AuthUser) {
    const conn = await this.resolveScope(query, user)
    const empty = { summary: null, byStage: [], monthly: [] }
    if (!conn || !this.hasToken(conn)) {
      return { connection: conn ? this.toPublic(conn) : null, notConnected: true, isSyncRunning: false, lastSync: null, ...empty }
    }

    const [{ logs, isSyncRunning }, { data, error }] = await Promise.all([
      this.getSyncLogs(conn.id),
      supabase.rpc('hubspot_deals_report', {
        p_connection: conn.id,
        p_from:       query.startDate ?? null,
        p_to:         query.endDate ?? null,
      }),
    ])
    if (error) throw dbError(`No se pudieron calcular las gráficas de CRM: ${error.message}`, error)
    return {
      connection: this.toPublic(conn),
      notConnected: false,
      isSyncRunning,
      lastSync: logs[0] ?? null,
      ...empty,
      ...((data ?? {}) as Record<string, unknown>),
    }
  }
}
