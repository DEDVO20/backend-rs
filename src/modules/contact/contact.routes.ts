import { Hono }        from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { contactLeadSchema } from './contact.schema.js'
import { contactService }    from './contact.service.js'
import { supabase }          from '../../lib/supabase.js'
import { authMiddleware }    from '../../middleware/auth.js'
import { requireModule, requirePermission } from '../../middleware/requireRole.js'

const app = new Hono()

const updateLeadSchema = z.object({
  status: z.enum(['new', 'contacted', 'converted', 'lost']).optional(),
  notes:  z.string().nullable().optional(),
})

/**
 * POST /contact/lead  (público — no requiere autenticación)
 */
app.post('/lead', zValidator('json', contactLeadSchema), async (c) => {
  const body = c.req.valid('json')
  await contactService.submitLead(body)
  return c.json({ success: true, message: '¡Listo! En breve te contactamos.' }, 201)
})

/**
 * GET /api/contact/leads  (privado — requiere permiso de ver módulo 'leads')
 * Devuelve todos los leads del cotizador ordenados por fecha descendente.
 */
app.get('/leads', authMiddleware, requireModule('leads'), async (c) => {
  const { data, error } = await supabase
    .from('contact_leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

/**
 * PATCH /api/contact/leads/:id  (privado — requiere permiso de actualizar módulo 'leads')
 * Actualiza el estado ('new' | 'contacted' | 'converted' | 'lost') y/o notas de un lead.
 */
app.patch(
  '/leads/:id',
  authMiddleware,
  requirePermission('leads', 'update'),
  zValidator('json', updateLeadSchema),
  async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')

    const { data, error } = await supabase
      .from('contact_leads')
      .update(body)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: 'Lead no encontrado' }, 404)
      }
      return c.json({ error: error.message }, 500)
    }

    return c.json(data)
  }
)

export const contactRoutes = app
