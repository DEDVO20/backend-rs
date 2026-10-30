import { supabase } from '../../lib/supabase.js'
import { decryptSecret, encryptSecret } from '../../lib/secretBox.js'
import { SIIGO_CONFIG } from './siigo.config.js'
import { clearCachedSiigoToken } from './siigo.cache.js'
import { SiigoApiClient, type SiigoCredentials } from './siigo.client.js'
import type { SaveSiigoConnectionBody } from './siigo.schema.js'

/**
 * Conexiones de Siigo: una por cuenta de Siigo ("dueño de los libros").
 * - Plataforma (Finto): sin empresa; si no tiene credenciales guardadas usa las del .env.
 * - Empresa cliente: credenciales propias, cifradas en la base.
 * La access key nunca sale del backend.
 */

export interface SiigoConnectionRow {
  id: string
  company_id: string | null
  is_platform: boolean
  label: string
  username: string
  access_key_enc: string | null
  partner_id: string
  seller_filter: string
  sales_start_year: number | null
  collections_start_date: string | null
  active: boolean
  last_test_at: string | null
  last_test_ok: boolean | null
  last_test_message: string | null
  updated_at: string
}

/** Forma pública (sin secretos) que se envía al navegador */
export type SiigoConnectionPublic = Omit<SiigoConnectionRow, 'access_key_enc'> & {
  has_access_key: boolean
  uses_env_credentials: boolean
  company_name?: string | null
}

const COLUMNS = 'id, company_id, is_platform, label, username, access_key_enc, partner_id, seller_filter, sales_start_year, ' +
  'collections_start_date, active, last_test_at, last_test_ok, last_test_message, updated_at'

const envHasPlatformCredentials = () => Boolean(SIIGO_CONFIG.USERNAME && SIIGO_CONFIG.ACCESS_KEY)

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

export class SiigoConnections {
  static async platform(): Promise<SiigoConnectionRow> {
    const { data, error } = await supabase.from('siigo_connections').select(COLUMNS).eq('is_platform', true).maybeSingle()
    if (error) throw new Error(`No se pudo consultar la conexión de Siigo de Finto: ${error.message}`)
    if (!data) throw httpError('No existe la conexión de Siigo de la plataforma (migración 20261030 sin aplicar).', 500)
    return data as unknown as SiigoConnectionRow
  }

  static async byId(id: string): Promise<SiigoConnectionRow | null> {
    const { data, error } = await supabase.from('siigo_connections').select(COLUMNS).eq('id', id).maybeSingle()
    if (error) throw new Error(`No se pudo consultar la conexión de Siigo: ${error.message}`)
    return (data as unknown as SiigoConnectionRow) ?? null
  }

  static async byCompany(companyId: string): Promise<SiigoConnectionRow | null> {
    const { data, error } = await supabase.from('siigo_connections').select(COLUMNS).eq('company_id', companyId).maybeSingle()
    if (error) throw new Error(`No se pudo consultar la conexión de Siigo: ${error.message}`)
    return (data as unknown as SiigoConnectionRow) ?? null
  }

  static toPublic(row: SiigoConnectionRow, companyName?: string | null): SiigoConnectionPublic {
    const { access_key_enc, ...rest } = row
    return {
      ...rest,
      has_access_key: Boolean(access_key_enc),
      uses_env_credentials: row.is_platform && !access_key_enc && envHasPlatformCredentials(),
      ...(companyName !== undefined ? { company_name: companyName } : {}),
    }
  }

  /** Todas las conexiones (sin secretos), Finto primero */
  static async list(): Promise<SiigoConnectionPublic[]> {
    const { data, error } = await supabase
      .from('siigo_connections')
      .select(`${COLUMNS}, companies(name)`)
      .order('is_platform', { ascending: false })
      .order('label', { ascending: true })
    if (error) throw new Error(`No se pudieron consultar las conexiones de Siigo: ${error.message}`)
    return ((data ?? []) as any[]).map(r => {
      const { companies, ...row } = r
      return this.toPublic(row as SiigoConnectionRow, companies?.name ?? null)
    })
  }

  /** ¿Tiene credenciales utilizables? (la plataforma puede usar las del .env) */
  static hasCredentials(row: SiigoConnectionRow): boolean {
    if (row.username && row.access_key_enc) return true
    return row.is_platform && envHasPlatformCredentials()
  }

  /** Credenciales descifradas para llamar a Siigo (solo en el servidor) */
  static credentials(row: SiigoConnectionRow): SiigoCredentials {
    if (!this.hasCredentials(row)) {
      throw httpError(`La conexión de Siigo "${row.label}" no tiene usuario y access key configurados.`, 400)
    }
    const useEnv = row.is_platform && !row.access_key_enc
    return {
      connectionId: row.id,
      isPlatform:   row.is_platform,
      username:     useEnv ? SIIGO_CONFIG.USERNAME : row.username,
      accessKey:    useEnv ? SIIGO_CONFIG.ACCESS_KEY : decryptSecret(row.access_key_enc!),
      partnerId:    row.partner_id || SIIGO_CONFIG.PARTNER_ID,
    }
  }

