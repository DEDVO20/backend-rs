import { NotificationService } from '../../notifications/NotificationService.js'
import { supabase }             from '../../lib/supabase.js'
import { logger }               from '../../lib/logger.js'
import type { ContactLeadInput } from './contact.schema.js'

// ── Labels legibles para el email ────────────────────────────────────────────

const SERVICE_LABELS: Record<string, string> = {
  facturacion:  '🧾 Facturación',
  cartera:      '💰 Cobro de cartera',
  controller:   '📊 Controller financiero y reportes',
  contabilidad: '📚 Contabilidad e impuestos',
  pagos:        '💳 Pagos y tesorería',
  nomina:       '👥 Nómina y gestión administrativa',
  multiples:    '🚀 Tercerizar varias áreas',
}

const SIZE_LABELS: Record<string, string> = {
  '1-3':   '1 a 3 empleados',
  '4-10':  '4 a 10 empleados',
  '11-24': '11 a 24 empleados',
  '25+':   '25 o más empleados',
}

const START_LABELS: Record<string, string> = {
  asap:           '⚡ Lo antes posible',
  'this-month':   '📅 Este mes',
  'next-month':   '🗓️ Próximo mes',
  'just-quoting': '🔍 Solo estoy cotizando',
}

// ── Service ───────────────────────────────────────────────────────────────────

export const contactService = {
  async submitLead(data: ContactLeadInput): Promise<void> {
    // Construir lista legible de servicios
    const servicesLabel = data.services
      .map(s => SERVICE_LABELS[s] ?? s)
      .join(', ')

    const firstService = data.services[0] ?? 'multiples'

    // 1. Guardar en base de datos
    const { error: dbError } = await supabase.from('contact_leads').insert({
      service:        data.services.join(','),
      company_size:   data.companySize,
      monthly_volume: null,
      start_date:     data.startDate,
      name:           data.name,
      company:        data.company,
      phone:          data.phone,
      email:          data.email,
    })

    if (dbError) {
      logger.warn({ err: dbError.message }, 'No se pudo guardar contact_lead en BD (continuando)')
    }

    // 2. Enviar email al equipo Finto (múltiples destinatarios — errores aislados)
    const internalRecipients = [
      process.env.FINTO_CONTACT_EMAIL ?? 'finto@finto.la',
      'pblanco@raddf.com',
    ]

    for (const to of internalRecipients) {
      try {
        await NotificationService.sendNow({
          channel:  'email',
          to,
          template: 'contact_lead_internal',
          data: {
            name:         data.name,
            company:      data.company,
            phone:        data.phone,
            email:        data.email,
            serviceLabel: servicesLabel,
            sizeLabel:    SIZE_LABELS[data.companySize]  ?? data.companySize,
            startLabel:   START_LABELS[data.startDate]   ?? data.startDate,
          },
        })
      } catch (err: any) {
        logger.warn({ err: err.message, to }, 'No se pudo enviar email interno (continuando)')
      }
    }

    // 3. Email de confirmación al prospecto
    try {
      await NotificationService.sendNow({
        channel:  'email',
        to:       data.email,
        template: 'contact_lead_confirm',
        data: {
          name:         data.name,
          serviceLabel: servicesLabel,
        },
      })
    } catch (err: any) {
      logger.warn({ err: err.message }, 'No se pudo enviar email de confirmación al prospecto')
    }

    logger.info({ email: data.email, services: data.services }, 'Nuevo lead de contacto procesado')
  },
}
