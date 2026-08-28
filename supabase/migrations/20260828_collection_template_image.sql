-- Plantillas de cartera con imagen adjunta (canal Email).
-- La imagen se sube a Supabase Storage y se guarda su URL pública.
-- Al enviar una campaña por email, la imagen se incrusta en el cuerpo del correo.

alter table collection_templates
  add column if not exists image_url text;

alter table collection_campaigns
  add column if not exists image_url text;

comment on column collection_templates.image_url is
  'URL pública de la imagen adjunta (Supabase Storage). Solo se envía en el canal email.';
comment on column collection_campaigns.image_url is
  'Imagen heredada de la plantilla al crear la campaña; se incrusta en el email enviado.';
