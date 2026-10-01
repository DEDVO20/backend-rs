-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos para el módulo 'leads' (cotizador del landing page)
-- Permite ver y gestionar leads a los roles admin y rs_admin
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.role_permissions (role_key, module, can_view, can_create, can_update, can_delete)
values
  ('admin', 'leads', true, true, true, true),
  ('rs_admin', 'leads', true, true, true, true)
on conflict (role_key, module) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_update = excluded.can_update,
  can_delete = excluded.can_delete;
