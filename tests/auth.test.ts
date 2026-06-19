import { describe, it, expect, vi } from 'vitest'

// ── Mocks — deben ir antes de cualquier import del código fuente ──────────────

vi.mock('../src/lib/env.js', () => ({ env: {} }))

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data:  { role: 'admin', company_id: null, active: true },
            error: null,
          }),
        }),
      }),
    }),
    auth: {
      admin: {
        signOut:        vi.fn().mockResolvedValue({ error: null }),
        updateUserById: vi.fn().mockResolvedValue({ error: null }),
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
}))

vi.mock('../src/lib/audit.js', () => ({
  audit:      vi.fn().mockResolvedValue(undefined),
  auditAsync: vi.fn(),
}))

// Importar las rutas directamente — evita arrancar el servidor HTTP
import { authRoutes } from '../src/modules/auth/auth.routes.js'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /login', () => {
  it('devuelve tokens con credenciales válidas', async () => {
    const res = await authRoutes.request('/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: 'test@empresa.com', password: 'secret123' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('access_token', 'tok_access')
    expect(body).toHaveProperty('refresh_token', 'tok_refresh')
    expect(body.user).toMatchObject({ id: 'user-uuid-123', email: 'test@empresa.com' })
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
  it('devuelve nuevos tokens con refresh_token válido', async () => {
    const res = await authRoutes.request('/refresh', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh_token: 'tok_refresh' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('access_token')
    expect(body).toHaveProperty('refresh_token')
  })

  it('rechaza refresh_token inválido', async () => {
    const { supabasePublic } = await import('../src/lib/supabase.js')
    vi.mocked(supabasePublic.auth.refreshSession).mockResolvedValueOnce({
      data:  { session: null, user: null } as any,
      error: { message: 'Token expired' } as any,
    })

    const res = await authRoutes.request('/refresh', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refresh_token: 'expired' }),
    })

    expect(res.status).toBe(401)
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
  // IP única para este describe — evita colisión con el rate limiter de otros tests
  const ip = { 'x-real-ip': '10.0.1.0' }

  it('actualiza contraseña e invalida todas las sesiones', async () => {
    const { supabase } = await import('../src/lib/supabase.js')

    const res = await authRoutes.request('/reset-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...ip },
      body:    JSON.stringify({ access_token: 'tok_access', password: 'NuevaPassword123' }),
    })

    expect(res.status).toBe(200)
    expect(supabase.auth.admin.updateUserById).toHaveBeenCalledWith('user-uuid-123', { password: 'NuevaPassword123' })
    expect(supabase.auth.admin.signOut).toHaveBeenCalledWith('user-uuid-123')
  })

  it('rechaza contraseña menor a 8 caracteres', async () => {
    const res = await authRoutes.request('/reset-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.1.1' },
      body:    JSON.stringify({ access_token: 'tok_access', password: 'corta' }),
    })

    expect(res.status).toBe(400)
  })

  it('rechaza token inválido', async () => {
    const { supabasePublic } = await import('../src/lib/supabase.js')
    vi.mocked(supabasePublic.auth.getUser).mockResolvedValueOnce({
      data:  { user: null } as any,
      error: { message: 'Invalid token' } as any,
    })

    const res = await authRoutes.request('/reset-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '10.0.1.2' },
      body:    JSON.stringify({ access_token: 'invalid', password: 'NuevaPassword123' }),
    })

    expect(res.status).toBe(401)
  })
})

describe('POST /logout', () => {
  it('rechaza sin token', async () => {
    const res = await authRoutes.request('/logout', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
