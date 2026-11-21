import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import { isCompanyInactive } from '../../lib/companyStatus.js'
import { findAuthAccount } from '../../lib/authAccount.js'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 días (el correo lo indica)

export class InvitationError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message)
  }
}

export type CreateInvitationInput = {
  email:     string
  fullName?: string | null
  role:      string
  /** null = personal administrativo de Finto */
  companyId: string | null
  invitedBy?: string | null
  fromOnboarding?: boolean
}

/**
 * Crea una invitación con token y envía el correo para que la persona cree su
 * contraseña en /invitations/accept. Sirve para personal interno (companyId null)
 * y para dueños/usuarios de una empresa cliente.
 * Si ya había una invitación pendiente para ese correo, se cancela (equivale a reenviar).
 */
export async function createInvitation(input: CreateInvitationInput) {
  const email = input.email.toLowerCase().trim()

  // Una persona activa no se puede mover de empresa con una invitación:
  // al aceptarla se le reasignaría el rol y la empresa.
  const accountId = await findAuthAccount(email)
  if (accountId) await requireLinkableProfile(accountId, input.companyId, input.role)

  const companyName = await invitedCompanyName(input.companyId)

  const cancel = supabase
    .from('company_invitations')
    .update({ status: 'cancelled' })
    .eq('email', email)
    .eq('status', 'pending')
    .or('role.is.null,role.neq.password_reset')
  const { error: cancelErr } = await (input.companyId ? cancel.eq('company_id', input.companyId) : cancel.is('company_id', null))
  if (cancelErr) throw cancelErr

  const token     = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString()

  const { error: insErr } = await supabase.from('company_invitations').insert({
    email,
    full_name:  input.fullName?.trim() || null,
    role:       input.role,
    company_id: input.companyId,
    invited_by: input.invitedBy ?? null,
    token,
    status:     'pending',
    expires_at: expiresAt,
  })
  if (insErr) {
    if (insErr.code === '23505') throw new InvitationError('Ya existe una invitación pendiente para ese email', 409)
    throw insErr
  }

  const platformUrl = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'
  const inviteUrl = `${platformUrl}/invitations/accept?token=${token}`
  const name = input.fullName?.trim() || null
  await NotificationService.enqueue({
    channel:  'email',
    template: input.fromOnboarding ? 'kyc-approved' : 'invitation',
    to:       email,
    data: input.fromOnboarding
      ? { ownerName: name, companyName, platformUrl: inviteUrl }
      : { name, companyName, inviteUrl },
    ...(input.companyId ? { companyId: input.companyId } : {}),
  })

  logger.info({ email, role: input.role, companyId: input.companyId }, 'Invitación creada')
  return { ok: true, email, role: input.role, company_id: input.companyId, expires_at: expiresAt }
}

export async function invitedCompanyName(companyId: string | null): Promise<string> {
  if (!companyId) return 'Finto'
  const { data, error } = await supabase.from('companies').select('name, status')
    .eq('id', companyId).maybeSingle()
  if (error) throw error
  if (!data) throw new InvitationError('Empresa no encontrada', 404)
  if (isCompanyInactive(data.status)) throw new InvitationError('La empresa está inactiva; reactívala antes de invitar usuarios', 409)
  return data.name
}

// Una invitación puede recuperar una membresía desactivada de la misma empresa.
// Los cambios de empresa se gestionan desde la administración de perfiles.
export async function requireLinkableProfile(userId: string, companyId: string | null, role: string) {
  const { data, error } = await supabase.from('profiles').select('id, company_id, role, active')
    .eq('id', userId).maybeSingle()
  if (error) throw error
  if (data && (data.company_id ?? null) !== companyId) {
    throw new InvitationError('Este correo ya está vinculado a otra empresa o al equipo interno', 409)
  }
  if (data?.active) {
    throw new InvitationError('Esta persona ya tiene una cuenta activa en esta empresa', 409)
  }
  if (data && data.role !== role) {
    throw new InvitationError('Cambia el rol desde la administración de perfiles antes de reenviar una invitación', 409)
  }
  return data
}

/** Invitaciones pendientes y vigentes de una empresa */
export async function listPendingInvitations(companyId: string) {
  const { data, error } = await supabase
    .from('company_invitations')
    .select('email, full_name, role, expires_at, created_at')
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}
