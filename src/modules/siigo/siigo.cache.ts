import fs from 'node:fs'
import path from 'node:path'
import { redis } from '../../lib/redis.js'
import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import { SIIGO_CONFIG } from './siigo.config.js'

const TOKEN_REDIS_PREFIX = 'siigo:auth:token:'
const TOKEN_TTL_SECONDS = 50 * 60 // 50 minutos

/** Caché de nombres de clientes y descripciones de productos de UNA cuenta de Siigo */
class SiigoCatalogMemoryCache {
  private customerMap = new Map<string, string>()
  private productMap = new Map<string, string>()
  private dirtyCustomers = new Map<string, string>()
  private dirtyProducts = new Map<string, string>()
  private initialized = false

  constructor(private connectionId: string, private seedFromLegacy: boolean) {}

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    // 1. Semilla legacy "consultas sigo/cache" (solo la cuenta de Finto)
    if (this.seedFromLegacy) {
      try {
        for (const [file, map] of [['customers.json', this.customerMap], ['products.json', this.productMap]] as const) {
          const full = path.join(SIIGO_CONFIG.LEGACY_DIR, 'cache', file)
          if (!fs.existsSync(full)) continue
          const raw = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<string, string>
          for (const [k, v] of Object.entries(raw)) if (v) map.set(k, v)
        }
      } catch (err: any) {
        logger.debug({ err: err.message }, 'No se pudo leer caché legacy de consultas sigo')
      }
    }

    // 2. Caché persistida de esta conexión
    const { data, error } = await supabase
      .from('siigo_catalog_cache')
      .select('cache_type, cache_key, value')
      .eq('connection_id', this.connectionId)
    if (!error) {
      for (const row of data ?? []) {
        if (row.cache_type === 'customer') this.customerMap.set(row.cache_key, row.value)
        else if (row.cache_type === 'product') this.productMap.set(row.cache_key, row.value)
      }
    }
  }

  async getCustomer(key: string): Promise<string | undefined> {
    await this.init()
    return this.customerMap.get(key)
  }

  async setCustomer(key: string, value: string): Promise<void> {
    await this.init()
    this.customerMap.set(key, value)
    this.dirtyCustomers.set(key, value)
  }

  async getProduct(key: string): Promise<string | undefined> {
    await this.init()
    return this.productMap.get(key)
  }

  async setProduct(key: string, value: string): Promise<void> {
    await this.init()
    this.productMap.set(key, value)
    this.dirtyProducts.set(key, value)
  }

  getStats() {
    return { customersCount: this.customerMap.size, productsCount: this.productMap.size }
  }

  async flushToDatabase(): Promise<void> {
    const now = new Date().toISOString()
    const rows = [
      ...[...this.dirtyCustomers].map(([k, v]) => ({ cache_type: 'customer', cache_key: k, value: v })),
      ...[...this.dirtyProducts].map(([k, v]) => ({ cache_type: 'product', cache_key: k, value: v })),
    ].map(r => ({ ...r, connection_id: this.connectionId, updated_at: now }))

    this.dirtyCustomers.clear()
    this.dirtyProducts.clear()
    if (!rows.length) return

    const { error } = await supabase
      .from('siigo_catalog_cache')
      .upsert(rows, { onConflict: 'connection_id,cache_type,cache_key' })
    if (error) logger.warn({ err: error.message }, 'No se pudo persistir siigo_catalog_cache en Supabase')
  }
}

const catalogs = new Map<string, SiigoCatalogMemoryCache>()

/** Caché de catálogos de una conexión (cada cuenta de Siigo tiene sus propios clientes y productos) */
export function getCatalogCache(connectionId: string, isPlatform: boolean): SiigoCatalogMemoryCache {
  let cache = catalogs.get(connectionId)
  if (!cache) {
    cache = new SiigoCatalogMemoryCache(connectionId, isPlatform)
    catalogs.set(connectionId, cache)
  }
  return cache
}

export async function getCachedSiigoToken(connectionId: string): Promise<string | null> {
  try {
    return (await redis.get(TOKEN_REDIS_PREFIX + connectionId)) || null
  } catch {
    return null // Fallback si Redis falla
  }
}

export async function setCachedSiigoToken(connectionId: string, token: string): Promise<void> {
  try {
    await redis.set(TOKEN_REDIS_PREFIX + connectionId, token, 'EX', TOKEN_TTL_SECONDS)
  } catch {
    // Ignorar error de Redis
  }
}

export async function clearCachedSiigoToken(connectionId: string): Promise<void> {
  try {
    await redis.del(TOKEN_REDIS_PREFIX + connectionId)
  } catch {
    // Ignorar error de Redis
  }
}
