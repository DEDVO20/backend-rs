import type { Context, Next } from 'hono'
import { supabasePublic, supabase } from '../lib/supabase.js'
import type { Role } from '../lib/permissions.js'
import { readAccessToken } from '../lib/authCookies.js'
import { isCompanyInactive } from '../lib/companyStatus.js'

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

// Solo se cachea el perfil. Supabase valida la sesión en cada solicitud.
const AUTH_CACHE_TTL = 60_000
const INTERNAL_ROLES = ['admin', 'rs_admin', 'rs_staff']
const authCache = new Map<string, { user: AuthUser; expires: number }>()

function pruneAuthCache() {
  if (authCache.size < 500) return
  const now = Date.now()
  for (const [k, v] of authCache) {
    if (v.expires < now) authCache.delete(k)
  }
}

export function invalidateAuthCache(token: string) {
  authCache.delete(token)
}

/** Expulsa de la caché a todos los usuarios de una empresa (p. ej. al inactivarla) */
export function invalidateCompanyAuthCache(companyId: string) {
  for (const [token, entry] of authCache) {
    if (entry.user.companyId === companyId) authCache.delete(token)
  }
}

export async function authMiddleware(c: Context, next: Next) {
  const token = readAccessToken(c)

  if (!token) {
    return c.json({ error: 'No autorizado — falta el token' }, 401)
  }

  // Validar JWT con la clave pública (anon) — nunca con service_role
  const { data: { user }, error } = await supabasePublic.auth.getUser(token)

  if (error || !user) {
    invalidateAuthCache(token)
    return c.json({ error: 'Token inválido o expirado' }, 401)
  }

  const cached = authCache.get(token)
  if (cached && cached.expires > Date.now() && cached.user.id === user.id) {
    c.set('user', cached.user)
    return next()
  }

  // Leer role y company_id del perfil
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, company_id, active, companies!profiles_company_id_fkey(status)')
    .eq('id', user.id)
    .single()

  if (profileError || !profile) {
    return c.json({ error: 'Perfil no encontrado' }, 401)
  }

  if (!profile.active) {
    return c.json({ error: 'Usuario inactivo' }, 403)
  }

  // Usuarios de una empresa inactiva pierden el acceso. El personal interno nunca
  // se bloquea, aunque tenga una empresa asociada en su perfil.
  const company = Array.isArray(profile.companies) ? profile.companies[0] : profile.companies
  const isInternal = INTERNAL_ROLES.includes(profile.role)
  if (!isInternal && profile.company_id && isCompanyInactive((company as { status?: string } | null)?.status)) {
    return c.json({
      error: 'La empresa está inactiva. Comunícate con Finto para reactivar el acceso.',
      code:  'COMPANY_INACTIVE',
    }, 403)
  }

  const authUser: AuthUser = {
    id:        user.id,
    role:      profile.role as Role,
    companyId: profile.company_id ?? null,
  }

  pruneAuthCache()
  authCache.set(token, { user: authUser, expires: Date.now() + AUTH_CACHE_TTL })
  c.set('user', authUser)

  await next()
}
