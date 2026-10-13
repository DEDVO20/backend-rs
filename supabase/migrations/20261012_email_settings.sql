-- Ajustes de envío de correo administrables desde la plataforma (Configuración).
-- Una sola fila (id=1): proveedor de email y copias ocultas globales.
-- Mientras no exista la fila, el backend usa EMAIL_PROVIDER / EMAIL_BCC del entorno.
-- SMS y WhatsApp no dependen de esto: siempre salen por Zavu.

create table if not exists email_settings (
  id         int primary key default 1 check (id = 1),
  provider   text not null default 'zavu' check (provider in ('zavu', 'resend')),
  -- Copias ocultas (BCC) en todos los correos — solo aplican con Resend
  bcc        text[] not null default '{}',
  updated_by uuid,
  updated_at timestamptz not null default now()
);

alter table email_settings enable row level security;
