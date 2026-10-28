import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requirePermission, requireRole } from '../../middleware/requireRole.js'
import { SiigoService } from './siigo.service.js'
import { SiigoCollectionsService } from './siigo.collections.service.js'
import { logger } from '../../lib/logger.js'
import { validateSiigoConfig } from './siigo.config.js'
import {
  listSiigoCollectionsQuerySchema,
  listSiigoSalesQuerySchema,
  syncSiigoBodySchema,
  syncSiigoCollectionsBodySchema,
  listTrialBalanceQuerySchema,
  syncTrialBalanceBodySchema,
} from './siigo.schema.js'
import { SiigoTrialBalanceService } from './siigo.trialBalance.service.js'

const app = new Hono()

app.use('/*', authMiddleware, requireModule('siigo'))

// GET /api/siigo/sales — consulta de facturas y notas crédito desglosadas por producto
// Roles internos: ven todos los clientes o filtran por empresa/NIT.
// Roles clientes (client_owner, client_user): aislados estrictamente a su propia empresa.
app.get(
  '/sales',
  zValidator('query', listSiigoSalesQuerySchema),
  async (c) => {
    const user = c.get('user')
    const query = c.req.valid('query')
    const result = await SiigoService.listSales(query, user)
    return c.json(result)
  },
)

// GET /api/siigo/report — solo agregados (mensual, por servicio, por cliente) para la vista de gráficas
app.get(
  '/report',
  zValidator('query', listSiigoSalesQuerySchema),
  async (c) => {
    const user = c.get('user')
    const query = c.req.valid('query')
    const result = await SiigoService.getReport(query, user)
    return c.json(result)
  },
)

// GET /api/siigo/export — descarga el informe en formato Excel (.xlsx) con las 3 hojas (INFORME, RESUMEN, LOG)
app.get(
  '/export',
  zValidator('query', listSiigoSalesQuerySchema),
  async (c) => {
    const user = c.get('user')
    const query = c.req.valid('query')
    const { buffer, filename } = await SiigoService.exportExcel(query, user)

    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    c.header('Content-Disposition', `attachment; filename="${filename}"`)
    c.header('Content-Length', String(buffer.byteLength))

    return c.body(new Uint8Array(buffer))
  },
)

// POST /api/siigo/sync — sincroniza documentos desde la API de Siigo (permiso 'create' del módulo)
app.post(
  '/sync',
  requirePermission('siigo', 'create'),
  zValidator('json', syncSiigoBodySchema),
  async (c) => {
    // Corre en segundo plano (puede tardar minutos); el estado se consulta en /sales o /sync-logs
    const configErrors = validateSiigoConfig()
    if (configErrors.length) return c.json({ error: configErrors.join('. ') }, 400)
    if (SiigoService.running) {
      return c.json({ error: 'Ya hay una sincronización con Siigo en curso. Por favor espera a que termine.' }, 409)
    }
    SiigoService.syncFromSiigo(c.req.valid('json'), c.get('user').id).catch(err => {
      logger.error({ err: err.message }, 'Sync de facturación Siigo fallida')
    })
    return c.json({ started: true }, 202)
  },
)

// GET /api/siigo/sync-logs — historial y estado de sincronización con Siigo
app.get(
  '/sync-logs',
  requireRole('admin', 'rs_admin', 'rs_staff', 'contador'),
  async (c) => {
    const result = await SiigoService.getSyncLogs()
    return c.json(result)
  },
)

// ── Recaudo (recibos de caja) ──────────────────────────────────────────────

// GET /api/siigo/collections — detalle de recaudo paginado con resumen (aislado por empresa)
app.get(
  '/collections',
  zValidator('query', listSiigoCollectionsQuerySchema),
  async (c) => {
    const result = await SiigoCollectionsService.listCollections(c.req.valid('query'), c.get('user'))
    return c.json(result)
  },
)

// GET /api/siigo/collections/report — solo agregados de recaudo para la vista de gráficas
app.get(
  '/collections/report',
  zValidator('query', listSiigoCollectionsQuerySchema),
  async (c) => {
    const result = await SiigoCollectionsService.getReport(c.req.valid('query'), c.get('user'))
    return c.json(result)
  },
)

// POST /api/siigo/collections/sync — reprocesa el recaudo desde Siigo en segundo plano
// (puede tardar minutos); el estado se consulta en /collections/sync-logs
app.post(
  '/collections/sync',
  requirePermission('siigo', 'create'),
  zValidator('json', syncSiigoCollectionsBodySchema),
  async (c) => {
    const configErrors = validateSiigoConfig()
    if (configErrors.length) return c.json({ error: configErrors.join('. ') }, 400)
    if (SiigoCollectionsService.running) {
      return c.json({ error: 'Ya hay una sincronización de recaudo en curso. Espera a que termine.' }, 409)
    }
    SiigoCollectionsService.syncFromSiigo(c.req.valid('json'), c.get('user').id).catch(err => {
      logger.error({ err: err.message }, 'Sync de recaudo Siigo fallida')
    })
    return c.json({ started: true }, 202)
  },
)

// GET /api/siigo/collections/sync-logs — historial de sincronización de recaudo
app.get(
  '/collections/sync-logs',
  requireRole('admin', 'rs_admin', 'rs_staff', 'contador'),
  async (c) => c.json(await SiigoCollectionsService.getSyncLogs()),
)

// ── Balance de prueba por tercero (solo roles internos) ────────────────────

const INTERNAL = ['admin', 'rs_admin', 'rs_staff', 'contador'] as const

// GET /api/siigo/trial-balance — un mes: filas paginadas, totales por clase, cuadre y control de periodos
app.get(
  '/trial-balance',
  requireRole(...INTERNAL),
  zValidator('query', listTrialBalanceQuerySchema),
  async (c) => c.json(await SiigoTrialBalanceService.list(c.req.valid('query'))),
)

// GET /api/siigo/trial-balance/report — series para las gráficas (clientes: solo su empresa como tercero)
app.get(
  '/trial-balance/report',
  zValidator('query', listSiigoCollectionsQuerySchema),
  async (c) => c.json(await SiigoTrialBalanceService.getChartsReport(c.req.valid('query'), c.get('user'))),
)

// POST /api/siigo/trial-balance/sync — importa el mes actual o el año completo en segundo plano
app.post(
  '/trial-balance/sync',
  requirePermission('siigo', 'create'),
  zValidator('json', syncTrialBalanceBodySchema),
  async (c) => {
    const configErrors = validateSiigoConfig()
    if (configErrors.length) return c.json({ error: configErrors.join('. ') }, 400)
    if (SiigoTrialBalanceService.running) {
      return c.json({ error: 'Ya hay una importación del balance de prueba en curso. Espera a que termine.' }, 409)
    }
    SiigoTrialBalanceService.syncFromSiigo(c.req.valid('json'), c.get('user').id).catch(err => {
      logger.error({ err: err.message }, 'Importación del balance de prueba fallida')
    })
    return c.json({ started: true }, 202)
  },
)

// GET /api/siigo/trial-balance/sync-logs — historial de importaciones del balance de prueba
app.get(
  '/trial-balance/sync-logs',
  requireRole(...INTERNAL),
  async (c) => c.json(await SiigoTrialBalanceService.getSyncLogs()),
)

export const siigoRoutes = app
