import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requirePermission, requireRole } from '../../middleware/requireRole.js'
import { logger } from '../../lib/logger.js'
import { SiigoService } from './siigo.service.js'
import { SiigoCollectionsService } from './siigo.collections.service.js'
import { SiigoTrialBalanceService } from './siigo.trialBalance.service.js'
import { SiigoConnections } from './siigo.connections.js'
import {
  listSiigoCollectionsQuerySchema,
  listSiigoSalesQuerySchema,
  listTrialBalanceQuerySchema,
  saveSiigoConnectionBodySchema,
  syncLogsQuerySchema,
  syncSiigoBodySchema,
  syncSiigoCollectionsBodySchema,
  syncTrialBalanceBodySchema,
} from './siigo.schema.js'

/**
 * Consultas Siigo multiempresa. Cada consulta lee los libros de UNA cuenta de Siigo (conexión):
 * - Clientes: siempre los de su propia empresa (si tiene conexión). Nunca los de Finto.
 * - Internos: los de la conexión indicada en `connectionId` (Finto por defecto).
 */
const app = new Hono()

const INTERNAL = ['admin', 'rs_admin', 'rs_staff', 'contador'] as const

app.use('/*', authMiddleware, requireModule('siigo'))

/**
 * Lanza una sincronización en segundo plano (puede tardar minutos) y responde 202.
 * Valida antes la conexión (existe, activa, con credenciales) y que no haya otra en curso.
 */
async function startInBackground(
  connectionId: string | undefined,
  isRunning: (id: string) => boolean,
  run: () => Promise<unknown>,
  label: string,
) {
  const conn = await SiigoService.connectionFor(connectionId)
  SiigoConnections.client(conn) // valida activa y con credenciales (lanza 400)
  if (isRunning(conn.id)) {
    throw Object.assign(new Error(`Ya hay una sincronización de ${label} en curso para ${conn.label}. Espera a que termine.`), { statusCode: 409 })
  }
  run().catch(err => logger.error({ err: err.message, connection: conn.label }, `Sincronización de ${label} Siigo fallida`))
  return { started: true, connectionId: conn.id }
}

// ── Conexiones (solo roles internos) ────────────────────────────────────────

// GET /api/siigo/connections — conexiones (sin secretos) para el selector de libros
app.get('/connections', requireRole(...INTERNAL), async (c) => c.json(await SiigoConnections.list()))

// GET /api/siigo/connections/company/:companyId — conexión de una empresa (sin secretos)
app.get('/connections/company/:companyId', requireRole(...INTERNAL), async (c) => {
  const row = await SiigoConnections.byCompany(c.req.param('companyId')!)
  return c.json(row ? SiigoConnections.toPublic(row) : null)
})

// PUT /api/siigo/connections/company/:companyId — crea o actualiza credenciales de una empresa
app.put(
  '/connections/company/:companyId',
  requirePermission('siigo', 'update'),
  zValidator('json', saveSiigoConnectionBodySchema),
  async (c) => c.json(await SiigoConnections.saveForCompany(c.req.param('companyId')!, c.req.valid('json'), c.get('user').id)),
)

// PUT /api/siigo/connections/platform — credenciales y ajustes de la cuenta de Finto
app.put(
  '/connections/platform',
  requirePermission('siigo', 'update'),
  zValidator('json', saveSiigoConnectionBodySchema),
  async (c) => c.json(await SiigoConnections.savePlatform(c.req.valid('json'), c.get('user').id)),
)

// POST /api/siigo/connections/:id/test — pide un token a Siigo con esas credenciales
app.post(
  '/connections/:id/test',
  requirePermission('siigo', 'update'),
  async (c) => c.json(await SiigoConnections.test(c.req.param('id')!)),
)

// ── Facturación ─────────────────────────────────────────────────────────────

// GET /api/siigo/sales — facturas y notas crédito desglosadas por producto
app.get('/sales', zValidator('query', listSiigoSalesQuerySchema), async (c) =>
  c.json(await SiigoService.listSales(c.req.valid('query'), c.get('user'))),
)

