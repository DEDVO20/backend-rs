import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { supabase, supabasePublic } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'

const app = new Hono()

const acceptSchema = z.object({
  token: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().min(2),
})

// POST /invitations/accept
// Acepta una invitación: crea cuenta si no existe, vincula a la empresa
app.post('/accept',
  zValidator('json', acceptSchema),
  async (c) => {
    const { token, email, password, fullName } = c.req.valid('json')

    // 1. Verificar que la invitación existe y está vigente
    const { data: inv, error: invErr } = await supabase
      .from('company_invitations')
      .select('*')
      .eq('token', token)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .single()

    if (invErr || !inv) {
      return c.json({ error: 'Invitación inválida o expirada' }, 400)
    }

    if (inv.email !== email.toLowerCase().trim()) {
      return c.json({ error: 'El email no coincide con la invitación' }, 400)
    }

    // 2. Crear cuenta en Supabase Auth con admin API (sin confirmación de email)
    let userId: string

    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    })

    if (createErr) {
      // Si ya existe, intentar actualizar la contraseña
      const { data: listData } = await supabase.auth.admin.listUsers()
      const existing = listData?.users?.find(u => u.email === email.toLowerCase().trim())
      if (existing) {
        await supabase.auth.admin.updateUserById(existing.id, { password, email_confirm: true })
        userId = existing.id
      } else {
        logger.error({ createErr, email }, 'Error al crear usuario en Auth')
        return c.json({ error: 'No se pudo crear el usuario' }, 400)
      }
    } else {
      userId = createData.user.id
    }

    // 3. Recuperar datos de la invitación para saber role y company_id
    const { data: invData } = await supabase
      .from('company_invitations')
      .select('role, company_id')
      .eq('token', token)
      .single()

    const invRole = invData?.role ?? 'client_user'
    const invCompanyId = invData?.company_id ?? null

    // 4. Crear o actualizar el perfil
    const { error: profileErr } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        email: email.toLowerCase().trim(),
        full_name: fullName,
        role: invRole,
        company_id: invCompanyId,
        active: true,
      }, { onConflict: 'id' })

    if (profileErr) {
      logger.error({ profileErr, userId }, 'Error al crear perfil')
    }

    // 5. Marcar invitación como aceptada
    await supabase
      .from('company_invitations')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('token', token)

    // 6. Intentar la RPC original (puede fallar para admin sin company, lo ignoramos)
    if (invCompanyId) {
      const { error: rpcErr } = await supabase
        .rpc('accept_company_invitation', { p_token: token })
      if (rpcErr) {
        logger.warn({ rpcErr, token }, 'RPC accept_company_invitation falló (perfil ya creado)')
      }
    }

    logger.info({ userId, companyId: invCompanyId, role: invRole }, 'Invitación aceptada')

    return c.json({
      ok: true,
      company_id: invCompanyId,
      role: invRole,
    })
  },
)

// GET /invitations/verify?token=xxx
// Verifica si un token es válido antes de mostrar el formulario de registro
app.get('/verify', async (c) => {
  const token = c.req.query('token')

  if (!token) return c.json({ error: 'Token requerido' }, 400)

  const { data: inv, error } = await supabase
    .from('company_invitations')
    .select('email, expires_at, company_id, role, full_name')
    .eq('token', token)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .single()

  if (error || !inv) {
    return c.json({ valid: false, error: 'Invitación inválida o expirada' }, 400)
  }

  let companyName = ''
  if (inv.company_id) {
    const { data: co } = await supabase.from('companies').select('name').eq('id', inv.company_id).single()
    companyName = co?.name ?? ''
  }

  return c.json({
    valid: true,
    email: inv.email,
    fullName: inv.full_name ?? '',
    companyName: companyName || 'Finto',
    role: inv.role,
    expiresAt: inv.expires_at,
  })
})

export const invitationsRoutes = app
