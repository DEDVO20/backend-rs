import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invitationsRoutes } from '../src/modules/invitations/invitations.routes.js'
import { InvitationError } from '../src/modules/invitations/invitations.service.js'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  findAccount: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUserById: vi.fn(),
  upsertProfile: vi.fn(),
  updateProfile: vi.fn(),
}))
vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.findAccount,
    auth: { admin: { createUser: mocks.createUser, updateUserById: mocks.updateUserById } },
  },
  supabasePublic: { auth: { getUser: mocks.getUser } },
}))
vi.mock('../src/notifications/NotificationService.js', () => ({ NotificationService: {} }))
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

const app = new Hono().route('/', invitationsRoutes)
app.onError((error, c) => {
  if (error instanceof InvitationError && error.statusCode === 409) return c.json({ error: error.message }, 409)
  throw error
})

const token = 'a723af18-4ad7-4af5-a34f-094ddecd8120'
const email = 'invite@example.test'
const accountId = 'existing-user'
const companyId = 'company-a'
const invite = { email, role: 'client_user', company_id: companyId, full_name: null }

let available: boolean
let profile: { company_id: string; role: string; active: boolean }

beforeEach(() => {
  vi.resetAllMocks()
  available = true
  profile = { company_id: companyId, role: 'client_user', active: false }
  mocks.findAccount.mockResolvedValue({ data: null })
  mocks.createUser.mockResolvedValue({ data: { user: { id: 'new-user' } } })
  mocks.upsertProfile.mockResolvedValue({})
  mocks.getUser.mockResolvedValue({ data: { user: { id: accountId, email, email_confirmed_at: 'verified' } } })
  mocks.from.mockImplementation(table => {
    let writing = false
    const query = {
      select: () => query,
      eq: () => query,
      gt: () => query,
      update: (patch: unknown) => {
        writing = true
        if (table === 'profiles') mocks.updateProfile(patch)
        return query
      },
      upsert: mocks.upsertProfile,
      maybeSingle: async () => {
        if (table === 'companies') return { data: { name: 'Empresa A', status: 'active' } }
        if (table === 'profiles') return { data: profile }
        const data = available ? invite : null
        if (writing) available = false
        return { data }
      },
    }
    return query
  })
})

function accept(ip: string, session?: string) {
  return app.request('/accept', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-real-ip': ip,
      ...(session ? { Cookie: `rs_at=${session}` } : {}),
    },
    body: JSON.stringify({ token, email, password: 'account-password' }),
  })
}

describe('aceptación de invitaciones', () => {
  it('exige iniciar sesión con la cuenta existente y conserva el enlace si falta la sesión', async () => {
    mocks.findAccount.mockResolvedValue({ data: accountId })
    expect((await accept('test-a')).status).toBe(401)
    expect(available).toBe(true)
    expect(mocks.createUser).not.toHaveBeenCalled()
    expect(mocks.updateUserById).not.toHaveBeenCalled()
  })

  it('rechaza la sesión de otra identidad', async () => {
    mocks.findAccount.mockResolvedValue({ data: accountId })
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'other-user', email: 'other@example.test', email_confirmed_at: 'verified' } } })
    expect((await accept('test-b', 'different-session')).status).toBe(401)
    expect(available).toBe(true)
  })

  it('reactiva la membresía autorizada sin cambiar la contraseña', async () => {
    mocks.findAccount.mockResolvedValue({ data: accountId })
    expect((await accept('test-c', 'authenticated-session')).status).toBe(200)
    expect(mocks.updateProfile).toHaveBeenCalledWith({ active: true })
    expect(mocks.updateUserById).not.toHaveBeenCalled()
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('no modifica una cuenta activa aunque la invitación se haya emitido antes', async () => {
    mocks.findAccount.mockResolvedValue({ data: accountId })
    profile.active = true
    expect((await accept('test-d', 'authenticated-session')).status).toBe(409)
    expect(mocks.updateProfile).not.toHaveBeenCalled()
  })

  it('no cambia el rol de una cuenta desactivada', async () => {
    mocks.findAccount.mockResolvedValue({ data: accountId })
    profile.role = 'client_owner'
    expect((await accept('test-role', 'authenticated-session')).status).toBe(409)
    expect(available).toBe(true)
    expect(mocks.updateProfile).not.toHaveBeenCalled()
  })

  it('crea una cuenta nueva una sola vez con un enlace válido', async () => {
    const responses = await Promise.all([accept('test-e'), accept('test-e')])
    expect(responses.map(r => r.status).sort()).toEqual([200, 400])
    expect(mocks.createUser).toHaveBeenCalledTimes(1)
    expect(mocks.upsertProfile).toHaveBeenCalledTimes(1)
  })
})
