import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/env.js', () => ({ env: {} }))
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const enqueue = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/notifications/NotificationService.js', () => ({
  NotificationService: { enqueue: (...a: unknown[]) => enqueue(...a) },
}))

// Estado configurable por test
let profile: { id: string; company_id: string | null; active: boolean; role: string } | null = null
let company: { name: string } | null = { name: 'Constructora ABC' }
const cancelUpdate = vi.fn()
const inserted: Record<string, unknown>[] = []

vi.mock('../src/lib/supabase.js', () => {
  const tables: Record<string, () => any> = {
    profiles: () => {
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: profile, error: null }) }
      return q
    },
    companies: () => {
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: company, error: null }) }
      return q
    },
    company_invitations: () => ({
      update: (v: unknown) => {
        cancelUpdate(v)
        const q: any = { eq: () => q, or: () => q, is: () => q, then: (r: any) => r({ error: null }) }
        return q
      },
      insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null } },
    }),
  }
  return { supabase: { from: (t: string) => tables[t](), rpc: async () => ({ data: profile?.id ?? null }) } }
})

import { createInvitation, InvitationError } from '../src/modules/invitations/invitations.service.js'

beforeEach(() => {
  profile = null
  company = { name: 'Constructora ABC' }
  inserted.length = 0
  cancelUpdate.mockClear()
  enqueue.mockClear()
})

describe('createInvitation', () => {
  it('invita al dueño de una empresa: cancela la pendiente, guarda el token y envía el correo', async () => {
    const res = await createInvitation({
      email: '  Jorge@Empresa.co ', fullName: 'Jorge Rodríguez', role: 'client_owner', companyId: 'co-1', invitedBy: 'admin-1',
    })

    expect(res).toMatchObject({ ok: true, email: 'jorge@empresa.co', role: 'client_owner', company_id: 'co-1' })
    expect(cancelUpdate).toHaveBeenCalledWith({ status: 'cancelled' })
    expect(inserted[0]).toMatchObject({
      email: 'jorge@empresa.co', full_name: 'Jorge Rodríguez', role: 'client_owner',
      company_id: 'co-1', invited_by: 'admin-1', status: 'pending',
    })
    const token = inserted[0].token as string
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      template: 'invitation',
      to: 'jorge@empresa.co',
      companyId: 'co-1',
      data: expect.objectContaining({ companyName: 'Constructora ABC', inviteUrl: expect.stringContaining(`token=${token}`) }),
    }))
  })

  it('personal interno: sin empresa, el correo dice Finto', async () => {
    await createInvitation({ email: 'laura@finto.la', role: 'rs_staff', companyId: null })
    expect(inserted[0]).toMatchObject({ company_id: null, role: 'rs_staff' })
    expect(enqueue.mock.calls[0][0].data.companyName).toBe('Finto')
  })

  it('rechaza un correo con cuenta activa en otra empresa', async () => {
    profile = { id: 'u1', company_id: 'otra', active: true, role: 'client_owner' }
    await expect(createInvitation({ email: 'x@y.co', role: 'client_owner', companyId: 'co-1' }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(inserted).toHaveLength(0)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('permite reinvitar a un usuario desactivado', async () => {
    profile = { id: 'u1', company_id: 'co-1', active: false, role: 'client_user' }
    await createInvitation({ email: 'x@y.co', role: 'client_user', companyId: 'co-1' })
    expect(inserted).toHaveLength(1)
  })

  it('no permite mover por invitación una cuenta inactiva de otra empresa', async () => {
    profile = { id: 'u1', company_id: 'otra', active: false, role: 'client_user' }
    await expect(createInvitation({ email: 'x@y.co', role: 'client_user', companyId: 'co-1' }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(inserted).toHaveLength(0)
  })

  it('usa el mismo registro de invitación y conserva la plantilla de onboarding', async () => {
    await createInvitation({ email: 'x@y.co', role: 'client_owner', companyId: 'co-1', fromOnboarding: true })
    expect(inserted).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      template: 'kyc-approved', data: expect.objectContaining({ platformUrl: expect.stringContaining('/invitations/accept?token=') }),
    }))
  })

  it('409 si la empresa está inactiva', async () => {
    company = { name: 'Constructora ABC', status: 'inactive' } as any
    await expect(createInvitation({ email: 'x@y.co', role: 'client_owner', companyId: 'co-1' }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('404 si la empresa no existe', async () => {
    company = null
    const err = await createInvitation({ email: 'x@y.co', role: 'client_owner', companyId: 'nope' }).catch(e => e)
    expect(err).toBeInstanceOf(InvitationError)
    expect(err.statusCode).toBe(404)
  })
})
