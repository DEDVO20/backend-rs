-- Ampliar el check constraint de frequency en task_templates para incluir 'daily'
-- La tabla fue creada sin 'daily' en el constraint original

ALTER TABLE public.task_templates 
  DROP CONSTRAINT IF EXISTS task_templates_frequency_check;

ALTER TABLE public.task_templates 
  ADD CONSTRAINT task_templates_frequency_check 
  CHECK (frequency IN ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semestral', 'annual'));
