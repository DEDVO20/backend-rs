-- Columnas para trackear el broadcast de Zavu en campañas de cobranza
ALTER TABLE public.collection_campaigns
  ADD COLUMN IF NOT EXISTS broadcast_id text,
  ADD COLUMN IF NOT EXISTS sent_at      timestamptz;
