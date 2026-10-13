import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z }          from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requirePermission } from '../../middleware/requireRole.js'
import { getEmailSettings, saveEmailSettings, isResendConfigured } from '../../notifications/emailSettings.js'
import { can } from '../../lib/permissions.js'

const app = new Hono()

// Ver la configuración requiere el permiso 'settings' (view).
app.use('/*', authMiddleware, requireModule('settings'))

const emailSettingsSchema = z.object({
  provider: z.enum(['zavu', 'resend']),
  bcc:      z.array(z.string().trim().toLowerCase().email('Correo inválido')).max(10).default([]),
})

// GET /api/settings/email — proveedor de correo y copias ocultas actuales
app.get('/email', async (c) => {
  const settings = await getEmailSettings()
  // canEdit viaja en la respuesta para que el front no dependa de permisos guardados al iniciar sesión
  const canEdit  = await can(c.get('user').role, 'settings', 'update')
  return c.json({ ...settings, resendConfigured: isResendConfigured(), canEdit })
})

// PUT /api/settings/email — cambia el proveedor de correo y las copias ocultas
app.put('/email', requirePermission('settings', 'update'), zValidator('json', emailSettingsSchema), async (c) => {
  const body = c.req.valid('json')

  if (body.provider === 'resend' && !isResendConfigured()) {
    return c.json({ error: 'Resend no está configurado en el servidor (faltan RESEND_API_KEY o RESEND_FROM)' }, 400)
  }

  const saved = await saveEmailSettings(
    { provider: body.provider, bcc: [...new Set(body.bcc)] },
    c.get('user').id,
  )
  return c.json({ ...saved, resendConfigured: isResendConfigured(), canEdit: true })
})

export const settingsRoutes = app
