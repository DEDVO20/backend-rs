import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// La cola importa redis — no se necesita para probar dispatch()
vi.mock('../src/notifications/queue/notificationQueue.js', () => ({
  notificationQueue: { add: vi.fn() },
}))

// Fila de email_settings que devuelve el mock (null = aún no se ha guardado nada)
let settingsRow: { provider: string; bcc: string[] } | null = null
const logInsert = vi.fn().mockResolvedValue({ error: null })

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'email_settings') {
        const c: any = {}
        c.select = () => c
        c.eq = () => c
        c.maybeSingle = () => Promise.resolve({ data: settingsRow, error: null })
        return c
      }
      return { insert: logInsert }
    },
  },
}))

import { NotificationService }     from '../src/notifications/NotificationService.js'
import { invalidateEmailSettings } from '../src/notifications/emailSettings.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const emailPayload = {
  channel:  'email' as const,
  to:       'cliente@empresa.com',
  template: 'password-reset',
  data:     { resetUrl: 'https://app.test/reset', name: 'Ana' },
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!
  return { url: url as string, body: JSON.parse(init.body) }
}

describe('Proveedor de email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateEmailSettings()
    settingsRow = null
    delete process.env.EMAIL_PROVIDER
    delete process.env.EMAIL_BCC
    process.env.RESEND_API_KEY = 're_test'
    process.env.RESEND_FROM    = 'Finto <no-reply@test.com>'
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_1' }) })
  })

  it('sin ajuste guardado ni variable de entorno, el email sale por Zavu', async () => {
    await NotificationService.dispatch(emailPayload)

    expect(lastCall().url).toContain('api.zavu.dev')
    expect(logInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', metadata: null }))
  })

  it('con proveedor resend en la plataforma, el email sale por Resend con las copias ocultas', async () => {
    settingsRow = { provider: 'resend', bcc: ['copias@empresa.com', 'cliente@empresa.com'] }

    await NotificationService.dispatch({ ...emailPayload, bcc: ['otro@empresa.com'] })

    const { url, body } = lastCall()
    expect(url).toContain('api.resend.com')
    expect(body.to).toEqual(['cliente@empresa.com'])
    // El destinatario no se repite como copia oculta
    expect(body.bcc).toEqual(['otro@empresa.com', 'copias@empresa.com'])
    expect(logInsert).toHaveBeenCalledWith(expect.objectContaining({ metadata: { provider: 'resend' } }))
  })

  it('lo guardado en la plataforma tiene prioridad sobre EMAIL_PROVIDER', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    settingsRow = { provider: 'zavu', bcc: [] }

    await NotificationService.dispatch(emailPayload)

    expect(lastCall().url).toContain('api.zavu.dev')
  })

  it('sin fila en la tabla, usa EMAIL_PROVIDER y EMAIL_BCC del entorno', async () => {
    process.env.EMAIL_PROVIDER = 'resend'
    process.env.EMAIL_BCC      = 'a@empresa.com, b@empresa.com'

    await NotificationService.dispatch(emailPayload)

    const { url, body } = lastCall()
    expect(url).toContain('api.resend.com')
    expect(body.bcc).toEqual(['a@empresa.com', 'b@empresa.com'])
  })

  it('SMS sigue saliendo por Zavu aunque el proveedor de email sea Resend', async () => {
    settingsRow = { provider: 'resend', bcc: ['copias@empresa.com'] }

    await NotificationService.dispatch({ ...emailPayload, channel: 'sms', to: '+573001112233' })

    const { url, body } = lastCall()
    expect(url).toContain('api.zavu.dev')
    expect(body.bcc).toBeUndefined()
  })
})
