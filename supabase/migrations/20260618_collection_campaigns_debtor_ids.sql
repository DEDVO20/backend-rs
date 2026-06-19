-- Columnas para envío masivo directo desde el panel de cobranza
ALTER TABLE public.collection_campaigns
  ADD COLUMN IF NOT EXISTS debtor_ids       uuid[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS message_template text,
  ADD COLUMN IF NOT EXISTS recipient_count  integer DEFAULT 0;
