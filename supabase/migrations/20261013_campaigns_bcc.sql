-- Copias ocultas (BCC) por campaña de cobranza por email.
-- Cada correo de la campaña sale con estas direcciones en copia oculta.
-- Solo aplica cuando el proveedor de correo es Resend (Zavu no las soporta).

alter table collection_campaigns add column if not exists bcc text[] not null default '{}';

comment on column collection_campaigns.bcc is
  'Correos en copia oculta de cada email de la campaña (solo con Resend)';
