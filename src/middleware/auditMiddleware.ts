import type { Context, Next } from 'hono'
import { auditAsync, type AuditAction } from '../lib/audit.js'

const METHOD_ACTION: Record<string, AuditAction> = {
  POST:   'create',
  PATCH:  'update',
  PUT:    'update',
  DELETE: 'delete',
}

// Overrides para paths que tienen semántica distinta al método HTTP
const PATH_ACTION_OVERRIDES: Array<{ pattern: RegExp; action: AuditAction }> = [
  { pattern: /^\/api\/collection\/debtors\/import$/, action: 'upload' },
  { pattern: /^\/api\/documents\/upload$/,           action: 'upload' },
  { pattern: /^\/api\/collection\/campaigns\/[^/]+\/send$/, action: 'send_campaign' },
]

// Extrae resource y resource_id del path.
// /api/companies/uuid-123/invite → resource='companies', resource_id='uuid-123'
function parseResource(path: string): { resource: string; resource_id?: string } {
  const parts = path.replace(/^\/api\//, '').split('/')
  const resource    = parts[0] ?? 'unknown'
  const resource_id = parts[1] && isUuid(parts[1]) ? parts[1] : undefined
  return { resource, resource_id }
}

function isUuid(s: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

// Rutas que se omiten del audit automático (muy frecuentes y de bajo riesgo)
const SKIP_PATHS = ['/api/collection/messages', '/health', '/openapi.json']

export async function auditMiddleware(c: Context, next: Next) {
  await next()

  const method = c.req.method
  if (!METHOD_ACTION[method]) return  // GET, HEAD, OPTIONS — no auditar

  const path = new URL(c.req.url).pathname
  if (SKIP_PATHS.some(p => path.startsWith(p))) return
  if (c.res.status >= 400) return  // solo auditar peticiones exitosas

  let user: any
  try { user = c.get('user') } catch { user = null }

  const override = PATH_ACTION_OVERRIDES.find(o => o.pattern.test(path))
  const action   = override?.action ?? METHOD_ACTION[method]!

  const { resource, resource_id } = parseResource(path)

  auditAsync({ action, resource, resource_id, user, c })
}
