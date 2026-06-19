import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { supabasePublic, supabase } from '../../lib/supabase.js'
import { authMiddleware }           from '../../middleware/auth.js'
import { getModulesForRole }        from '../../lib/permissions.js'
import { auditAsync }               from '../../lib/audit.js'
import { rateLimiter }              from '../../middleware/rateLimiter.js'

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

// POST /auth/forgot-password
app.post('/forgot-password',
  authLimiter,
  zValidator('json', forgotPasswordSchema),
  async (c) => {
    const { email, redirect_url } = c.req.valid('json')

    const redirectTo = redirect_url ?? `${process.env.PLATFORM_URL}/reset-password`

    const { error } = await supabasePublic.auth.resetPasswordForEmail(email, { redirectTo })

    if (error) {
      return c.json({ error: 'No se pudo enviar el correo de recuperación' }, 500)
    }

    // Siempre 200 para no revelar si el email existe
    return c.json({ message: 'Si el email está registrado, recibirás un correo con instrucciones' })
  },
)

// POST /auth/reset-password
app.post('/reset-password',
  authLimiter,
  zValidator('json', resetPasswordSchema),
  async (c) => {
    const { access_token, password } = c.req.valid('json')

    // Verificar que el token es válido antes de actualizar
    const { data: { user }, error: userError } = await supabasePublic.auth.getUser(access_token)

    if (userError || !user) {
      return c.json({ error: 'Token inválido o expirado' }, 401)
    }

    // Actualizar la contraseña usando el service_role (no requiere sesión activa)
    const { error } = await supabase.auth.admin.updateUserById(user.id, { password })

    if (error) {
      return c.json({ error: 'No se pudo actualizar la contraseña' }, 500)
    }

    // Revocar todas las sesiones activas — los tokens anteriores dejan de funcionar
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
