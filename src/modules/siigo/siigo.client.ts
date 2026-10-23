import { SIIGO_CONFIG } from './siigo.config.js'
import { getCachedSiigoToken, setCachedSiigoToken, siigoCatalogCache } from './siigo.cache.js'
import {
  sleep,
  buildQueryString,
  looksLikeUuid,
  normalizeStatus,
  normalizeDateText,
  firstNonEmpty,
} from './siigo.helpers.js'
import {
  getSellerId,
  getComprobanteSiigo,
  customerNameFromObject,
  getCodigoProductoFromItem,
  getProductIdFromItem,
  descripcionProductoInline,
  descripcionDesdeProductoCatalogo,
  type SiigoCatalogLookup,
} from './siigo.calculator.js'
import { logger } from '../../lib/logger.js'

export class SiigoApiClient implements SiigoCatalogLookup {
  private token: string | null = null
  public urlFetchCount = 0

  async getAccessToken(): Promise<string> {
    if (this.token) return this.token

    const cached = await getCachedSiigoToken()
    if (cached) {
      this.token = cached
      return this.token
    }

    logger.info('Solicitando nuevo token a Siigo API...')
    const resp = await this._fetchDirect(SIIGO_CONFIG.TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Partner-Id': SIIGO_CONFIG.PARTNER_ID,
      },
      body: JSON.stringify({
        username:   SIIGO_CONFIG.USERNAME,
        access_key: SIIGO_CONFIG.ACCESS_KEY,
      }),
    })

    const body = await resp.text()
    if (!resp.ok) {
      throw new Error(`Error de autenticación Siigo (${resp.status}): ${body}`)
    }

    const data = JSON.parse(body) as { access_token?: string }
    if (!data.access_token) {
      throw new Error(`Siigo no devolvió access_token: ${body}`)
    }

    this.token = data.access_token
    await setCachedSiigoToken(this.token)
    return this.token
  }

  private async _fetchDirect(url: string, options?: RequestInit): Promise<Response> {
    this.urlFetchCount++
    return await fetch(url, options)
  }

  async fetchWithRetry(url: string, options: RequestInit = {}): Promise<any> {
    const maxTries = 8
    let waitMs = 3000
    const token = await this.getAccessToken()

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Partner-Id':    SIIGO_CONFIG.PARTNER_ID,
      ...((options.headers as Record<string, string>) || {}),
    }

    for (let i = 1; i <= maxTries; i++) {
      try {
        const resp = await this._fetchDirect(url, { ...options, headers })
        const bodyText = await resp.text()

        if (resp.status === 429) {
          const waitSecs = this._extractWaitSecondsFrom429(bodyText)
          const sleepMs = waitSecs ? (waitSecs + 2) * 1000 : waitMs
          logger.warn({ attempt: i, maxTries, sleepSec: Math.round(sleepMs / 1000) }, 'Rate Limit 429 en Siigo API, esperando...')
          await sleep(sleepMs)
          waitMs = Math.min(Math.round(waitMs * 1.8), 45_000)
          continue
        }

        if (resp.status >= 500 && i < maxTries) {
          logger.warn({ status: resp.status, attempt: i }, 'Servidor Siigo 5xx, reintentando...')
          await sleep(waitMs)
          waitMs = Math.min(Math.round(waitMs * 1.8), 45_000)
          continue
        }

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} en ${url} -> ${bodyText}`)
        }

        return JSON.parse(bodyText)
      } catch (err: any) {
        if (i >= maxTries) throw err
        if (!String(err.message).includes('HTTP 429') && !String(err.message).includes('fetch')) {
          throw err
        }
        await sleep(waitMs)
      }
    }

    throw new Error(`No fue posible completar la petición tras ${maxTries} reintentos: ${url}`)
  }

  private _extractWaitSecondsFrom429(body: string): number {
    try {
      const json = JSON.parse(body) as Record<string, any>
      const errors = json.Errors || json.errors || []
      for (const e of errors) {
        const msg = String(e.Message || e.message || '')
        const m = msg.match(/(\d+)\s*seconds?/i)
        if (m && m[1]) return Number(m[1])
      }
    } catch {
      // Ignore parse error
    }

    const m = String(body || '').match(/(\d+)\s*seconds?/i)
    return m && m[1] ? Number(m[1]) : 0
  }

  async listDocumentIds(
    baseUrl: string,
    startDate: string,
    endDate: string,
    docTypeName = 'documentos',
    sellerFilter: string = SIIGO_CONFIG.SELLER_ID_FILTER,
  ): Promise<{ ids: string[]; excluded: { id: string; comprobante: string }[] }> {
    const ids: string[] = []
    // Documentos anulados/borrador: sus líneas previas deben eliminarse al re-sincronizar
    const excluded: { id: string; comprobante: string }[] = []
    const docType = baseUrl === SIIGO_CONFIG.CREDIT_NOTES_URL ? 'NOTA_CREDITO' : 'FACTURA'
    let page = 1

    logger.info({ docTypeName, startDate, endDate, sellerFilter }, 'Listando documentos en Siigo API')

    while (page <= SIIGO_CONFIG.MAX_PAGES) {
      const params = {
        page,
        page_size:  SIIGO_CONFIG.PAGE_SIZE,
        date_start: startDate,
        date_end:   endDate,
      }

      const qs = buildQueryString(params)
      let json: any
      try {
        json = await this.fetchWithRetry(baseUrl + qs)
      } catch (e: any) {
        if (String(e.message).includes('400') || String(e.message).includes('param')) {
          const qsFallback = buildQueryString({ page, page_size: SIIGO_CONFIG.PAGE_SIZE })
          json = await this.fetchWithRetry(baseUrl + qsFallback)
        } else {
          throw e
        }
      }

      const results = json?.results || json?.data || json?.items || []
      if (!Array.isArray(results) || results.length === 0) break

      for (const doc of results) {
        const status = normalizeStatus(doc.status || doc.state)
        if (SIIGO_CONFIG.STATUS_EXCLUDE.has(status)) {
          const excludedId = doc.id || doc.uuid
          if (excludedId) excluded.push({ id: String(excludedId), comprobante: getComprobanteSiigo(doc, docType) })
          continue
        }

        const fecha = normalizeDateText(
          firstNonEmpty([doc.date, doc.created, doc.created_at, doc.invoice_date]),
        )

        if (fecha && (fecha < startDate || fecha > endDate)) continue

        const sellerId = getSellerId(doc)
        if (sellerFilter && sellerId && String(sellerId) !== String(sellerFilter)) {
          continue
        }

        const id = doc.id || doc.uuid
        if (id) ids.push(String(id))
      }

      if (results.length < SIIGO_CONFIG.PAGE_SIZE) break
      page++
      await sleep(SIIGO_CONFIG.SLEEP_BETWEEN_DOCS_MS)
    }

    return { ids: Array.from(new Set(ids)), excluded }
  }

  async fetchDocumentById(baseUrl: string, id: string): Promise<Record<string, any>> {
    const url = `${baseUrl}/${encodeURIComponent(id)}`
    return await this.fetchWithRetry(url)
  }

  async getCustomerName(customerKey: string, sucursal: string): Promise<string> {
    const cacheKey = `${customerKey}|${String(sucursal || '')}`
    const cached = await siigoCatalogCache.getCustomer(cacheKey)
    if (cached !== undefined && cached !== '') {
      return cached
    }
    const cachedNoBranch = await siigoCatalogCache.getCustomer(`${customerKey}|`)
    if (cachedNoBranch !== undefined && cachedNoBranch !== '') {
      return cachedNoBranch
    }

    let name = ''
    if (looksLikeUuid(customerKey)) {
      try {
        const c = await this.fetchWithRetry(`${SIIGO_CONFIG.CUSTOMERS_URL}/${encodeURIComponent(customerKey)}`)
        name = customerNameFromObject(c)
      } catch {
        // Ignore lookup error
      }
    }

    if (!name) {
      try {
        const params: Record<string, string | number> = {
          identification: customerKey,
          page: 1,
          page_size: 10,
        }
        if (sucursal && sucursal !== '0') {
          params.branch_office = sucursal
        }
        const json = await this.fetchWithRetry(SIIGO_CONFIG.CUSTOMERS_URL + buildQueryString(params))
        const results = json?.results || json?.data || json?.items || []
        if (Array.isArray(results) && results.length > 0) {
          if (sucursal && sucursal !== '0') {
            for (const c of results) {
              const bo = String(c.branch_office || c.branchOffice || '').trim()
              if (bo === String(sucursal)) {
                name = customerNameFromObject(c)
                break
              }
            }
          }
          if (!name) name = customerNameFromObject(results[0])
        }
      } catch {
        // Ignore lookup error
      }
    }

    if (name) {
      await siigoCatalogCache.setCustomer(cacheKey, name)
    }
    return name || ''
  }

  async getProductDescription(it: Record<string, unknown>): Promise<string> {
    const codigo = String(getCodigoProductoFromItem(it) || '').trim()
    const productId = String(getProductIdFromItem(it) || '').trim()
    const cacheKey = productId ? `ID:${productId}` : `COD:${codigo}`

    if (cacheKey) {
      const cached = await siigoCatalogCache.getProduct(cacheKey)
      if (cached !== undefined && cached !== '') return cached
    }
    if (codigo) {
      const cachedByCode = await siigoCatalogCache.getProduct(`COD:${codigo}`)
      if (cachedByCode !== undefined && cachedByCode !== '') return cachedByCode
    }

    let desc = descripcionProductoInline(it)

    if (!desc) {
      await sleep(SIIGO_CONFIG.SLEEP_BETWEEN_PRODUCT_LOOKUPS_MS)
      let catalogProduct: Record<string, any> | null = null

      if (productId) {
        try {
          catalogProduct = await this.fetchWithRetry(`${SIIGO_CONFIG.PRODUCTS_URL}/${encodeURIComponent(productId)}`)
        } catch {
          // Ignore
        }
      }

      if (!catalogProduct && codigo) {
        try {
          const json = await this.fetchWithRetry(
            SIIGO_CONFIG.PRODUCTS_URL + buildQueryString({ code: codigo, page: 1, page_size: 10 }),
          )
          const results = json?.results || json?.data || json?.items || []
          if (Array.isArray(results)) {
            for (const p of results) {
              const pCode = String(firstNonEmpty([p.code, p.identification, p.reference, p.sku, ''])).trim()
              if (pCode === codigo) {
                catalogProduct = p
                break
              }
            }
            if (!catalogProduct && results.length) catalogProduct = results[0]
          }
        } catch {
          // Ignore
        }
      }

      if (catalogProduct) {
        desc = descripcionDesdeProductoCatalogo(catalogProduct)
      }
    }

    if (!desc) {
      desc = codigo || 'SIN PRODUCTO'
    }

    if (cacheKey) {
      await siigoCatalogCache.setProduct(cacheKey, desc)
    }

    return desc
  }
}
