import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule }  from '../../middleware/requireRole.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { RequestsService } from './requests.service.js'
import {
  createRequestSchema,
  updateRequestSchema,
  listRequestsQuerySchema,
} from './requests.schema.js'

const INTERNAL_ROLES = ['admin', 'rs_admin', 'rs_staff'] as const

const app = new Hono()

app.use('/*', authMiddleware, requireModule('operational_requests'))

// GET /api/requests/types — catálogo de tipos de solicitud
app.get('/types', async (c) => {
  const data = await RequestsService.listTypes()
  return c.json(data)
})

// GET /api/requests
app.get('/',
  zValidator('query', listRequestsQuerySchema),
  async (c) => {
    const { role, companyId } = c.get('user')
    const isInternal = (INTERNAL_ROLES as readonly string[]).includes(role)
    const result = await RequestsService.list(c.req.valid('query'), companyId, isInternal)
    return c.json(result)
  },
)

// GET /api/requests/:id
app.get('/:id', async (c) => {
  const data = await RequestsService.getById(c.req.param('id')!)
  return c.json(data)
})

// POST /api/requests — cualquier rol autenticado con acceso al módulo
app.post('/',
  zValidator('json', createRequestSchema),
  async (c) => {
    const { id, companyId, role } = c.get('user')
    const isStaff = (INTERNAL_ROLES as readonly string[]).includes(role)
    // Admins pueden crear solicitudes sin empresa (se asigna después)
    const data = await RequestsService.create(c.req.valid('json'), id, companyId ?? null)
    return c.json(data, 201)
  },
)

// PATCH /api/requests/:id — solo roles internos asignan/resuelven
app.patch('/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', updateRequestSchema),
  async (c) => {
    const data = await RequestsService.update(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// DELETE /api/requests/:id — solo roles internos
app.delete('/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const { supabase } = await import('../../lib/supabase.js')
    const { error } = await supabase.from('operational_requests').delete().eq('id', c.req.param('id')!)
    if (error) throw error
    return c.json({ ok: true })
  },
)

export const requestsRoutes = app
