import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const SIIGO_CONFIG = {
  SIIGO_BASE_URL:   'https://api.siigo.com',
  TOKEN_URL:        'https://api.siigo.com/auth/token',
  INVOICES_URL:     'https://api.siigo.com/v1/invoices',
  CREDIT_NOTES_URL: 'https://api.siigo.com/v1/credit-notes',
  CUSTOMERS_URL:    'https://api.siigo.com/v1/customers',
  PRODUCTS_URL:     'https://api.siigo.com/v1/products',

  get USERNAME() { return process.env.SIIGO_USERNAME || 'pblanco@raddf.com' },
  get ACCESS_KEY() { return process.env.SIIGO_ACCESS_KEY || '' },
  get PARTNER_ID() { return process.env.SIIGO_PARTNER_ID || 'RSHUBS' },

  get SELLER_ID_FILTER() { return process.env.SELLER_ID_FILTER ?? '689' }, // 689 = Paola Blanco
  get START_YEAR() { return parseInt(process.env.START_YEAR || '2025', 10) },
  // Días que la sync incremental vuelve a revisar antes de la última sync (anulaciones y ediciones tardías)
  get SYNC_OVERLAP_DAYS() { return parseInt(process.env.SIIGO_SYNC_OVERLAP_DAYS || '5', 10) },

  PAGE_SIZE: 100,
  MAX_PAGES: 100,

  get SLEEP_BETWEEN_DOCS_MS() { return parseInt(process.env.SLEEP_BETWEEN_DOCS_MS || '400', 10) },
  get SLEEP_BETWEEN_PRODUCT_LOOKUPS_MS() { return parseInt(process.env.SLEEP_BETWEEN_PRODUCT_LOOKUPS_MS || '250', 10) },

  LEGACY_DIR: path.resolve(__dirname, '../../../../consultas sigo'),

  STATUS_EXCLUDE: new Set([
    'draft', 'borrador',
    'annulled', 'anulada', 'anulado',
    'void', 'cancelled', 'canceled', 'cancelada', 'cancelado',
  ]),
}

export function validateSiigoConfig(): string[] {
  const errors: string[] = []
  if (!SIIGO_CONFIG.USERNAME)   errors.push('Falta SIIGO_USERNAME en las variables de entorno (.env)')
  if (!SIIGO_CONFIG.ACCESS_KEY) errors.push('Falta SIIGO_ACCESS_KEY en las variables de entorno (.env)')
  if (!SIIGO_CONFIG.PARTNER_ID) errors.push('Falta SIIGO_PARTNER_ID en las variables de entorno (.env)')
  return errors
}
