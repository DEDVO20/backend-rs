import { logger } from '../../lib/logger.js'

const BASE_URL = 'https://api.hubapi.com'
const PAGE_SIZE = 100
const MAX_PAGES = 500

type Obj = Record<string, any>

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Nombre legible de la consulta, para los mensajes de error */
function describePath(path: string): string {
  if (path.includes('/owners')) return 'los socios (owners)'
  if (path.includes('/pipelines')) return 'las etapas de negocios (pipelines)'
  if (path.includes('/deals')) return 'los negocios (deals)'
  return path
}

/** Permisos que HubSpot pide en un 403 (errors[].context.requiredGranularScopes o requiredScopes) */
export function missingScopes(body: string): string {
  try {
    const json = JSON.parse(body)
    const scopes = new Set<string>()
    for (const e of Array.isArray(json?.errors) ? json.errors : []) {
      for (const k of ['requiredGranularScopes', 'requiredScopes', 'requiredAllScopes']) {
        for (const s of Array.isArray(e?.context?.[k]) ? e.context[k] : []) scopes.add(String(s))
      }
    }
    return [...scopes].join(' o ')
  } catch {
    return ''
  }
}

/** Cliente de la API de HubSpot con token de private app (scopes: crm.objects.deals.read, crm.objects.owners.read) */
export class HubspotClient {
  public requestCount = 0

  constructor(private token: string) {}

  async get(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Obj> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    const url = `${BASE_URL}${path}${qs.size ? `?${qs}` : ''}`

    let waitMs = 2000
    for (let attempt = 1; attempt <= 6; attempt++) {
      this.requestCount++
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } })
      const body = await resp.text()

      // Límite de peticiones (100 cada 10 s en private apps) o error temporal: esperar y reintentar
      if ((resp.status === 429 || resp.status >= 500) && attempt < 6) {
        const retryAfter = Number(resp.headers.get('retry-after'))
        const ms = retryAfter > 0 ? retryAfter * 1000 : waitMs
        logger.warn({ status: resp.status, attempt, sleepSec: Math.round(ms / 1000) }, 'HubSpot: reintentando')
        await sleep(ms)
        waitMs = Math.min(waitMs * 2, 30_000)
        continue
      }
      if (resp.status === 401) {
        // Motivo que da HubSpot (token vencido, inválido, de otra cuenta…) y pista si no es un token de private app
        let reason = ''
        try { reason = String(JSON.parse(body)?.message ?? '') } catch { reason = body.slice(0, 200) }
        const hint = /^pat-/i.test(this.token)
          ? 'El token tiene el formato correcto: puede estar revocado o haber sido rotado en HubSpot.'
          : 'El valor guardado no es un token de private app (debe empezar por "pat-", ej. pat-na1-…); no uses el client secret ni el ID de la app.'
        throw Object.assign(new Error(`HubSpot rechazó el token (401)${reason ? `: ${reason}` : ''}. ${hint}`), { statusCode: 400 })
      }
      if (resp.status === 403) {
        throw Object.assign(new Error(
          `HubSpot negó el acceso (403) al consultar ${describePath(path)}: a la app privada le faltan permisos. ` +
          `Agrega en HubSpot (Apps privadas → Alcances) ${missingScopes(body) || 'crm.objects.deals.read y crm.objects.owners.read'} y vuelve a probar.`,
        ), { statusCode: 400 })
      }
      if (!resp.ok) throw new Error(`HubSpot respondió ${resp.status} en ${path}: ${body.slice(0, 500)}`)
      return body ? JSON.parse(body) : {}
    }
    throw new Error(`No fue posible completar la petición a HubSpot: ${path}`)
  }

  /** Recorre todas las páginas de un listado de HubSpot (paging.next.after) */
  async getAll(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Obj[]> {
    const out: Obj[] = []
    let after: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await this.get(path, { ...params, limit: PAGE_SIZE, after })
      out.push(...(Array.isArray(resp.results) ? resp.results : []))
      after = resp.paging?.next?.after
      if (!after) break
    }
    return out
  }

  listPipelines() {
    return this.get('/crm/v3/pipelines/deals').then(r => (Array.isArray(r.results) ? r.results : []) as Obj[])
  }

  /** Socios (owners), activos e inactivos, para nombrar los negocios antiguos */
  async listOwners(): Promise<Obj[]> {
    const [active, archived] = await Promise.all([
      this.getAll('/crm/v3/owners'),
      this.getAll('/crm/v3/owners', { archived: true }).catch(() => []),
    ])
    return [...active, ...archived]
  }

  listDeals() {
    return this.getAll('/crm/v3/objects/deals', {
      properties: 'dealname,amount,amount_in_home_currency,dealstage,pipeline,closedate,createdate,hubspot_owner_id',
      archived: false,
    })
  }
}
