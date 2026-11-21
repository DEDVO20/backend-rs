import { Hono }         from 'hono'
import { createHash }   from 'node:crypto'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { supabasePublic, supabase } from '../../lib/supabase.js'
import { authMiddleware, invalidateAuthCache } from '../../middleware/auth.js'
import { getModulesForRole, getPermissionsForRole } from '../../lib/permissions.js'
import { auditAsync }               from '../../lib/audit.js'
import { rateLimiter }              from '../../middleware/rateLimiter.js'
import { logger }                   from '../../lib/logger.js'
import { setAuthCookies, clearAuthCookies, readAccessToken, readRefreshToken } from '../../lib/authCookies.js'
import { findAuthAccount } from '../../lib/authAccount.js'

const app = new Hono()

// 5 intentos por IP cada 15 minutos en rutas sensibles
const authLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5, keyPrefix: 'auth' })

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
})

const forgotPasswordSchema = z.object({
  email:        z.string().email(),
  redirect_url: z.string().url().optional(),
})

const resetPasswordSchema = z.object({
  access_token: z.string().uuid(),
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
      // Motivo real solo en logs (invalid_credentials, email_not_confirmed, user_banned…);
      // al cliente siempre el mismo mensaje para no revelar si el correo existe.
      logger.warn({ email, code: error?.code ?? 'no_session', status: error?.status, msg: error?.message }, 'login rechazado por Supabase')
      return c.json({ error: 'Credenciales inválidas' }, 401)
    }

    auditAsync({ action: 'login', resource: 'auth', resource_id: data.user.id, c,
      metadata: { email: data.user.email } })

    // Los tokens NO van en el body: solo en cookies httpOnly
    setAuthCookies(c, data.session)

    return c.json({
      expires_in: data.session.expires_in,
      user: {
        id:    data.user.id,
        email: data.user.email,
      },
    })
  },
)

// POST /auth/refresh — lee el refresh token de la cookie httpOnly
app.post('/refresh', async (c) => {
  const refresh_token = readRefreshToken(c)
  if (!refresh_token) {
    return c.json({ error: 'Sesión expirada' }, 401)
  }

  const { data, error } = await supabasePublic.auth.refreshSession({ refresh_token })

  if (error || !data.session) {
    clearAuthCookies(c)
    return c.json({ error: 'Refresh token inválido o expirado' }, 401)
  }

  setAuthCookies(c, data.session)

  return c.json({
    expires_in: data.session.expires_in,
    user: {
      id:    data.user!.id,
      email: data.user!.email,
    },
  })
})

// POST /auth/logout — siempre limpia las cookies, aunque el access token ya haya expirado
app.post('/logout', async (c) => {
  const token = readAccessToken(c)

  if (token) {
    invalidateAuthCache(token)
    const { data: { user } } = await supabasePublic.auth.getUser(token)
    if (user) {
      // admin.signOut recibe el JWT de la sesión (no el id del usuario)
      const { error } = await supabase.auth.admin.signOut(token, 'global')
      if (error) logger.warn({ err: error.message, userId: user.id }, 'logout: no se pudo revocar la sesión')
      auditAsync({ action: 'logout', resource: 'auth', resource_id: user.id, c })
    }
  }

  clearAuthCookies(c)
  return c.json({ message: 'Sesión cerrada correctamente' })
})

// POST /auth/forgot-password — genera token y envía email via Zavu
app.post('/forgot-password',
  authLimiter,
  zValidator('json', forgotPasswordSchema),
  async (c) => {
    const { email } = c.req.valid('json')

    const normalizedEmail = email.toLowerCase().trim()

    try {
      const userId = await findAuthAccount(normalizedEmail)
      if (userId) {
        const token = crypto.randomUUID()
        const { error } = await supabase.from('password_recovery_tokens').insert({
          email: normalizedEmail,
          token_hash: createHash('sha256').update(token).digest('hex'),
          user_id: userId,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
        if (error) throw error

        const platformUrl = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'
        const { NotificationService } = await import('../../notifications/NotificationService.js')
        await NotificationService.sendNow({
          channel: 'email',
          template: 'password-reset',
          to: normalizedEmail,
          data: { resetUrl: `${platformUrl}/reset-password?token=${token}` },
        })
      }
    } catch {
      logger.error('forgot-password: no se pudo generar o enviar el enlace')
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

    const { data: userId, error: claimError } = await supabase.rpc('claim_password_recovery', { p_token: token })
    if (claimError) throw claimError
    if (!userId) return c.json({ error: 'Enlace inválido o expirado' }, 401)

    // Supabase Auth cambia la contraseña y revoca las sesiones en la misma transacción.
    const { error } = await supabase.auth.admin.updateUserById(userId, { password })
    if (error) {
      logger.warn({ code: error.code, userId }, 'reset-password: no se pudo actualizar la cuenta')
      return c.json({ error: 'No se pudo actualizar la contraseña. Solicita un nuevo enlace.' }, 500)
    }

    auditAsync({ action: 'update', resource: 'auth', resource_id: userId, c,
      metadata: { event: 'password_reset' } })

    return c.json({ message: 'Contraseña actualizada correctamente. Todas las sesiones han sido cerradas.' })
  },
)

// GET /auth/me
app.get('/me', authMiddleware, async (c) => {
  const { id, role, companyId } = c.get('user')
  const [modules, permissions] = await Promise.all([
    getModulesForRole(role),
    getPermissionsForRole(role),
  ])
  return c.json({ id, role, companyId, modules, permissions })
})

export const authRoutes = app
