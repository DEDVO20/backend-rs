import { ZavuChannel }        from './channels/ZavuChannel.js'
import { renderTemplate }     from './templates/renderTemplate.js'
import { notificationQueue }  from './queue/notificationQueue.js'
import { supabase }            from '../lib/supabase.js'
import { logger }              from '../lib/logger.js'

export type NotificationChannel = 'email' | 'sms' | 'whatsapp'

export type NotificationPayload = {
  channel:    NotificationChannel
  to:         string
  template:   string
  data:       Record<string, unknown>
  companyId?: string
  metadata?:  Record<string, unknown>
  // Plantilla de WhatsApp aprobada por Meta (Zavu) — obligatoria fuera de la
  // ventana de 24h; si viene, se envía messageType 'template' en vez de texto
  templateId?:        string
  templateVariables?: Record<string, string>
}

export class NotificationService {

  /** Encolar con reintentos automáticos (recomendado) */
  static async enqueue(payload: NotificationPayload): Promise<void> {
    await notificationQueue.add('send', payload)
    logger.debug({ channel: payload.channel, template: payload.template }, 'Notificación encolada')
  }

  /** Envío inmediato sin cola (OTPs, alertas críticas) */
  static async sendNow(payload: NotificationPayload): Promise<void> {
    await this.dispatch(payload)
  }

  /** Campaña masiva vía Zavu Broadcasts (hasta 1000 contactos) */
  static async sendBroadcast(opts: {
    name:      string
    channel:   'sms' | 'whatsapp'
    template:  string
    contacts:  Array<{ to: string; data: Record<string, unknown> }>
    companyId: string
  }): Promise<string> {
    const broadcastId = await ZavuChannel.sendBroadcast({
      name:     opts.name,
      channel:  opts.channel,
      template: opts.template,
      contacts: opts.contacts,
    })

    // Registrar en logs
    await supabase.from('notification_logs').insert({
      channel:    opts.channel,
      recipient:  `broadcast:${opts.contacts.length}`,
      template:   opts.template,
      company_id: opts.companyId,
      status:     'sent',
      metadata:   { broadcastId, total: opts.contacts.length },
    })

    return broadcastId
  }

  /** Llamado por el worker de BullMQ — no llamar directamente */
  static async dispatch(payload: NotificationPayload): Promise<void> {
    const startedAt = Date.now()
    let status       = 'sent'
    let errorMsg: string | null = null
    let messageId:  string | null = null

    try {
      if (payload.channel === 'whatsapp' && payload.templateId) {
        // Plantilla aprobada por Meta — no se renderiza texto local
        messageId = await ZavuChannel.send({
          to:                payload.to,
          channel:           'whatsapp',
          text:              '',
          templateId:        payload.templateId,
          templateVariables: payload.templateVariables,
        })
      } else {
        const { text, html, subject } = await renderTemplate(payload.template, payload.data)

        messageId = await ZavuChannel.send({
          to:      payload.to,
          channel: payload.channel,
          text,
          html,
          subject,
        })
      }
    } catch (err) {
      status   = 'failed'
      errorMsg = err instanceof Error ? err.message : String(err)
      logger.error({ err: errorMsg, template: payload.template, channel: payload.channel }, 'Dispatch fallido')
      throw err // re-lanzar para que BullMQ reintente
    } finally {
      await supabase.from('notification_logs').insert({
        channel:        payload.channel,
        recipient:      payload.to,
        template:       payload.template,
        company_id:     payload.companyId ?? null,
        status,
        error:          errorMsg,
        duration_ms:    Date.now() - startedAt,
        zavu_message_id: messageId,
        metadata:       payload.metadata ?? null,
      })
    }
  }
}
