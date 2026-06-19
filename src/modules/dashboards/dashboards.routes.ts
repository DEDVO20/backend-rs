import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { supabase }       from '../../lib/supabase.js'

const app = new Hono()

app.use('/*', authMiddleware)

const createDashboardSchema = z.object({
  company_id: z.string().uuid(),
  title:      z.string().min(2),
  tool:       z.enum(['powerbi', 'looker']),
  embed_url:  z.string().url(),
  active:     z.boolean().default(true),
})

// GET /api/dashboards — dashboards de la empresa del usuario
app.get('/', async (c) => {
  const { companyId, role } = c.get('user')
  const isInternal = ['admin', 'rs_admin', 'rs_staff'].includes(role)

  let q = supabase
    .from('embedded_dashboards')
    .select('*')
    .eq('active', true)
    .order('title')

  if (!isInternal) {
    if (!companyId) return c.json([])
    q = q.eq('company_id', companyId)
  }

  const { data, error } = await q
  if (error) throw error
  return c.json(data)
})

// GET /api/dashboards/:id
app.get('/:id', async (c) => {
  const { data, error } = await supabase
    .from('embedded_dashboards')
    .select('*')
    .eq('id', c.req.param('id')!)
    .single()

  if (error) throw error
  return c.json(data)
})

// POST /api/dashboards — admin/rs_admin
app.post('/',
  requireRole('admin', 'rs_admin'),
  zValidator('json', createDashboardSchema),
  async (c) => {
    const { data, error } = await supabase
      .from('embedded_dashboards')
      .insert(c.req.valid('json'))
      .select()
      .single()

    if (error) throw error
    return c.json(data, 201)
  },
)

// PATCH /api/dashboards/:id
app.patch('/:id',
  requireRole('admin', 'rs_admin'),
  zValidator('json', createDashboardSchema.partial()),
  async (c) => {
    const { data, error } = await supabase
      .from('embedded_dashboards')
      .update(c.req.valid('json'))
      .eq('id', c.req.param('id')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

// DELETE /api/dashboards/:id — desactivar
app.delete('/:id',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const { data, error } = await supabase
      .from('embedded_dashboards')
      .update({ active: false })
      .eq('id', c.req.param('id')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

export const dashboardsRoutes = app
