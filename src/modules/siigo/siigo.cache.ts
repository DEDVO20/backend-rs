import fs from 'node:fs'
import path from 'node:path'
import { redis } from '../../lib/redis.js'
import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import { SIIGO_CONFIG } from './siigo.config.js'

const TOKEN_REDIS_KEY = 'siigo:auth:token'
const TOKEN_TTL_SECONDS = 50 * 60 // 50 minutos

class SiigoCatalogMemoryCache {
  private customerMap = new Map<string, string>()
  private productMap = new Map<string, string>()
  private dirtyCustomers = new Map<string, string>()
  private dirtyProducts = new Map<string, string>()
  private initialized = false

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    // 1. Cargar semilla inicial desde la carpeta legacy "consultas sigo/cache" si existe
    try {
      const legacyCustomersFile = path.join(SIIGO_CONFIG.LEGACY_DIR, 'cache', 'customers.json')
      if (fs.existsSync(legacyCustomersFile)) {
        const raw = JSON.parse(fs.readFileSync(legacyCustomersFile, 'utf-8')) as Record<string, string>
        for (const [k, v] of Object.entries(raw)) {
          if (v) this.customerMap.set(k, v)
        }
      }
      const legacyProductsFile = path.join(SIIGO_CONFIG.LEGACY_DIR, 'cache', 'products.json')
      if (fs.existsSync(legacyProductsFile)) {
        const raw = JSON.parse(fs.readFileSync(legacyProductsFile, 'utf-8')) as Record<string, string>
        for (const [k, v] of Object.entries(raw)) {
          if (v) this.productMap.set(k, v)
        }
      }
    } catch (err: any) {
      logger.debug({ err: err.message }, 'No se pudo leer caché legacy de consultas sigo')
    }

    // 2. Cargar desde Supabase (siigo_catalog_cache) si la tabla está disponible
    try {
      const { data, error } = await supabase
        .from('siigo_catalog_cache')
        .select('cache_type, cache_key, value')

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          if (row.cache_type === 'customer') {
            this.customerMap.set(row.cache_key, row.value)
          } else if (row.cache_type === 'product') {
            this.productMap.set(row.cache_key, row.value)
          }
        }
      }
    } catch {
      // Ignorar si la tabla aún no existe
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
    return {
      customersCount: this.customerMap.size,
      productsCount:  this.productMap.size,
    }
  }

  async flushToDatabase(): Promise<void> {
    const rows: { cache_type: 'customer' | 'product'; cache_key: string; value: string; updated_at: string }[] = []
    const now = new Date().toISOString()

    for (const [k, v] of this.dirtyCustomers.entries()) {
      rows.push({ cache_type: 'customer', cache_key: k, value: v, updated_at: now })
    }
    for (const [k, v] of this.dirtyProducts.entries()) {
      rows.push({ cache_type: 'product', cache_key: k, value: v, updated_at: now })
    }

    this.dirtyCustomers.clear()
    this.dirtyProducts.clear()

    if (!rows.length) return

    try {
      await supabase
        .from('siigo_catalog_cache')
        .upsert(rows, { onConflict: 'cache_type,cache_key' })
    } catch (err: any) {
      logger.warn({ err: err.message }, 'No se pudo persistir siigo_catalog_cache en Supabase')
    }
  }
}

export const siigoCatalogCache = new SiigoCatalogMemoryCache()

export async function getCachedSiigoToken(): Promise<string | null> {
  try {
    const token = await redis.get(TOKEN_REDIS_KEY)
    if (token) return token
  } catch {
    // Fallback si Redis falla
  }
  return null
}

export async function setCachedSiigoToken(token: string): Promise<void> {
  try {
    await redis.set(TOKEN_REDIS_KEY, token, 'EX', TOKEN_TTL_SECONDS)
  } catch {
    // Ignorar error de Redis
  }
}
