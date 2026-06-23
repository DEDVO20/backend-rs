import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { supabasePublic, supabase } from '../../lib/supabase.js'
import { authMiddleware }           from '../../middleware/auth.js'
import { getModulesForRole }        from '../../lib/permissions.js'
import { auditAsync }               from '../../lib/audit.js'
import { rateLimiter }              from '../../middleware/rateLimiter.js'
import { logger }                   from '../../lib/logger.js'

const app = new Hono()

// 5 intentos por IP cada 15 minutos en rutas sensibles
const authLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: 'auth' })

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
})

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
})

const forgotPasswordSchema = z.object({
  email:        z.string().email(),
  redirect_url: z.string().url().optional(),
})

const resetPasswordSchema = z.object({
  access_token: z.string().min(1),
  password:     z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
})

// POST /auth/login
app.post('/login',
  authLimiter,
  zValidator('json', loginSchema),
  async (c) => {
    const { email, password } = c.req.valid('json')

    const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password })

    if (error || !data.session) {
      return c.json({ error: 'Credenciales inválidas' }, 401)
    }

    auditAsync({ action: 'login', resource: 'auth', resource_id: data.user.id, c,
      metadata: { email: data.user.email } })

    return c.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in:    data.session.expires_in,
      user: {
        id:    data.user.id,
        email: data.user.email,
      },
    })
  },
)

// POST /auth/refresh
app.post('/refresh',
  zValidator('json', refreshSchema),
  async (c) => {
    const { refresh_token } = c.req.valid('json')

    const { data, error } = await supabasePublic.auth.refreshSession({ refresh_token })

    if (error || !data.session) {
      return c.json({ error: 'Refresh token inválido o expirado' }, 401)
    }

    return c.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in:    data.session.expires_in,
      user: {
        id:    data.user!.id,
        email: data.user!.email,
      },
    })
  },
)

// POST /auth/logout
app.post('/logout', authMiddleware, async (c) => {
  const { id } = c.get('user')

  // Revocar todas las sesiones del usuario usando service_role
  const { error } = await supabase.auth.admin.signOut(id)

  if (error) {
    return c.json({ error: 'No se pudo cerrar la sesión' }, 500)
  }

  auditAsync({ action: 'logout', resource: 'auth', resource_id: id, user: c.get('user'), c })

  return c.json({ message: 'Sesión cerrada correctamente' })
})

// POST /auth/forgot-password — genera token y envía email via Zavu
app.post('/forgot-password',
  authLimiter,
  zValidator('json', forgotPasswordSchema),
  async (c) => {
    const { email } = c.req.valid('json')

    const normalizedEmail = email.toLowerCase().trim()

    // Verificar que el usuario existe (sin revelar al cliente)
    const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 })
    if (listErr) {
      logger.error({ err: listErr.message }, 'forgot-password: error listando usuarios')
    }
    const user = listData?.users?.find(u => u.email?.toLowerCase() === normalizedEmail)

    logger.info({ email: normalizedEmail, found: !!user }, 'forgot-password: solicitud recibida')

    if (user) {
      const token = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hora

      // Guardar token en company_invitations (reutilizamos la tabla)
      const { error: insErr } = await supabase.from('company_invitations').insert({
        email: normalizedEmail,
        token,
        role:       'password_reset',
        status:     'pending',
        expires_at: expiresAt,
      })
      if (insErr) {
        logger.error({ err: insErr.message }, 'forgot-password: error guardando token')
      }

      const platformUrl = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'
      const resetUrl = `${platformUrl}/reset-password?token=${token}`

      const { NotificationService } = await import('../../notifications/NotificationService.js')
      try {
        // Envío directo (no cola) — más confiable para acción crítica
        await NotificationService.sendNow({
          channel:  'email',
          template: 'password-reset',
          to:       normalizedEmail,
          data:     { resetUrl, name: user.user_metadata?.full_name ?? '' },
        })
        logger.info({ email: normalizedEmail }, 'forgot-password: email enviado')
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'forgot-password: fallo al enviar email')
      }
    }

    // Siempre 200 para no revelar si el email existe
    return c.json({ message: 'Si el email está registrado, recibirás un correo con instrucciones' })
  },
)

// POST /auth/reset-password — verifica token propio y actualiza contraseña
app.post('/reset-password',
  authLimiter,
  zValidator('json', resetPasswordSchema),
  async (c) => {
    const { access_token: token, password } = c.req.valid('json')

    // Buscar token en company_invitations
    const { data: inv, error: invErr } = await supabase
      .from('company_invitations')
      .select('email')
      .eq('token', token)
      .eq('role', 'password_reset')
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .single()

    if (invErr || !inv) {
      return c.json({ error: 'Token inválido o expirado' }, 401)
    }

    // Buscar usuario por email
    const { data: listData } = await supabase.auth.admin.listUsers()
    const user = listData?.users?.find(u => u.email === inv.email)

    if (!user) {
      return c.json({ error: 'Usuario no encontrado' }, 404)
    }

    // Actualizar contraseña
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password })

    if (error) {
      return c.json({ error: 'No se pudo actualizar la contraseña' }, 500)
    }

    // Marcar token como usado
    await supabase.from('company_invitations')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('token', token)

    // Revocar sesiones activas
    await supabase.auth.admin.signOut(user.id)

    auditAsync({ action: 'update', resource: 'auth', resource_id: user.id, c,
      metadata: { event: 'password_reset' } })

    return c.json({ message: 'Contraseña actualizada correctamente. Todas las sesiones han sido cerradas.' })
  },
)

// GET /auth/me
app.get('/me', authMiddleware, async (c) => {
  const { id, role, companyId } = c.get('user')
  const modules = getModulesForRole(role)
  return c.json({ id, role, companyId, modules })
})

export const authRoutes = app
