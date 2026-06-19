import type { Context, Next } from 'hono'
import { supabasePublic, supabase } from '../lib/supabase.js'
import type { Role } from '../lib/permissions.js'

export type AuthUser = {
  id:        string
  role:      Role
  companyId: string | null
}

// Extiende el contexto de Hono con el usuario autenticado
declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')

  if (!token) {
    return c.json({ error: 'No autorizado — falta el token' }, 401)
  }

  // Validar JWT con la clave pública (anon) — nunca con service_role
  const { data: { user }, error } = await supabasePublic.auth.getUser(token)

  if (error || !user) {
    return c.json({ error: 'Token inválido o expirado' }, 401)
  }

  // Leer role y company_id del perfil
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, company_id, active')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    return c.json({ error: 'Perfil no encontrado' }, 401)
  }

  if (!profile.active) {
    return c.json({ error: 'Usuario inactivo' }, 403)
  }

  c.set('user', {
    id:        user.id,
    role:      profile.role as Role,
    companyId: profile.company_id ?? null,
  })

  await next()
}
