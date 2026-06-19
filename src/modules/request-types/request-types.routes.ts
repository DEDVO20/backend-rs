import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { supabase }       from '../../lib/supabase.js'

const app = new Hono()

app.use('/*', authMiddleware)

const createTypeSchema = z.object({
  code:                          z.string().min(2).toUpperCase(),
  name:                          z.string().min(2),
  description:                   z.string().optional(),
  service_id:                    z.string().uuid().optional(),
  active:                        z.boolean().default(true),
  default_sla_hours:             z.number().int().positive().optional(),
  default_included_monthly_limit: z.number().int().min(0).optional(),
  default_billable_over_limit:   z.boolean().default(false),
  default_over_limit_fee:        z.number().min(0).optional(),
})

// GET /api/request-types
app.get('/', async (c) => {
  const serviceId = c.req.query('service_id')
  const active    = c.req.query('active')

  let q = supabase
    .from('operational_request_types')
    .select('*, services(name)')
    .order('name')
    .limit(200)

  if (serviceId) q = q.eq('service_id', serviceId)
  if (active !== undefined) q = q.eq('active', active !== 'false')

  const { data, error } = await q
  if (error) throw error
  return c.json(data)
})

// GET /api/request-types/:id
app.get('/:id', async (c) => {
  const { data, error } = await supabase
    .from('operational_request_types')
    .select('*, services(name)')
    .eq('id', c.req.param('id')!)
    .single()

  if (error) throw error
  return c.json(data)
})

// POST /api/request-types — admin/rs_admin
app.post('/',
  requireRole('admin', 'rs_admin'),
  zValidator('json', createTypeSchema),
  async (c) => {
    const { data, error } = await supabase
      .from('operational_request_types')
      .insert(c.req.valid('json'))
      .select()
      .single()

    if (error) throw error
    return c.json(data, 201)
  },
)

// PATCH /api/request-types/:id
app.patch('/:id',
  requireRole('admin', 'rs_admin'),
  zValidator('json', createTypeSchema.partial()),
  async (c) => {
    const { data, error } = await supabase
      .from('operational_request_types')
      .update(c.req.valid('json'))
      .eq('id', c.req.param('id')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

// GET /api/request-types/company/:companyId/policies — políticas de solicitud por empresa
app.get('/company/:companyId/policies', async (c) => {
  const { data, error } = await supabase
    .from('company_request_policies')
    .select('*, operational_request_types(code, name), services(name)')
    .eq('company_id', c.req.param('companyId')!)
    .eq('active', true)
    .order('created_at')

  if (error) throw error
  return c.json(data)
})

// POST /api/request-types/company/:companyId/policies — crear política para empresa
app.post('/company/:companyId/policies',
  requireRole('admin', 'rs_admin'),
  zValidator('json', z.object({
    request_type_id:         z.string().uuid(),
    service_id:              z.string().uuid().optional(),
    sla_hours:               z.number().int().positive().optional(),
    included_monthly_limit:  z.number().int().min(0).optional(),
    billable_over_limit:     z.boolean().default(false),
    over_limit_fee:          z.number().min(0).optional(),
    start_date:              z.string().date().optional(),
    end_date:                z.string().date().optional(),
  })),
  async (c) => {
    const { data, error } = await supabase
      .from('company_request_policies')
      .insert({
        company_id: c.req.param('companyId')!,
        ...c.req.valid('json'),
      })
      .select()
      .single()

    if (error) throw error
    return c.json(data, 201)
  },
)

export const requestTypesRoutes = app
