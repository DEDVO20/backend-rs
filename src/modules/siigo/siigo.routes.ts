import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requirePermission, requireRole } from '../../middleware/requireRole.js'
import { logger } from '../../lib/logger.js'
import { SiigoService } from './siigo.service.js'
import { SiigoCollectionsService } from './siigo.collections.service.js'
import { SiigoTrialBalanceService } from './siigo.trialBalance.service.js'
import { SiigoReceivablesService } from './siigo.receivables.service.js'
import { SiigoConnections } from './siigo.connections.js'
import { monthRanges } from './siigo.helpers.js'
import {
  listReceivablesQuerySchema,
  listSiigoCollectionsQuerySchema,
  receivablesReportQuerySchema,
  listSiigoSalesQuerySchema,
  listTrialBalanceQuerySchema,
  saveSiigoConnectionBodySchema,
  syncLogsQuerySchema,
  syncSiigoBodySchema,
  syncSiigoCollectionsBodySchema,
  syncReceivablesBodySchema,
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
  run: (connId: string) => Promise<unknown>,
  label: string,
) {
  const conn = await SiigoService.connectionFor(connectionId)
  SiigoConnections.client(conn) // valida activa y con credenciales (lanza 400)
  if (isRunning(conn.id)) {
    throw Object.assign(new Error(`Ya hay una sincronización de ${label} en curso para ${conn.label}. Espera a que termine.`), { statusCode: 409 })
  }
  run(conn.id).catch(err => logger.error({ err: err.message, connection: conn.label }, `Sincronización de ${label} Siigo fallida`))
  return { started: true, connectionId: conn.id }
}

/**
 * Importaciones por meses en curso (`tipo:conexión`). Cada bloque de meses seguidos se importa
 * como un rango, uno tras otro; entre rangos la sync del servicio queda libre un instante,
 * así que el lote completo se marca aparte para no aceptar otra importación en medio.
 */
const monthBatches = new Set<string>()

async function runMonthRanges(key: string, year: number, months: number[], runRange: (r: { startDate: string; endDate: string }) => Promise<unknown>) {
  monthBatches.add(key)
  try {
    for (const r of monthRanges(year, months)) await runRange(r)
  } finally {
    monthBatches.delete(key)
  }
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
    const userId = c.get('user').id
    const res = await startInBackground(
      body.connectionId, id => SiigoService.isRunning(id) || monthBatches.has(`sales:${id}`),
      connId => body.mode === 'months'
        ? runMonthRanges(`sales:${connId}`, body.year!, body.months!, r =>
          SiigoService.syncFromSiigo({ ...body, mode: 'range', startDate: r.startDate, endDate: r.endDate }, userId))
        : SiigoService.syncFromSiigo(body, userId),
      'facturación',
    )
    return c.json(res, 202)
  },
)

// GET /api/siigo/sync-logs?connectionId — historial de sincronización de facturación
app.get('/sync-logs', requireRole(...INTERNAL), zValidator('query', syncLogsQuerySchema), async (c) => {
  const conn = await SiigoService.connectionFor(c.req.valid('query').connectionId)
  const r = await SiigoService.getSyncLogs(conn.id)
  return c.json({ ...r, isSyncRunning: r.isSyncRunning || monthBatches.has(`sales:${conn.id}`) })
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
    const userId = c.get('user').id
    const res = await startInBackground(
      body.connectionId, id => SiigoCollectionsService.isRunning(id) || monthBatches.has(`collections:${id}`),
      connId => body.months?.length
        ? runMonthRanges(`collections:${connId}`, body.year!, body.months, r =>
          SiigoCollectionsService.syncFromSiigo({ connectionId: body.connectionId, startDate: r.startDate, endDate: r.endDate }, userId))
        : SiigoCollectionsService.syncFromSiigo(body, userId),
      'recaudo',
    )
    return c.json(res, 202)
  },
)

app.get('/collections/sync-logs', requireRole(...INTERNAL), zValidator('query', syncLogsQuerySchema), async (c) => {
  const conn = await SiigoService.connectionFor(c.req.valid('query').connectionId)
  const r = await SiigoCollectionsService.getSyncLogs(conn.id)
  return c.json({ ...r, isSyncRunning: r.isSyncRunning || monthBatches.has(`collections:${conn.id}`) })
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

// ── Cartera (facturas con saldo, solo gráficas; independiente del módulo de cobro) ──

// GET /api/siigo/receivables — detalle de facturas con saldo (clientes: su propia empresa)
app.get('/receivables', zValidator('query', listReceivablesQuerySchema), async (c) =>
  c.json(await SiigoReceivablesService.list(c.req.valid('query'), c.get('user'))),
)

// GET /api/siigo/receivables/report — edades, clientes, vendedores y evolución de la cartera
app.get('/receivables/report', zValidator('query', receivablesReportQuerySchema), async (c) =>
  c.json(await SiigoReceivablesService.getReport(c.req.valid('query'), c.get('user'))),
)

app.post(
  '/receivables/sync',
  requirePermission('siigo', 'create'),
  zValidator('json', syncReceivablesBodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const res = await startInBackground(
      body.connectionId, id => SiigoReceivablesService.isRunning(id),
      () => SiigoReceivablesService.syncFromSiigo(body, c.get('user').id), 'cartera',
    )
    return c.json(res, 202)
  },
)

app.get('/receivables/sync-logs', requireRole(...INTERNAL), zValidator('query', syncLogsQuerySchema), async (c) => {
  const conn = await SiigoService.connectionFor(c.req.valid('query').connectionId)
  return c.json(await SiigoReceivablesService.getSyncLogs(conn.id))
})

export const siigoRoutes = app
