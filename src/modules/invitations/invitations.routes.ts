import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { supabase, supabasePublic } from '../../lib/supabase.js'
import { findAuthAccount } from '../../lib/authAccount.js'
import { readAccessToken } from '../../lib/authCookies.js'
import { logger } from '../../lib/logger.js'
import { rateLimiter } from '../../middleware/rateLimiter.js'
import { invitedCompanyName, requireLinkableProfile } from './invitations.service.js'

const app = new Hono()
app.use('*', rateLimiter({ windowMs: 60_000, max: 20, keyPrefix: 'invitations' }))

const tokenSchema = z.string().uuid()
const acceptSchema = z.object({
  token: tokenSchema,
  email: z.string().email(),
  password: z.string().min(6).optional(),
  fullName: z.string().trim().max(160).optional(),
})

async function findPendingInvitation(token: string) {
  const { data, error } = await supabase.from('company_invitations')
    .select('email, expires_at, company_id, role, full_name')
    .eq('token', token)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (error) throw error
  return data?.role === 'password_reset' ? null : data
}

app.post('/accept', zValidator('json', acceptSchema), async (c) => {
  const { token, password, fullName } = c.req.valid('json')
  const email = c.req.valid('json').email.toLowerCase().trim()
  const invite = await findPendingInvitation(token)
  if (!invite || invite.email !== email) {
    return c.json({ error: 'Invitación inválida o expirada' }, 400)
  }

  const companyId = invite.company_id ?? null
  const role = invite.role ?? 'client_user'
  const accountId = await findAuthAccount(email)
  let profile: Awaited<ReturnType<typeof requireLinkableProfile>> = null
  if (accountId) {
    const accessToken = readAccessToken(c)
    const session = accessToken ? await supabasePublic.auth.getUser(accessToken) : null
    const user = session?.data.user
    if (session?.error || !user?.email_confirmed_at || user.id !== accountId || user.email?.toLowerCase() !== email) {
      return c.json({ error: 'Inicia sesión con el correo de la invitación para continuar', code: 'INVITATION_LOGIN_REQUIRED' }, 401)
    }
    profile = await requireLinkableProfile(accountId, companyId, role)
  } else if (!password) {
    return c.json({ error: 'La contraseña es obligatoria al crear una cuenta' }, 400)
  }
  await invitedCompanyName(companyId)

  // Un UPDATE condicional garantiza que solo una solicitud puede usar este enlace.
  const now = new Date().toISOString()
  const { data: claimed, error: claimError } = await supabase.from('company_invitations')
    .update({ status: 'accepted', accepted_at: now })
    .eq('token', token)
    .eq('status', 'pending')
    .gt('expires_at', now)
    .select('token')
    .maybeSingle()
  if (claimError) throw claimError
  if (!claimed) return c.json({ error: 'Invitación inválida o expirada' }, 400)

  const name = invite.full_name?.trim() || fullName || email.split('@')[0]!
  if (accountId) {
    if (profile) {
      const update = supabase.from('profiles').update({ active: true })
        .eq('id', accountId).eq('active', false).eq('role', role)
      const scoped = companyId ? update.eq('company_id', companyId) : update.is('company_id', null)
      const { data, error } = await scoped.select('id').maybeSingle()
      if (error) throw error
      if (!data) return c.json({ error: 'La cuenta cambió. Comunícate con Finto para revisar la invitación.' }, 409)
    } else {
      const { error } = await supabase.from('profiles')
        .insert({ id: accountId, email, full_name: name, role, company_id: companyId, active: true })
      if (error) throw error
    }
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: password!,
      email_confirm: true,
      user_metadata: { full_name: name },
    })
    if (error || !data.user) {
      logger.warn({ code: error?.code }, 'No se pudo crear la cuenta invitada')
      return c.json({ error: 'No se pudo crear la cuenta. Solicita una nueva invitación.' }, 409)
    }
    const { error: profileError } = await supabase.from('profiles').upsert({
      id: data.user.id, email, full_name: name, role, company_id: companyId, active: true,
    }, { onConflict: 'id' })
    if (profileError) throw profileError
  }

  logger.info({ companyId, role }, 'Invitación aceptada')
  return c.json({ ok: true, company_id: companyId, role })
})

app.get('/verify', async (c) => {
  c.header('Cache-Control', 'no-store')
  const parsed = tokenSchema.safeParse(c.req.query('token'))
  if (!parsed.success) return c.json({ valid: false, error: 'Invitación inválida o expirada' }, 400)

  const invite = await findPendingInvitation(parsed.data)
  if (!invite) return c.json({ valid: false, error: 'Invitación inválida o expirada' }, 400)

  const [companyName, accountId] = await Promise.all([
    invitedCompanyName(invite.company_id ?? null),
    findAuthAccount(invite.email),
  ])
  return c.json({
    valid: true,
    email: invite.email,
    fullName: invite.full_name ?? '',
    companyName,
    role: invite.role,
    expiresAt: invite.expires_at,
    requiresLogin: Boolean(accountId),
  })
})

export const invitationsRoutes = app
