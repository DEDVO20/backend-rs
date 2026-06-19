import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

const WEBHOOK_SECRET = 'test_secret_webhook'
process.env.ZAVU_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.RS_TEAM_EMAIL       = 'equipo@firma.com'

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Las factories de vi.mock se hoisean — no pueden referenciar variables locales.
// Usamos vi.fn() inline y los recuperamos vía vi.mocked() después del import.

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../src/lib/supabase.js', () => {
  const eqFn     = vi.fn().mockResolvedValue({ error: null })
  const updateFn = vi.fn().mockReturnValue({ eq: eqFn })
  const insertFn = vi.fn().mockResolvedValue({ error: null })
  return {
    supabase: {
      from: vi.fn().mockReturnValue({ insert: insertFn, update: updateFn }),
    },
  }
})

vi.mock('../src/notifications/NotificationService.js', () => ({
  NotificationService: {
    enqueue: vi.fn().mockResolvedValue(undefined),
  },
}))

import { zavuWebhook }        from '../src/webhooks/zavu.webhook.js'
import { NotificationService } from '../src/notifications/NotificationService.js'
import { supabase }            from '../src/lib/supabase.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function sign(body: string, secret = WEBHOOK_SECRET) {
  const timestamp    = Math.floor(Date.now() / 1000)
  const signedPayload = `${timestamp}.${body}`
  const hmac         = createHmac('sha256', secret).update(signedPayload).digest('hex')
  return `t=${timestamp},v1=${hmac}`
}

async function post(body: object, extraHeaders: Record<string, string> = {}) {
  const raw = JSON.stringify(body)
  const sig  = extraHeaders['x-zavu-signature'] ?? sign(raw)

  const req = new Request('http://localhost/', {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'x-zavu-signature': sig, ...extraHeaders },
    body:    raw,
  })
  return zavuWebhook.fetch(req)
}

// Acceso a los mocks internos de supabase.from()
function fromMocks() {
  const fromReturn = vi.mocked(supabase.from).mock.results.at(-1)?.value as any
  return {
    insert: fromReturn?.insert as ReturnType<typeof vi.fn>,
    update: fromReturn?.update as ReturnType<typeof vi.fn>,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Webhook Zavu', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retorna 401 cuando la firma es inválida', async () => {
    const res = await post({ type: 'message.inbound' }, { 'x-zavu-signature': 'firma_falsa' })
    expect(res.status).toBe(401)
    const json = await res.json() as { error: string }
    expect(json.error).toMatch(/firma/i)
  })

  it('retorna 401 cuando falta la cabecera de firma', async () => {
    const raw = JSON.stringify({ type: 'message.inbound' })
    const req = new Request('http://localhost/', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    raw,
    })
    const res = await zavuWebhook.fetch(req)
    expect(res.status).toBe(401)
  })

  it('message.inbound guarda el mensaje en collection_inbound_messages', async () => {
    const event = {
      id: 'evt-1', type: 'message.inbound', senderId: 'zavu',
      data: { channel: 'whatsapp', from: '+573001234567', text: 'Hola, quiero pagar' },
    }

    const res = await post(event)
    expect(res.status).toBe(200)
    await new Promise(r => setTimeout(r, 20))

    expect(supabase.from).toHaveBeenCalledWith('collection_inbound_messages')
    const { insert } = fromMocks()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel:      'whatsapp',
        from_number:  '+573001234567',
        message_body: 'Hola, quiero pagar',
      }),
    )
  })

  it('message.inbound notifica al equipo RS por email', async () => {
    const event = {
      id: 'evt-2', type: 'message.inbound', senderId: 'zavu',
      data: { channel: 'sms', from: '+573009876543', text: 'Cuándo vence?' },
    }

    await post(event)
    await new Promise(r => setTimeout(r, 20))

    expect(NotificationService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel:  'email',
        template: 'inbound-message',
        to:       'equipo@firma.com',
        data:     expect.objectContaining({ from: '+573009876543', channel: 'sms' }),
      }),
    )
  })

  it('message.delivered actualiza notification_logs con status delivered', async () => {
    const event = { id: 'evt-3', type: 'message.delivered', senderId: 'zavu', data: { messageId: 'zavu_msg_abc123' } }

    const res = await post(event)
    expect(res.status).toBe(200)
    await new Promise(r => setTimeout(r, 20))

    expect(supabase.from).toHaveBeenCalledWith('notification_logs')
    const { update } = fromMocks()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'delivered' }),
    )
  })

  it('message.failed actualiza notification_logs con status failed y el motivo', async () => {
    const event = { id: 'evt-4', type: 'message.failed', senderId: 'zavu', data: { messageId: 'zavu_msg_xyz999', errorMessage: 'Número inválido' } }

    const res = await post(event)
    expect(res.status).toBe(200)
    await new Promise(r => setTimeout(r, 20))

    expect(supabase.from).toHaveBeenCalledWith('notification_logs')
    const { update } = fromMocks()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'Número inválido' }),  // error viene de errorMessage
    )
  })

  it('evento desconocido retorna 200 sin tocar la DB', async () => {
    const res = await post({ type: 'message.unknown_event', foo: 'bar' })
    expect(res.status).toBe(200)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