  /** Cliente API listo para esta conexión (valida que esté activa y con credenciales) */
  static client(row: SiigoConnectionRow): SiigoApiClient {
    if (!row.active) throw httpError(`La conexión de Siigo "${row.label}" está inactiva.`, 400)
    return new SiigoApiClient(this.credentials(row))
  }

  /** Ajustes de sincronización de la cuenta (la plataforma conserva los valores del .env por defecto) */
  static settings(row: SiigoConnectionRow) {
    const startYear = row.sales_start_year ?? SIIGO_CONFIG.START_YEAR
    return {
      sellerFilter:         row.seller_filter || (row.is_platform ? SIIGO_CONFIG.SELLER_ID_FILTER : ''),
      salesStartYear:       startYear,
      collectionsStartDate: row.collections_start_date
        ?? (row.is_platform ? SIIGO_CONFIG.COLLECTIONS_START_DATE : `${startYear}-01-01`),
    }
  }

  /** Conexiones que el cron debe sincronizar */
  static async syncTargets(): Promise<SiigoConnectionRow[]> {
    const { data, error } = await supabase.from('siigo_connections').select(COLUMNS).eq('active', true)
    if (error) throw new Error(`No se pudieron consultar las conexiones de Siigo: ${error.message}`)
    return ((data ?? []) as unknown as SiigoConnectionRow[]).filter(r => this.hasCredentials(r))
  }

  private static buildChanges(input: SaveSiigoConnectionBody, userId: string) {
    const changes: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId }
    if (input.username !== undefined) changes.username = input.username.trim()
    if (input.partnerId !== undefined) changes.partner_id = input.partnerId.trim()
    if (input.sellerFilter !== undefined) changes.seller_filter = input.sellerFilter.trim()
    if (input.salesStartYear !== undefined) changes.sales_start_year = input.salesStartYear
    if (input.collectionsStartDate !== undefined) changes.collections_start_date = input.collectionsStartDate
    if (input.active !== undefined) changes.active = input.active
    // La access key solo se reemplaza si se envía una nueva (vacía = conservar la actual)
    if (input.accessKey) changes.access_key_enc = encryptSecret(input.accessKey.trim())
    return changes
  }

  /** Crea o actualiza la conexión de una empresa cliente */
  static async saveForCompany(companyId: string, input: SaveSiigoConnectionBody, userId: string): Promise<SiigoConnectionPublic> {
    const { data: company, error: cErr } = await supabase.from('companies').select('id, name').eq('id', companyId).maybeSingle()
    if (cErr) throw new Error(`No se pudo consultar la empresa: ${cErr.message}`)
    if (!company) throw httpError('Empresa no encontrada', 404)

    const existing = await this.byCompany(companyId)
    const changes = this.buildChanges(input, userId)
    let saved: SiigoConnectionRow

    if (existing) {
      const { data, error } = await supabase.from('siigo_connections').update(changes).eq('id', existing.id).select(COLUMNS).single()
      if (error) throw new Error(`No se pudo guardar la conexión de Siigo: ${error.message}`)
      saved = data as unknown as SiigoConnectionRow
    } else {
      if (!input.username?.trim() || !input.accessKey?.trim()) {
        throw httpError('Para crear la conexión se requieren usuario de API y access key.', 400)
      }
      const { data, error } = await supabase
        .from('siigo_connections')
        .insert({ ...changes, company_id: companyId, is_platform: false, label: company.name })
        .select(COLUMNS)
        .single()
      if (error) throw new Error(`No se pudo crear la conexión de Siigo: ${error.message}`)
      saved = data as unknown as SiigoConnectionRow
    }

    await clearCachedSiigoToken(saved.id)
    return this.toPublic(saved, company.name)
  }

  /** Actualiza la conexión de la plataforma (Finto) */
  static async savePlatform(input: SaveSiigoConnectionBody, userId: string): Promise<SiigoConnectionPublic> {
    const platform = await this.platform()
    const { data, error } = await supabase
      .from('siigo_connections')
      .update(this.buildChanges(input, userId))
      .eq('id', platform.id)
      .select(COLUMNS)
      .single()
    if (error) throw new Error(`No se pudo guardar la conexión de Siigo de Finto: ${error.message}`)
    await clearCachedSiigoToken(platform.id)
    return this.toPublic(data as unknown as SiigoConnectionRow)
  }

  /** Prueba las credenciales pidiendo un token nuevo a Siigo y guarda el resultado */
  static async test(id: string): Promise<SiigoConnectionPublic> {
    const row = await this.byId(id)
    if (!row) throw httpError('Conexión no encontrada', 404)

    let ok = false
    let message = ''
    try {
      await clearCachedSiigoToken(row.id)
      await new SiigoApiClient(this.credentials(row)).getAccessToken()
      ok = true
      message = 'Conexión correcta: Siigo entregó un token de acceso.'
    } catch (err: any) {
      message = String(err?.message ?? err).slice(0, 500)
    }

    const { data, error } = await supabase
      .from('siigo_connections')
      .update({ last_test_at: new Date().toISOString(), last_test_ok: ok, last_test_message: message })
      .eq('id', row.id)
      .select(COLUMNS)
      .single()
    if (error) throw new Error(`No se pudo guardar el resultado de la prueba: ${error.message}`)
    return this.toPublic(data as unknown as SiigoConnectionRow)
  }
}
