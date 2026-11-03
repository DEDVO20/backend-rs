import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware }    from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/requireRole.js'
import { supabase }          from '../../lib/supabase.js'

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
  name:        z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  active:      z.boolean().default(true),
})

/** ¿Existe otro servicio con el mismo nombre (sin distinguir mayúsculas)? */
async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  // Escapar comodines de ILIKE para comparar el nombre literal
  let q = supabase
    .from('services')
    .select('id')
    .ilike('name', name.replace(/[%_\\]/g, '\\$&'))
    .limit(1)
  if (exceptId) q = q.neq('id', exceptId)
  const { data, error } = await q
  if (error) throw error
  return (data ?? []).length > 0
}

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

// GET /api/services/stats — uso de cada servicio (empresas activas y plantillas).
// DEBE ir antes de /:id.
app.get('/stats', async (c) => {
  const [cs, tt] = await Promise.all([
    supabase.from('company_services').select('service_id').eq('active', true),
    supabase.from('task_templates').select('service_id, active'),
  ])
  if (cs.error) throw cs.error
  if (tt.error) throw tt.error

  const stats: Record<string, { companies: number; templates: number; active_templates: number }> = {}
  const get = (id: string) => (stats[id] ??= { companies: 0, templates: 0, active_templates: 0 })
  for (const r of cs.data ?? []) if (r.service_id) get(r.service_id).companies++
  for (const r of tt.data ?? []) {
    if (!r.service_id) continue
    const s = get(r.service_id)
    s.templates++
    if (r.active) s.active_templates++
  }
  return c.json(stats)
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

// POST /api/services
app.post('/',
  requirePermission('services_admin', 'create'),
  zValidator('json', createServiceSchema),
  async (c) => {
    const body = c.req.valid('json')
    if (await nameTaken(body.name)) return c.json({ error: 'Ya existe un servicio con ese nombre' }, 409)

    const { data, error } = await supabase
      .from('services')
      .insert(body)
      .select()
      .single()

    if (error) throw error
    return c.json(data, 201)
  },
)

// PATCH /api/services/:id
app.patch('/:id',
  requirePermission('services_admin', 'update'),
  zValidator('json', createServiceSchema.partial()),
  async (c) => {
    const id = c.req.param('id')!
    const body = c.req.valid('json')
    if (body.name && await nameTaken(body.name, id)) return c.json({ error: 'Ya existe un servicio con ese nombre' }, 409)

    const { data, error } = await supabase
      .from('services')
      .update(body)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

// DELETE /api/services/:id — desactivar (soft); las asignaciones existentes se conservan
app.delete('/:id',
  requirePermission('services_admin', 'delete'),
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
