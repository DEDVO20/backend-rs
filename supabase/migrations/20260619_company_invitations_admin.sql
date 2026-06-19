-- Add columns for admin invitations and token-based acceptance
ALTER TABLE public.company_invitations
  ALTER COLUMN company_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS token  uuid DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS role   text DEFAULT 'client_user',
  ADD COLUMN IF NOT EXISTS invited_by uuid;

-- Index for token lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_invitations_token ON public.company_invitations(token);
