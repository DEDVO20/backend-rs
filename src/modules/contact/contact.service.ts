import { NotificationService } from '../../notifications/NotificationService.js'
import { supabase }             from '../../lib/supabase.js'
import { logger }               from '../../lib/logger.js'
import type { ContactLeadInput } from './contact.schema.js'

// ── Labels legibles para el email ────────────────────────────────────────────

const SERVICE_LABELS: Record<string, string> = {
  control:      '📊 Control financiero y tesorería',
  contabilidad: '📚 Contabilidad e impuestos',
  facturacion:  '🧾 Facturación, cobranza y datos',
  nomina:       '👥 Gestión de personal y SG-SST',
}

const SIZE_LABELS: Record<string, string> = {
  '0-3':   '0 a 3 empleados (Emprendedor)',
  '4-9':   '4 a 9 empleados (Pequeña empresa)',
  '10-24': '10 a 24 empleados (Mediana empresa)',
  '25+':   '25 o más empleados (Oferta personalizada)',
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
    const servicesLabel = data.services
      .map(s => SERVICE_LABELS[s] ?? s)
      .join(', ')

    // 1. Guardar en base de datos (prioridad: email siempre guardado)
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
      logger.error({ err: dbError.message, email: data.email }, 'Error guardando contact_lead en BD')
    } else {
      logger.info({ email: data.email }, 'Lead guardado en BD correctamente')
    }

    // 2. Emails internos (errores aislados — no bloquean la respuesta)
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
            sizeLabel:    SIZE_LABELS[data.companySize] ?? data.companySize,
            startLabel:   START_LABELS[data.startDate]  ?? data.startDate,
          },
        })
      } catch (err: any) {
        logger.warn({ err: err.message, to }, 'No se pudo enviar email interno (continuando)')
      }
    }

    // 3. Confirmación al prospecto
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

    logger.info({ email: data.email, services: data.services, size: data.companySize }, 'Lead procesado')
  },
}
