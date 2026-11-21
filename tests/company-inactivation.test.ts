import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

vi.mock('../src/lib/env.js', () => ({ env: {} }))
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Estado configurable ───────────────────────────────────────────────────────
let profileRow: any = null
let companyRow: any = null
const companyUpdates: any[] = []
const invitationUpdates: any[] = []

vi.mock('../src/lib/supabase.js', () => {
  const builder = (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      single: async () => table === 'profiles'
        ? { data: profileRow, error: profileRow ? null : { message: 'no' } }
        : { data: { ...companyRow, ...companyUpdates.at(-1) }, error: null },
      maybeSingle: async () => ({ data: companyRow, error: null }),
      update: (v: any, opts?: any) => {
        if (table === 'companies') companyUpdates.push(v)
        if (table === 'company_invitations') {
          invitationUpdates.push(v)
          const w: any = { eq: () => w, then: (r: any) => r({ error: null, count: opts?.count ? 2 : null }) }
          return w
        }
        return q
      },
    }
    return q
  }
  return {
    supabase:       { from: (t: string) => builder(t) },
    supabasePublic: { auth: { getUser: vi.fn(async (tok: string) => ({ data: { user: { id: `u-${tok}` } }, error: null })) } },
  }
})

import { authMiddleware } from '../src/middleware/auth.js'
import { CompaniesService } from '../src/modules/companies/companies.service.js'

function appWithAuth() {
  const app = new Hono()
  app.use('*', authMiddleware)
  app.get('/x', c => c.json({ ok: true }))
  return app
}

let n = 0
const call = () => appWithAuth().request('/x', { headers: { Authorization: `Bearer tok${++n}` } })

beforeEach(() => {
  companyUpdates.length = 0
  invitationUpdates.length = 0
})

describe('authMiddleware — empresa inactiva', () => {
  it('bloquea a un usuario cliente de una empresa inactiva', async () => {
    profileRow = { role: 'client_owner', company_id: 'co-1', active: true, companies: { status: 'inactive' } }
    const res = await call()
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error).toMatch(/empresa está inactiva/)
  })

  it('acepta el valor histórico "inactiva"', async () => {
    profileRow = { role: 'client_user', company_id: 'co-1', active: true, companies: { status: 'inactiva' } }
    expect((await call()).status).toBe(403)
  })

  it('deja pasar a un cliente de una empresa activa', async () => {
    profileRow = { role: 'client_user', company_id: 'co-1', active: true, companies: { status: 'activa' } }
    expect((await call()).status).toBe(200)
  })

  it('nunca bloquea al personal interno aunque tenga empresa asociada', async () => {
    profileRow = { role: 'admin', company_id: 'co-1', active: true, companies: { status: 'inactive' } }
    expect((await call()).status).toBe(200)
  })
})

describe('CompaniesService.inactivate / reactivate', () => {
  it('inactiva con motivo, guarda quién y cancela las invitaciones pendientes', async () => {
    companyRow = { id: 'co-1', status: 'activa' }
    const res = await CompaniesService.inactivate('co-1', 'admin-1', '  Terminó el contrato ')
    expect(companyUpdates[0]).toMatchObject({ status: 'inactive', inactivated_by: 'admin-1', inactivation_reason: 'Terminó el contrato' })
    expect(companyUpdates[0].inactivated_at).toBeTruthy()
    expect(invitationUpdates[0]).toEqual({ status: 'cancelled' })
    expect(res.cancelled_invitations).toBe(2)
  })

  it('409 si ya estaba inactiva', async () => {
    companyRow = { id: 'co-1', status: 'inactive' }
    await expect(CompaniesService.inactivate('co-1', 'admin-1')).rejects.toMatchObject({ statusCode: 409 })
    expect(companyUpdates).toHaveLength(0)
  })

  it('404 si la empresa no existe', async () => {
    companyRow = null
    await expect(CompaniesService.inactivate('nope', 'admin-1')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('reactiva y limpia los datos de inactivación', async () => {
    companyRow = { id: 'co-1', status: 'inactive' }
    await CompaniesService.reactivate('co-1')
    expect(companyUpdates[0]).toEqual({ status: 'activa', inactivated_at: null, inactivated_by: null, inactivation_reason: null })
  })

  it('409 al reactivar una empresa activa', async () => {
    companyRow = { id: 'co-1', status: 'activa' }
    await expect(CompaniesService.reactivate('co-1')).rejects.toMatchObject({ statusCode: 409 })
  })
})
