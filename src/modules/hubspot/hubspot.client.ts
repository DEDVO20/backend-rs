import { logger } from '../../lib/logger.js'

const BASE_URL = 'https://api.hubapi.com'
const PAGE_SIZE = 100
const MAX_PAGES = 500

type Obj = Record<string, any>

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
      if (resp.status === 401) throw Object.assign(new Error('HubSpot rechazó el token (401). Revisa el token de la private app.'), { statusCode: 400 })
      if (resp.status === 403) throw Object.assign(new Error(`HubSpot negó el acceso (403): faltan permisos en la private app. ${body.slice(0, 300)}`), { statusCode: 400 })
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
