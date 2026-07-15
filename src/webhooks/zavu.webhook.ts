import { Hono }               from 'hono'
import { createHmac, timingSafeEqual } from 'crypto'
import { supabase }            from '../lib/supabase.js'
import { NotificationService } from '../notifications/NotificationService.js'
import { logger }              from '../lib/logger.js'

export const zavuWebhook = new Hono()

function verifySignature(rawBody: string, header: string, secret: string): boolean {
  if (!header) return false

  const parts  = header.split(',')
  const tPart  = parts.find(p => p.startsWith('t='))
  const v1Part = parts.find(p => p.startsWith('v1='))

  if (!tPart || !v1Part) return false

  const timestamp = parseInt(tPart.slice(2), 10)
  const signature = v1Part.slice(3)

  // Zavu puede enviar timestamp en ms o s — normalizar a segundos para replay check
  const tsSec = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp
  if (Math.floor(Date.now() / 1000) - tsSec > 300) return false

  // La firma se calcula con el timestamp TAL CUAL viene en el header
  const signedPayload = `${timestamp}.${rawBody}`
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex')

  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))
  } catch {
    return Buffer.from(expected).toString() === signature
  }
}

// Idempotencia: Zavu reintenta hasta 5 veces ante fallos — recordar los últimos
// event.id procesados para no duplicar inserciones/notificaciones
const SEEN_MAX = 5000
const seenEvents = new Set<string>()

function markSeen(id: string) {
  seenEvents.add(id)
  if (seenEvents.size > SEEN_MAX) {
    // Set conserva orden de inserción — descartar los más antiguos
    for (const k of seenEvents) {
      seenEvents.delete(k)
      if (seenEvents.size <= SEEN_MAX * 0.8) break
    }
  }
}

zavuWebhook.post('/', async (c) => {
  const rawBody = await c.req.text()
  const header  = c.req.header('x-zavu-signature') ?? ''
  const secret  = process.env.ZAVU_WEBHOOK_SECRET

  if (!secret) {
    logger.error('ZAVU_WEBHOOK_SECRET no configurado — webhook rechazado')
    return c.json({ error: 'Webhook no configurado' }, 500)
  }

  // Firma inválida o ausente → 401 (antes se procesaba igual y respondía 200,
  // lo que ocultaba errores de configuración y permitía payloads sin firmar)
  if (!verifySignature(rawBody, header, secret)) {
    logger.warn({ headerPrefix: header.substring(0, 40) }, 'Webhook Zavu: firma inválida — rechazado')
    return c.json({ error: 'Firma inválida' }, 401)
  }

  let event: {
    id:       string
    type:     string
    senderId: string
    data:     Record<string, unknown>
  }
  try {
    event = JSON.parse(rawBody)
  } catch {
    logger.warn('Webhook Zavu: body no es JSON válido')
    return c.json({ error: 'JSON inválido' }, 400)
  }

  if (!event?.id || !event?.type) {
    return c.json({ error: 'Evento inválido — faltan id o type' }, 400)
  }

  // Reintento de un evento ya procesado → 200 sin reprocesar
  if (seenEvents.has(event.id)) {
    logger.debug({ eventId: event.id }, 'Webhook Zavu: evento duplicado ignorado')
    return c.json({ ok: true, duplicate: true })
  }
  markSeen(event.id)

  logger.info({ type: event.type, eventId: event.id }, 'Webhook Zavu recibido')

  // Responder rápido y procesar async (Zavu espera respuesta < 30s)
  void processEvent(event)

  return c.json({ ok: true })
})

async function processEvent(event: {
  id:       string
  type:     string
  senderId: string
  data:     Record<string, unknown>
}) {
  try {
    switch (event.type) {

      case 'message.inbound': {
        const { channel, from, text } = event.data as {
          channel: string
          from:    string
          text:    string
        }

        await supabase.from('collection_inbound_messages').insert({
          channel,
          from_number:  from,
          message_body: text,
          received_at:  new Date().toISOString(),
        })

        void NotificationService.enqueue({
          channel:  'email',
          template: 'inbound-message',
          to:       process.env.RS_TEAM_EMAIL!,
          data:     { from, text, channel },
        })
        break
      }

      case 'message.sent':
      case 'message.delivered': {
        const { messageId } = event.data as { messageId: string }
        await supabase
          .from('notification_logs')
          .update({ status: event.type === 'message.sent' ? 'sent' : 'delivered', delivered_at: new Date().toISOString() })
          .eq('zavu_message_id', messageId)
        break
      }

      case 'message.failed': {
        const { messageId, errorMessage } = event.data as {
          messageId:    string
          errorMessage: string
        }
        await supabase
          .from('notification_logs')
          .update({ status: 'failed', error: errorMessage })
          .eq('zavu_message_id', messageId)
        logger.warn({ messageId, errorMessage }, 'Mensaje Zavu fallido')
        break
      }

      case 'message.read': {
        const { messageId } = event.data as { messageId: string }
        await supabase
          .from('notification_logs')
          .update({ status: 'read' })
          .eq('zavu_message_id', messageId)
        break
      }

      default:
        logger.debug({ type: event.type }, 'Evento Zavu sin handler')
    }
  } catch (err) {
    logger.error({ err, type: event.type }, 'Error procesando evento Zavu')
  }
}
