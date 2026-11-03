-- ─────────────────────────────────────────────────────────────────────────────
-- Permisos para el módulo 'services_admin' (catálogo de servicios)
-- Crear/editar/desactivar servicios: admin y rs_admin
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.role_permissions (role_key, module, can_view, can_create, can_update, can_delete)
values
  ('admin', 'services_admin', true, true, true, true),
  ('rs_admin', 'services_admin', true, true, true, true)
on conflict (role_key, module) do update
set
  can_view = excluded.can_view,
  can_create = excluded.can_create,
  can_update = excluded.can_update,
  can_delete = excluded.can_delete;
