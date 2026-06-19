import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { supabase }       from '../../lib/supabase.js'

const app = new Hono()

app.use('/*', authMiddleware)

const assignServiceSchema = z.object({
  service_id:          z.string().uuid(),
  start_date:          z.string().date().optional(),
  end_date:            z.string().date().optional(),
  responsible_user_id: z.string().uuid().optional(),
})

// GET /api/company-services/:companyId — servicios activos de una empresa
app.get('/:companyId', async (c) => {
  const { data, error } = await supabase
    .from('company_services')
    .select('*, services(id, name, description)')
    .eq('company_id', c.req.param('companyId')!)
    .eq('active', true)
    .order('created_at')

  if (error) throw error
  return c.json(data)
})

// POST /api/company-services/:companyId — asignar servicio a empresa
app.post('/:companyId',
  requireRole('admin', 'rs_admin'),
  zValidator('json', assignServiceSchema),
  async (c) => {
    const { data, error } = await supabase
      .from('company_services')
      .upsert(
        { ...c.req.valid('json'), company_id: c.req.param('companyId')!, active: true },
        { onConflict: 'company_id,service_id' },
      )
      .select('*, services(name)')
      .single()

    if (error) throw error
    return c.json(data, 201)
  },
)

// PATCH /api/company-services/:companyId/:serviceId — actualizar asignación
app.patch('/:companyId/:serviceId',
  requireRole('admin', 'rs_admin'),
  zValidator('json', assignServiceSchema.partial()),
  async (c) => {
    const { data, error } = await supabase
      .from('company_services')
      .update(c.req.valid('json'))
      .eq('company_id', c.req.param('companyId')!)
      .eq('service_id', c.req.param('serviceId')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

// DELETE /api/company-services/:companyId/:serviceId — desactivar servicio
app.delete('/:companyId/:serviceId',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const { data, error } = await supabase
      .from('company_services')
      .update({ active: false, end_date: new Date().toISOString().split('T')[0] })
      .eq('company_id', c.req.param('companyId')!)
      .eq('service_id', c.req.param('serviceId')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

export const companyServicesRoutes = app
