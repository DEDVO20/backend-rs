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
  VOUCHERS_URL:     'https://api.siigo.com/v1/vouchers',
  DOCUMENT_TYPES_URL: 'https://api.siigo.com/v1/document-types',

  // Recaudo (recibos de caja): fecha inicial de la consulta y tope de peticiones por ejecución
  get COLLECTIONS_START_DATE() { return process.env.SIIGO_COLLECTIONS_START_DATE || '2026-01-01' },
  COLLECTIONS_MAX_REQUESTS: 4000,
  COLLECTIONS_MAX_PAGES: 200,
  COLLECTIONS_MAX_GAP_QUERIES: 200,

  // Credenciales de la cuenta de Finto (conexión de plataforma) cuando no hay otras guardadas en la base.
  // Las de cada empresa cliente viven cifradas en siigo_connections.
  get USERNAME() { return process.env.SIIGO_USERNAME || '' },
  get ACCESS_KEY() { return process.env.SIIGO_ACCESS_KEY || '' },
  get PARTNER_ID() { return process.env.SIIGO_PARTNER_ID || 'RSHUBS' },

  // Vendedor por defecto en los libros de Finto (689 = Paola Blanco); no aplica a otras cuentas
  get SELLER_ID_FILTER() { return process.env.SELLER_ID_FILTER ?? '689' },
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