// GET /api/siigo/report — solo agregados (mensual, por servicio, por cliente) para la vista de gráficas
app.get('/report', zValidator('query', listSiigoSalesQuerySchema), async (c) =>
  c.json(await SiigoService.getReport(c.req.valid('query'), c.get('user'))),
)

// GET /api/siigo/export — informe Excel (.xlsx) con las 3 hojas (INFORME, RESUMEN, LOG)
app.get(
  '/export',
  zValidator('query', listSiigoSalesQuerySchema),
  async (c) => {
    const { buffer, filename } = await SiigoService.exportExcel(c.req.valid('query'), c.get('user'))
    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    c.header('Content-Disposition', `attachment; filename="${filename}"`)
    c.header('Content-Length', String(buffer.byteLength))
    return c.body(new Uint8Array(buffer))
  },
)

// POST /api/siigo/sync — sincroniza facturación de una conexión en segundo plano
app.post(
  '/sync',
  requirePermission('siigo', 'create'),
  zValidator('json', syncSiigoBodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const res = await startInBackground(
      body.connectionId, id => SiigoService.isRunning(id),
      () => SiigoService.syncFromSiigo(body, c.get('user').id), 'facturación',
    )
    return c.json(res, 202)
  },
)

// GET /api/siigo/sync-logs?connectionId — historial de sincronización de facturación
app.get('/sync-logs', requireRole(...INTERNAL), zValidator('query', syncLogsQuerySchema), async (c) => {
  const conn = await SiigoService.connectionFor(c.req.valid('query').connectionId)
  return c.json(await SiigoService.getSyncLogs(conn.id))
})

// ── Recaudo (recibos de caja) ───────────────────────────────────────────────

app.get('/collections', zValidator('query', listSiigoCollectionsQuerySchema), async (c) =>
  c.json(await SiigoCollectionsService.listCollections(c.req.valid('query'), c.get('user'))),
)

app.get('/collections/report', zValidator('query', listSiigoCollectionsQuerySchema), async (c) =>
  c.json(await SiigoCollectionsService.getReport(c.req.valid('query'), c.get('user'))),
)

app.post(
  '/collections/sync',
  requirePermission('siigo', 'create'),
  zValidator('json', syncSiigoCollectionsBodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const res = await startInBackground(
      body.connectionId, id => SiigoCollectionsService.isRunning(id),
      () => SiigoCollectionsService.syncFromSiigo(body, c.get('user').id), 'recaudo',
    )
    return c.json(res, 202)
  },
)

app.get('/collections/sync-logs', requireRole(...INTERNAL), zValidator('query', syncLogsQuerySchema), async (c) => {
  const conn = await SiigoService.connectionFor(c.req.valid('query').connectionId)
  return c.json(await SiigoCollectionsService.getSyncLogs(conn.id))
})

// ── Balance de prueba por tercero ───────────────────────────────────────────

// GET /api/siigo/trial-balance — un mes de los libros consultados (clientes: su propia empresa)
app.get('/trial-balance', zValidator('query', listTrialBalanceQuerySchema), async (c) =>
  c.json(await SiigoTrialBalanceService.list(c.req.valid('query'), c.get('user'))),
)

// GET /api/siigo/trial-balance/report — series para las gráficas
app.get('/trial-balance/report', zValidator('query', listSiigoCollectionsQuerySchema), async (c) =>
  c.json(await SiigoTrialBalanceService.getChartsReport(c.req.valid('query'), c.get('user'))),
)

app.post(
  '/trial-balance/sync',
  requirePermission('siigo', 'create'),
  zValidator('json', syncTrialBalanceBodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const res = await startInBackground(
      body.connectionId, id => SiigoTrialBalanceService.isRunning(id),
      () => SiigoTrialBalanceService.syncFromSiigo(body, c.get('user').id), 'balance de prueba',
    )
    return c.json(res, 202)
  },
)

app.get('/trial-balance/sync-logs', requireRole(...INTERNAL), zValidator('query', syncLogsQuerySchema), async (c) => {
  const conn = await SiigoService.connectionFor(c.req.valid('query').connectionId)
  return c.json(await SiigoTrialBalanceService.getSyncLogs(conn.id))
})

export const siigoRoutes = app
