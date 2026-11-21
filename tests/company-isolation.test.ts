import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectionRoutes } from '../src/modules/collection/collection.routes.js'
import { CollectionService } from '../src/modules/collection/collection.service.js'
import { documentsRoutes } from '../src/modules/documents/documents.routes.js'
import { onboardingRoutes } from '../src/modules/onboarding/onboarding.routes.js'
import { OnboardingService } from '../src/modules/onboarding/onboarding.service.js'
import { profilesRoutes } from '../src/modules/profiles/profiles.routes.js'
import { requestsRoutes } from '../src/modules/operational-requests/requests.routes.js'
import { tasksRoutes } from '../src/modules/tasks/tasks.routes.js'
import type { AuthUser } from '../src/middleware/auth.js'

vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: AuthUser) => void }, next: () => Promise<void>) => {
    if (!user) throw new HTTPException(401)
    c.set('user', user)
    await next()
  },
}))
vi.mock('../src/lib/permissions.js', () => ({ canAccess: async () => true, can: async () => true }))
vi.mock('../src/notifications/NotificationService.js', () => ({ NotificationService: {} }))
vi.mock('../src/lib/supabase.js', () => ({
  supabase: { from: (table: string) => from(table), storage: { from: () => ({ createSignedUrl }) } },
}))

const firstCompany = '09fdce86-d374-40de-90a3-a4413737f1f1'
const secondCompany = '78384da7-eac1-4725-b0b0-c8671780553e'
const ownRow = { id: 'own', company_id: firstCompany, owner_type: 'client', collection_debts: [] }
const foreignRow = { id: 'foreign', company_id: secondCompany, owner_type: 'client', storage_path: 'external' }
const internalTask = { id: 'internal', company_id: firstCompany, owner_type: 'rs_team' }
let user: AuthUser | null
const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.test/own' } })
const from = vi.fn((_table: string) => {
  let rows = [
    ownRow, foreignRow, internalTask,
    { id: 'downloadable', company_id: firstCompany, storage_path: `${firstCompany}/own.pdf` },
    { id: 'mismatched', company_id: firstCompany, storage_path: `${secondCompany}/external.pdf` },
  ]
  const query = {
    select: () => query,
    eq: (column: string, value: string) => {
      if (!column.includes('.')) rows = rows.filter(row => Reflect.get(row, column) === value)
      return query
    },
    in: () => query,
    maybeSingle: async () => ({ data: rows[0] ?? null }),
  }
  return query
})

const app = new Hono()
app.route('/collection', collectionRoutes)
app.route('/documents', documentsRoutes)
app.route('/onboarding', onboardingRoutes)
app.route('/profiles', profilesRoutes)
app.route('/requests', requestsRoutes)
app.route('/tasks', tasksRoutes)
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse()
  const status = Reflect.get(error, 'statusCode')
  if (status === 404) return c.json({ error: error.message }, 404)
  throw error
})

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'user-a', role: 'client_owner', companyId: firstCompany }
})

describe('aislamiento entre empresas', () => {
  it.each(['/collection/stats', '/collection/debtors', '/collection/debtors/socios'])(
    '%s rechaza otra empresa antes de consultar la base de datos',
    async path => {
      expect((await app.request(`${path}?company_id=${secondCompany}`)).status).toBe(403)
      expect(from).not.toHaveBeenCalled()
    },
  )

  it('retira el diagnóstico y usa la empresa de sesión por defecto', async () => {
    const stats = vi.spyOn(CollectionService, 'getStats').mockResolvedValue({} as Awaited<ReturnType<typeof CollectionService.getStats>>)
    try {
      expect((await app.request('/collection/debug')).status).toBe(404)
      expect((await app.request('/collection/stats')).status).toBe(200)
      expect(stats).toHaveBeenCalledWith(firstCompany, null)
      user = { id: 'staff', role: 'rs_staff', companyId: null }
      expect((await app.request(`/collection/stats?company_id=${secondCompany}`)).status).toBe(200)
      expect(stats).toHaveBeenLastCalledWith(secondCompany, null)
    } finally {
      stats.mockRestore()
    }
  })

  it.each(['/collection/debtors', '/documents', '/requests', '/tasks'])(
    '%s conserva el acceso propio y oculta el recurso ajeno',
    async path => {
      expect((await app.request(`${path}/own`)).status).toBe(200)
      expect((await app.request(`${path}/foreign`)).status).toBe(404)
    },
  )

  it('solo firma la descarga de un archivo propio', async () => {
    expect((await app.request('/documents/foreign/download')).status).toBe(404)
    expect((await app.request('/documents/mismatched/download')).status).toBe(404)
    expect(createSignedUrl).not.toHaveBeenCalled()
    expect((await app.request('/documents/downloadable/download')).status).toBe(200)
    expect(createSignedUrl).toHaveBeenCalledTimes(1)
    expect(createSignedUrl).toHaveBeenCalledWith(`${firstCompany}/own.pdf`, 3600)
  })

  it('oculta tareas internas de la misma empresa', async () => {
    expect((await app.request('/tasks/internal')).status).toBe(404)
  })

  it('bloquea el acceso al equipo de otra empresa', async () => {
    expect((await app.request(`/profiles/company/${secondCompany}/team`)).status).toBe(403)
    expect(from).not.toHaveBeenCalled()
  })

  it('impide que rs_admin se asigne admin', async () => {
    user = { id: 'staff', role: 'rs_admin', companyId: null }
    const response = await app.request('/profiles/staff', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }),
    })
    expect(response.status).toBe(403)
  })

  it('exige autenticación para la lectura y credencial para editar el borrador', async () => {
    user = null
    expect((await app.request('/onboarding/own')).status).toBe(401)
    expect((await app.request('/onboarding/own/submit', { method: 'POST' })).status).toBe(403)
    expect(from).not.toHaveBeenCalled()
  })

  it('limita la credencial de registro al expediente que la emitió', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key-for-onboarding')
    const create = vi.spyOn(OnboardingService, 'create').mockResolvedValue({ id: 'own' })
    const submit = vi.spyOn(OnboardingService, 'submit').mockResolvedValue({ id: 'own' })
    try {
      const response = await app.request('/onboarding', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: 'Empresa prueba', rep_name: 'Ana Test', rep_email: 'ana@example.test' }),
      })
      expect(response.status).toBe(201)
      const { draft_token } = await response.json() as { draft_token: string }
      const request = { method: 'POST', headers: { Authorization: `Onboarding ${draft_token}` } }
      expect((await app.request('/onboarding/foreign/submit', request)).status).toBe(403)
      expect((await app.request('/onboarding/own/submit', request)).status).toBe(200)
      expect(submit).toHaveBeenCalledTimes(1)
    } finally {
      create.mockRestore()
      submit.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})
