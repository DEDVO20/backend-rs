import { logger } from '../../lib/logger.js'

const ZAVU_API = 'https://api.zavu.dev/v1/messages'

function authHeader() {
  return { Authorization: `Bearer ${process.env.ZAVU_API_KEY}` }
}

async function zavuPost(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(ZAVU_API, {
    method:  'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })

  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw Object.assign(new Error((data as any).message ?? 'Zavu error'), { status: res.status, data })
  return data
}

export type ChannelPayload = {
  to:       string
  channel:  'email' | 'sms' | 'whatsapp'
  text:     string
  subject?: string
  html?:    string
  // Plantilla aprobada por Meta — requerida en WhatsApp fuera de la ventana
  // de 24 horas (los mensajes "text" rebotan con el error 131047)
  templateId?:        string
  templateVariables?: Record<string, string>
}

export class ZavuChannel {
  static async send(payload: ChannelPayload): Promise<string> {
    let body: Record<string, unknown>

    if (payload.channel === 'whatsapp' && payload.templateId) {
      body = {
        to:          payload.to,
        channel:     'whatsapp',
        messageType: 'template',
        content: {
          templateId:        payload.templateId,
          templateVariables: payload.templateVariables ?? {},
        },
      }
    } else {
      body = {
        to:      payload.to,
        channel: payload.channel,
        text:    payload.text,
      }
      if (payload.channel === 'email') {
        if (payload.subject) body['subject']  = payload.subject
        if (payload.html)    body['htmlBody'] = payload.html
      }
    }

    const result = await zavuPost(body)
    const messageId = (result as any)?.message?.id ?? (result as any)?.id ?? 'unknown'
    logger.info({ messageId, channel: payload.channel, to: payload.to, template: payload.templateId ?? null }, 'Mensaje enviado')
    return messageId
  }

  static async sendBroadcast(opts: {
    name:      string
    channel:   'sms' | 'whatsapp'
    template:  string
    contacts:  Array<{ to: string; data: Record<string, unknown> }>
  }): Promise<string> {
    const broadcastId = `broadcast_${Date.now()}`

    await Promise.allSettled(
      opts.contacts.map(c =>
        zavuPost({ to: c.to, channel: opts.channel, text: opts.template }),
      ),
    )

    logger.info({ broadcastId, total: opts.contacts.length, channel: opts.channel }, 'Broadcast enviado')
    return broadcastId
  }
}
