-- Cada campaña de WhatsApp guarda la plantilla aprobada por Meta (Zavu) que usa.
-- Antes había una sola plantilla global por variable de entorno (ZAVU_WA_TEMPLATE_ID),
-- que queda solo como fallback.

alter table collection_campaigns add column if not exists zavu_template_id text;

comment on column collection_campaigns.zavu_template_id is
  'ID de la plantilla de WhatsApp en Zavu (aprobada por Meta) usada por esta campaña';
