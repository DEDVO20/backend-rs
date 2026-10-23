import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requirePermission, requireRole } from '../../middleware/requireRole.js'
import { SiigoService } from './siigo.service.js'
import { listSiigoSalesQuerySchema, syncSiigoBodySchema } from './siigo.schema.js'

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
    const user = c.get('user')
    const body = c.req.valid('json')
    const log = await SiigoService.syncFromSiigo(body, user.id)
    return c.json(log)
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

export const siigoRoutes = app
