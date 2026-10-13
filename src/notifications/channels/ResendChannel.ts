import { logger } from '../../lib/logger.js'
import type { ChannelPayload } from './ZavuChannel.js'

const RESEND_API = 'https://api.resend.com/emails'

export class ResendChannel {
  static async send(payload: ChannelPayload): Promise<string> {
    const from = process.env.RESEND_FROM
    if (!process.env.RESEND_API_KEY || !from) {
      throw new Error('Resend no configurado — faltan RESEND_API_KEY o RESEND_FROM')
    }

    const body: Record<string, unknown> = {
      from,
      to:      [payload.to],
      subject: payload.subject ?? 'Notificación',
      text:    payload.text,
    }
    if (payload.html) body['html'] = payload.html

    // Copias ocultas sin repetir y sin duplicar al destinatario
    const bcc = [...new Set(payload.bcc ?? [])]
      .filter(addr => addr.toLowerCase() !== payload.to.toLowerCase())
    if (bcc.length)         body['bcc'] = bcc
    if (payload.cc?.length) body['cc']  = payload.cc

    const res = await fetch(RESEND_API, {
      method:  'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })

    const data = await res.json() as Record<string, unknown>
    if (!res.ok) throw Object.assign(new Error((data as any).message ?? 'Resend error'), { status: res.status, data })

    const messageId = (data as any)?.id ?? 'unknown'
    logger.info({ messageId, channel: 'email', provider: 'resend', to: payload.to, bcc: bcc.length }, 'Mensaje enviado')
    return messageId
  }
}
