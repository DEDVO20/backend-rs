import { describe, it, expect, vi } from 'vitest'

// ── Mocks — deben ir antes de cualquier import del código fuente ──────────────

vi.mock('../src/lib/env.js', () => ({ env: {} }))

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../src/lib/supabase.js', () => {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq:     vi.fn().mockReturnThis(),
    gt:     vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { role: 'admin', company_id: null, active: true, email: 'test@empresa.com' }, error: null }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnThis(),
  }
  return {
  supabase: {
    from: vi.fn().mockReturnValue(chain),
    auth: {
      admin: {
        signOut:        vi.fn().mockResolvedValue({ error: null }),
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
        listUsers:      vi.fn().mockResolvedValue({ data: { users: [] }, error: null }),
      },
    },
  },
  supabasePublic: {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({
        data: {
          session: { access_token: 'tok_access', refresh_token: 'tok_refresh', expires_in: 3600 },
          user:    { id: 'user-uuid-123', email: 'test@empresa.com' },
        },
        error: null,
      }),
      refreshSession: vi.fn().mockResolvedValue({
        data: {
          session: { access_token: 'tok_access', refresh_token: 'tok_refresh', expires_in: 3600 },
          user:    { id: 'user-uuid-123', email: 'test@empresa.com' },
        },
        error: null,
      }),
      resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
      getUser: vi.fn().mockResolvedValue({
        data:  { user: { id: 'user-uuid-123', email: 'test@empresa.com' } },
        error: null,
      }),
    },
  },
}})

vi.mock('../src/notifications/NotificationService.js', () => ({
  NotificationService: { enqueue: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('../src/lib/audit.js', () => ({
  audit:      vi.fn().mockResolvedValue(undefined),
  auditAsync: vi.fn(),
}))

// Importar las rutas directamente — evita arrancar el servidor HTTP
import { authRoutes } from '../src/modules/auth/auth.routes.js'

// ── Tests ─────────────────────────────────────────────────────────────────────

const cookies = (res: Response) => res.headers.getSetCookie()

describe('POST /login', () => {
  it('emite los tokens en cookies httpOnly y no en el body', async () => {
    const res = await authRoutes.request('/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: 'test@empresa.com', password: 'secret123' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).not.toHaveProperty('access_token')
    expect(body).not.toHaveProperty('refresh_token')
    expect(body.user).toMatchObject({ id: 'user-uuid-123', email: 'test@empresa.com' })

    const set = cookies(res)
    const at = set.find(c => c.startsWith('rs_at=tok_access'))
    const rt = set.find(c => c.startsWith('rs_rt=tok_refresh'))
    expect(at).toMatch(/HttpOnly/i)
    expect(at).toMatch(/Path=\//)
    expect(rt).toMatch(/HttpOnly/i)
    expect(rt).toMatch(/Path=\/auth/)
  })

  it('rechaza credenciales inválidas', async () => {
    const { supabasePublic } = await import('../src/lib/supabase.js')
    vi.mocked(supabasePublic.auth.signInWithPassword).mockResolvedValueOnce({
      data:  { session: null, user: null } as any,
      error: { message: 'Invalid credentials' } as any,
    })

    const res = await authRoutes.request('/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.0.2' },
      body:    JSON.stringify({ email: 'bad@test.com', password: 'wrongpass' }),
    })

    expect(res.status).toBe(401)
  })

  it('valida el schema — email inválido devuelve 400', async () => {
    const res = await authRoutes.request('/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: 'no-es-email', password: '123456' }),
    })

    expect(res.status).toBe(400)
  })
})

describe('POST /refresh', () => {
  it('renueva las cookies con la cookie de refresh válida', async () => {
    const res = await authRoutes.request('/refresh', {
      method:  'POST',
      headers: { Cookie: 'rs_rt=tok_refresh' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).not.toHaveProperty('access_token')
    expect(cookies(res).some(c => c.startsWith('rs_at=tok_access'))).toBe(true)
  })

  it('responde 401 sin cookie de refresh', async () => {
    const res = await authRoutes.request('/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('rechaza refresh token inválido y limpia las cookies', async () => {
    const { supabasePublic } = await import('../src/lib/supabase.js')
    vi.mocked(supabasePublic.auth.refreshSession).mockResolvedValueOnce({
      data:  { session: null, user: null } as any,
      error: { message: 'Token expired' } as any,
    })

    const res = await authRoutes.request('/refresh', {
      method:  'POST',
      headers: { Cookie: 'rs_rt=expired' },
    })

    expect(res.status).toBe(401)
    expect(cookies(res).some(c => /^rs_rt=;/.test(c) && /Max-Age=0/i.test(c))).toBe(true)
  })
})

describe('POST /logout', () => {
  it('revoca la sesión con el JWT y limpia las cookies', async () => {
    const { supabase } = await import('../src/lib/supabase.js')
    const res = await authRoutes.request('/logout', {
      method:  'POST',
      headers: { Cookie: 'rs_at=tok_access; rs_rt=tok_refresh' },
    })

    expect(res.status).toBe(200)
    expect(supabase.auth.admin.signOut).toHaveBeenCalledWith('tok_access', 'global')
    const set = cookies(res)
    expect(set.some(c => /^rs_at=;/.test(c))).toBe(true)
    expect(set.some(c => /^rs_rt=;/.test(c))).toBe(true)
  })

  it('limpia las cookies aunque no haya sesión', async () => {
    const res = await authRoutes.request('/logout', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(cookies(res).some(c => /^rs_rt=;/.test(c))).toBe(true)
  })
})

describe('POST /forgot-password', () => {
  it('siempre responde 200 aunque el email no exista', async () => {
    const res = await authRoutes.request('/forgot-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: 'noexiste@test.com' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('message')
  })

  it('valida email inválido', async () => {
    const res = await authRoutes.request('/forgot-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: 'no-es-email' }),
    })

    expect(res.status).toBe(400)
  })
})

describe('POST /reset-password', () => {
  const ip = { 'x-real-ip': '10.0.1.0' }

  it('actualiza contraseña con token válido', async () => {
    const { supabase } = await import('../src/lib/supabase.js')

    // Mock: token encontrado en BD
    vi.mocked(supabase.from('').single).mockResolvedValueOnce({
      data: { email: 'test@empresa.com' }, error: null,
    } as any)
    // Mock: listUsers devuelve el usuario
    vi.mocked(supabase.auth.admin.listUsers).mockResolvedValueOnce({
      data: { users: [{ id: 'user-uuid-123', email: 'test@empresa.com' }] }, error: null,
    } as any)

    const res = await authRoutes.request('/reset-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...ip },
      body:    JSON.stringify({ access_token: 'tok_valid', password: 'NuevaPassword123' }),
    })

    expect(res.status).toBe(200)
  })

  it('rechaza contraseña menor a 8 caracteres', async () => {
    const res = await authRoutes.request('/reset-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.1.1' },
      body:    JSON.stringify({ access_token: 'tok_valid', password: 'corta' }),
    })

    expect(res.status).toBe(400)
  })

  it('rechaza token no encontrado en BD', async () => {
    const { supabase } = await import('../src/lib/supabase.js')

    // Mock: token no encontrado
    vi.mocked(supabase.from('').single).mockResolvedValueOnce({
      data: null, error: { message: 'not found' },
    } as any)

    const res = await authRoutes.request('/reset-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.1.2' },
      body:    JSON.stringify({ access_token: 'invalid', password: 'NuevaPassword123' }),
    })

    expect(res.status).toBe(401)
  })
})
