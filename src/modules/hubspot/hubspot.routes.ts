import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requirePermission, requireRole } from '../../middleware/requireRole.js'
import { logger } from '../../lib/logger.js'
import { HubspotService } from './hubspot.service.js'
import { hubspotReportQuerySchema, hubspotSyncBodySchema, listHubspotDealsQuerySchema, saveHubspotConnectionBodySchema } from './hubspot.schema.js'

/**
 * CRM (HubSpot). Las gráficas viven junto a las de Siigo, así que usan el mismo módulo y permisos.
 * - Clientes: el HubSpot de su propia empresa.
 * - Internos: el de los libros elegidos (o la empresa indicada).
 */
const app = new Hono()

const INTERNAL = ['admin', 'rs_admin', 'rs_staff', 'contador'] as const

app.use('/*', authMiddleware, requireModule('siigo'))

// GET /api/hubspot/connections/company/:companyId — conexión de una empresa (sin token)
app.get('/connections/company/:companyId', requireRole(...INTERNAL), async (c) => {
  const row = await HubspotService.byCompany(c.req.param('companyId')!)
  return c.json(row ? HubspotService.toPublic(row) : null)
})

// PUT /api/hubspot/connections/company/:companyId — conecta o actualiza el token de una empresa
app.put(
  '/connections/company/:companyId',
  requirePermission('siigo', 'update'),
  zValidator('json', saveHubspotConnectionBodySchema),
  async (c) => c.json(await HubspotService.saveForCompany(c.req.param('companyId')!, c.req.valid('json'), c.get('user').id)),
)

// POST /api/hubspot/connections/:id/test — valida el token contra HubSpot
app.post('/connections/:id/test', requirePermission('siigo', 'update'), async (c) =>
  c.json(await HubspotService.test(c.req.param('id')!)),
)

// GET /api/hubspot/report — valor por etapa y socio, y conversión mensual
app.get('/report', zValidator('query', hubspotReportQuerySchema), async (c) =>
  c.json(await HubspotService.getReport(c.req.valid('query'), c.get('user'))),
)

// GET /api/hubspot/deals — detalle de negocios (pestaña CRM de Consultas Siigo)
app.get('/deals', zValidator('query', listHubspotDealsQuerySchema), async (c) =>
  c.json(await HubspotService.listDeals(c.req.valid('query'), c.get('user'))),
)

// POST /api/hubspot/sync — trae los negocios en segundo plano (202)
app.post(
  '/sync',
  requireRole(...INTERNAL),
  requirePermission('siigo', 'create'),
  zValidator('json', hubspotSyncBodySchema),
  async (c) => {
    const user = c.get('user')
    const conn = await HubspotService.resolveScope(c.req.valid('json'), user)
    if (!conn) return c.json({ error: 'Esta empresa no tiene HubSpot conectado.' }, 400)
    HubspotService.client(conn) // valida activa y con token (lanza 400)
    if (HubspotService.isRunning(conn.id)) {
      return c.json({ error: `Ya hay una sincronización de HubSpot en curso para ${conn.label}.` }, 409)
    }
    HubspotService.sync(conn.id, user.id).catch(err => logger.error({ err: err.message, connection: conn.label }, 'Sincronización de HubSpot fallida'))
    return c.json({ started: true, connectionId: conn.id, label: conn.label }, 202)
  },
)

// GET /api/hubspot/sync-logs?connectionId — historial de la conexión de HubSpot
app.get('/sync-logs', requireRole(...INTERNAL), async (c) => {
  const id = c.req.query('connectionId')
  if (!id) return c.json({ error: 'connectionId requerido' }, 400)
  return c.json(await HubspotService.getSyncLogs(id))
})

export const hubspotRoutes = app
