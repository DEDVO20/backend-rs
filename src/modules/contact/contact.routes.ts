import { Hono }        from 'hono'
import { zValidator } from '@hono/zod-validator'
import { contactLeadSchema } from './contact.schema.js'
import { contactService }    from './contact.service.js'

const app = new Hono()

/**
 * POST /contact/lead  (público — no requiere autenticación)
 * Recibe los datos del formulario del landing page y notifica al equipo Finto.
 */
app.post('/lead', zValidator('json', contactLeadSchema), async (c) => {
  const body = c.req.valid('json')
  await contactService.submitLead(body)
  return c.json({ success: true, message: '¡Listo! En breve te contactamos.' }, 201)
})

export const contactRoutes = app
