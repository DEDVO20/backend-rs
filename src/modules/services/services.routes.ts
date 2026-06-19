import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { supabase }       from '../../lib/supabase.js'

const app = new Hono()

// GET /api/services/public — lista pública (para formulario de registro)
app.get('/public', async (c) => {
  const { data, error } = await supabase
    .from('services')
    .select('id, name, description')
    .eq('active', true)
    .order('name')
  if (error) throw error
  return c.json(data)
})

app.use('/*', authMiddleware)

const createServiceSchema = z.object({
  name:        z.string().min(2),
  description: z.string().optional(),
  active:      z.boolean().default(true),
})

// GET /api/services — listar todos (público autenticado)
app.get('/', async (c) => {
  const active = c.req.query('active')

  let q = supabase
    .from('services')
    .select('*')
    .order('name')
    .limit(200)

  if (active !== undefined) q = q.eq('active', active !== 'false')

  const { data, error } = await q
  if (error) throw error
  return c.json(data)
})

// GET /api/services/:id
app.get('/:id', async (c) => {
  const { data, error } = await supabase
    .from('services')
    .select('*, task_templates(*)')
    .eq('id', c.req.param('id')!)
    .single()

  if (error) throw error
  return c.json(data)
})

// POST /api/services — solo admin/rs_admin
app.post('/',
  requireRole('admin', 'rs_admin'),
  zValidator('json', createServiceSchema),
  async (c) => {
    const { data, error } = await supabase
      .from('services')
      .insert(c.req.valid('json'))
      .select()
      .single()

    if (error) throw error
    return c.json(data, 201)
  },
)

// PATCH /api/services/:id
app.patch('/:id',
  requireRole('admin', 'rs_admin'),
  zValidator('json', createServiceSchema.partial()),
  async (c) => {
    const { data, error } = await supabase
      .from('services')
      .update(c.req.valid('json'))
      .eq('id', c.req.param('id')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

// DELETE /api/services/:id — desactivar (soft)
app.delete('/:id',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const { data, error } = await supabase
      .from('services')
      .update({ active: false })
      .eq('id', c.req.param('id')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

export const servicesRoutes = app
