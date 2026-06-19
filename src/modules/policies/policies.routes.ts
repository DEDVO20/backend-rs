import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { supabase }       from '../../lib/supabase.js'

const app = new Hono()

const policyTypeEnum = z.enum([
  'terms_of_service','privacy_policy','data_processing','service_agreement','sarlaft',
])

const createPolicySchema = z.object({
  policy_type:    policyTypeEnum,
  version:        z.string().min(1),
  title:          z.string().min(2),
  content:        z.string().min(10),
  content_hash:   z.string().min(8),
  effective_date: z.string().date(),
  active:         z.boolean().default(true),
})

// GET /api/policies — listar versiones activas (público)
app.get('/', async (c) => {
  const type = c.req.query('type')

  let q = supabase
    .from('policy_versions')
    .select('id, policy_type, version, title, effective_date, active, created_at')
    .order('effective_date', { ascending: false })
    .limit(200)

  if (type) q = q.eq('policy_type', type)

  const { data, error } = await q
  if (error) throw error
  return c.json(data)
})

// GET /api/policies/active — una versión activa por tipo
app.get('/active', async (c) => {
  const { data, error } = await supabase
    .from('policy_versions')
    .select('*')
    .eq('active', true)
    .order('policy_type')

  if (error) throw error
  return c.json(data)
})

// GET /api/policies/:id — detalle con contenido completo
app.get('/:id', async (c) => {
  const { data, error } = await supabase
    .from('policy_versions')
    .select('*')
    .eq('id', c.req.param('id')!)
    .single()

  if (error) throw error
  return c.json(data)
})

// POST /api/policies — crear nueva versión (admin/rs_admin)
app.post('/',
  authMiddleware,
  requireRole('admin', 'rs_admin'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const body = c.req.valid('json')

    // Si es activa, desactivar la anterior del mismo tipo
    if (body.active) {
      await supabase
        .from('policy_versions')
        .update({ active: false })
        .eq('policy_type', body.policy_type)
        .eq('active', true)
    }

    const { data, error } = await supabase
      .from('policy_versions')
      .insert({ ...body, created_by: c.get('user')?.id })
      .select()
      .single()

    if (error) throw error
    return c.json(data, 201)
  },
)

// PATCH /api/policies/:id/activate — activar una versión
app.patch('/:id/activate',
  authMiddleware,
  requireRole('admin', 'rs_admin'),
  async (c) => {
    // Obtener el tipo de la política
    const { data: policy, error: fetchErr } = await supabase
      .from('policy_versions')
      .select('policy_type')
      .eq('id', c.req.param('id')!)
      .single()

    if (fetchErr || !policy) return c.json({ error: 'Política no encontrada' }, 404)

    // Desactivar la activa actual
    await supabase
      .from('policy_versions')
      .update({ active: false })
      .eq('policy_type', policy.policy_type)
      .eq('active', true)

    // Activar la nueva
    const { data, error } = await supabase
      .from('policy_versions')
      .update({ active: true })
      .eq('id', c.req.param('id')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

export const policiesRoutes = app
