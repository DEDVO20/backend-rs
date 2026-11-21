-- ─────────────────────────────────────────────────────────────────────────────
-- Inactivación de empresas.
-- - status = 'inactive' bloquea el acceso de sus usuarios al portal (los perfiles
--   no se tocan: al reactivar recuperan el acceso tal como estaba).
-- - La empresa deja de generar tareas automáticas y sus conexiones de Siigo y
--   HubSpot se excluyen de las sincronizaciones diarias.
-- - Se guarda quién, cuándo y por qué se inactivó (auditoría).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.companies
  add column if not exists inactivated_at      timestamptz,
  add column if not exists inactivated_by      uuid references public.profiles(id) on delete set null,
  add column if not exists inactivation_reason text;

-- Unificar el valor en español que existía en algunos registros
update public.companies set status = 'inactive' where status = 'inactiva';
