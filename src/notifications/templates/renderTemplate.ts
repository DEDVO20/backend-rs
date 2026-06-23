// ─────────────────────────────────────────────────────────────────────────────
// renderTemplate.ts
// Devuelve { text, html, subject } según el template y los datos.
// text  → usado por SMS y WhatsApp
// html + subject → usado por email (text es el fallback plain-text)
// ─────────────────────────────────────────────────────────────────────────────

type RenderedTemplate = {
  subject: string
  html:    string
  text:    string
}

type Builder = (data: Record<string, unknown>) => RenderedTemplate

// Helpers
const str = (v: unknown) => String(v ?? '')

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 0; background: #f5f5f3; }
  .wrap { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; }
  .header { background: #0F6E56; padding: 32px 40px; }
  .header h1 { color: #fff; margin: 0; font-size: 22px; font-weight: 600; }
  .body { padding: 32px 40px; }
  .body p { line-height: 1.7; margin: 0 0 16px; font-size: 15px; }
  .btn { display: inline-block; background: #0F6E56; color: #fff !important; padding: 12px 28px;
         border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0; }
  .footer { background: #f5f5f3; padding: 20px 40px; font-size: 12px; color: #888; }
  .info { background: #E1F5EE; border-left: 4px solid #0F6E56; padding: 14px 18px;
          border-radius: 0 8px 8px 0; margin: 16px 0; }
  .warn { background: #FAECE7; border-left: 4px solid #993C1D; padding: 14px 18px;
          border-radius: 0 8px 8px 0; margin: 16px 0; }
</style></head>
<body><div class="wrap">
  <div class="header"><h1>${title}</h1></div>
  <div class="body">${body}</div>
  <div class="footer">Este mensaje fue generado automáticamente. No respondas a este correo.</div>
</div></body></html>`
}

// ─── Templates ───────────────────────────────────────────────────────────────
const templates: Record<string, Builder> = {

  // ── Onboarding / invitaciones ─────────────────────────────────────────────
  invitation: (d) => ({
    subject: `Invitación para unirte a ${str(d.companyName)}`,
    html: layout('Invitación a la plataforma', `
      <p>Hola${d.name ? ` ${str(d.name)}` : ''},</p>
      <p>Has sido invitado a unirte a <strong>${str(d.companyName)}</strong> en nuestra plataforma.</p>
      <p><a class="btn" href="${str(d.inviteUrl)}">Aceptar invitación</a></p>
      <p style="color:#888;font-size:13px">Este enlace expira en 7 días.</p>
    `),
    text: `Hola${d.name ? ` ${str(d.name)}` : ''}, fuiste invitado a ${str(d.companyName)}. Acepta aquí: ${str(d.inviteUrl)}`,
  }),

  'kyc-approved': (d) => ({
    subject: '¡Tu empresa fue aprobada! — Crea tu contraseña',
    html: layout('Empresa aprobada', `
      <p>Hola ${str(d.ownerName)},</p>
      <p>La empresa <strong>${str(d.companyName)}</strong> ha sido aprobada exitosamente.</p>
      <div class="info">Para acceder a la plataforma, primero debes crear tu contraseña haciendo clic en el botón de abajo.</div>
      <p><a class="btn" href="${str(d.platformUrl ?? '#')}">Crear mi contraseña</a></p>
      <p style="color:#888;font-size:13px">Este enlace expira en 7 días.</p>
    `),
    text: `Hola ${str(d.ownerName)}, la empresa ${str(d.companyName)} fue aprobada. Crea tu contraseña aquí: ${str(d.platformUrl)}`,
  }),

  'kyc-rejected': (d) => ({
    subject: 'Revisión requerida en tu solicitud',
    html: layout('Solicitud requiere ajustes', `
      <p>Hola ${str(d.ownerName)},</p>
      <p>Tu solicitud requiere los siguientes ajustes antes de ser aprobada:</p>
      <div class="warn">${str(d.reason)}</div>
      <p>Por favor ingresa a la plataforma y corrige los documentos indicados.</p>
    `),
    text: `Hola ${str(d.ownerName)}, tu solicitud requiere ajustes: ${str(d.reason)}`,
  }),

  // ── Tareas ────────────────────────────────────────────────────────────────
  'task-reminder': (d) => ({
    subject: `Recordatorio: ${str(d.taskTitle)} vence pronto`,
    html: layout('Recordatorio de tarea', `
      <p>La tarea <strong>${str(d.taskTitle)}</strong> de <strong>${str(d.companyName)}</strong>
         vence el <strong>${str(d.dueDate)}</strong>.</p>
      <p><a class="btn" href="${str(d.taskUrl)}">Ver tarea</a></p>
    `),
    text: `Recordatorio: ${str(d.taskTitle)} (${str(d.companyName)}) vence el ${str(d.dueDate)}. Ver: ${str(d.taskUrl)}`,
  }),

  'task-overdue': (d) => ({
    subject: `Tarea vencida: ${str(d.taskTitle)}`,
    html: layout('Tarea vencida', `
      <p>La tarea <strong>${str(d.taskTitle)}</strong> de <strong>${str(d.companyName)}</strong>
         está vencida.</p>
      <div class="warn">Por favor resuélvela a la brevedad para evitar retrasos.</div>
    `),
    text: `Tarea vencida: ${str(d.taskTitle)} (${str(d.companyName)}). Resuélvela a la brevedad.`,
  }),

  // ── Reset de contraseña ───────────────────────────────────────────────────
  'password-reset': (d) => ({
    subject: 'Restablecer tu contraseña — RS Back Office',
    html: layout('Restablecer contraseña', `
      <p>Hola${d.name ? ` ${str(d.name)}` : ''},</p>
      <p>Recibimos una solicitud para restablecer tu contraseña.</p>
      <p><a class="btn" href="${str(d.resetUrl)}">Restablecer contraseña</a></p>
      <p style="color:#888;font-size:13px">Este enlace expira en 1 hora. Si no solicitaste este cambio, ignora este correo.</p>
    `),
    text: `Hola${d.name ? ` ${str(d.name)}` : ''}, restablece tu contraseña aquí: ${str(d.resetUrl)}. Expira en 1 hora.`,
  }),

  // ── Cobranza ──────────────────────────────────────────────────────────────
  'collection-reminder': (d) => ({
    subject: `Recordatorio de pago — ${str(d.currency)} ${str(d.amount)}`,
    html: layout('Recordatorio de pago', `
      <p>Hola ${str(d.debtorName)},</p>
      <p>Tienes una deuda pendiente de <strong>${str(d.currency)} ${str(d.amount)}</strong>
         con vencimiento el <strong>${str(d.dueDate)}</strong>.</p>
      <p><a class="btn" href="${str(d.paymentUrl)}">Pagar ahora</a></p>
    `),
    text: `Hola ${str(d.debtorName)}, tienes una deuda de ${str(d.currency)} ${str(d.amount)} venciendo el ${str(d.dueDate)}. Paga: ${str(d.paymentUrl)}`,
  }),

  'collection-agreement': (d) => ({
    subject: 'Acuerdo de pago confirmado',
    html: layout('Acuerdo de pago confirmado', `
      <p>Hola ${str(d.debtorName)},</p>
      <p>Tu acuerdo de pago por <strong>${str(d.amount)}</strong>
         en <strong>${str(d.installments)}</strong> cuotas ha sido registrado.</p>
      <div class="info">Próximo pago: <strong>${str(d.nextDate)}</strong></div>
    `),
    text: `${str(d.debtorName)}, tu acuerdo de pago por ${str(d.amount)} en ${str(d.installments)} cuotas fue confirmado. Próximo pago: ${str(d.nextDate)}.`,
  }),

  // ── Solicitudes operativas ────────────────────────────────────────────────
  'request-received': (d) => ({
    subject: `Solicitud recibida: ${str(d.requestTitle)}`,
    html: layout('Solicitud recibida', `
      <p>Tu solicitud <strong>${str(d.requestTitle)}</strong> fue registrada con el ID
         <code>#${str(d.ticketId)}</code>.</p>
      <div class="info">Tiempo estimado de respuesta: <strong>${str(d.slaHours)} horas</strong>.</div>
    `),
    text: `Tu solicitud ${str(d.requestTitle)} (#${str(d.ticketId)}) fue recibida. Te responderemos en ${str(d.slaHours)}h.`,
  }),

  'request-resolved': (d) => ({
    subject: `Solicitud resuelta: ${str(d.requestTitle)}`,
    html: layout('Solicitud resuelta', `
      <p>La solicitud <strong>${str(d.requestTitle)}</strong> (<code>#${str(d.ticketId)}</code>)
         fue resuelta.</p>
      ${d.notes ? `<div class="info">${str(d.notes)}</div>` : ''}
    `),
    text: `Solicitud ${str(d.requestTitle)} (#${str(d.ticketId)}) resuelta.${d.notes ? ` Notas: ${str(d.notes)}` : ''}`,
  }),

  // ── Texto libre (campañas masivas) ───────────────────────────────────────
  'raw-text': (d) => ({
    subject: str(d.subject ?? 'Mensaje'),
    html:    layout('Mensaje', `<p>${str(d.text).replace(/\n/g, '<br>')}</p>`),
    text:    str(d.text),
  }),

  // ── Webhooks / mensajes entrantes ─────────────────────────────────────────
  'inbound-message': (d) => ({
    subject: `Mensaje entrante vía ${str(d.channel)}: ${str(d.from)}`,
    html: layout('Mensaje entrante', `
      <p>Se recibió un mensaje de <strong>${str(d.from)}</strong> vía <strong>${str(d.channel)}</strong>:</p>
      <div class="info">${str(d.text)}</div>
      <p>Ingresa al panel para responder.</p>
    `),
    text: `Mensaje de ${str(d.from)} vía ${str(d.channel)}: ${str(d.text)}`,
  }),
}

// ─── Exportación ─────────────────────────────────────────────────────────────
export async function renderTemplate(
  templateName: string,
  data: Record<string, unknown>,
): Promise<RenderedTemplate> {
  const builder = templates[templateName]
  if (!builder) {
    throw new Error(
      `Template no registrado: "${templateName}". Disponibles: ${Object.keys(templates).join(', ')}`,
    )
  }
  return builder(data)
}

export const AVAILABLE_TEMPLATES = Object.keys(templates)
