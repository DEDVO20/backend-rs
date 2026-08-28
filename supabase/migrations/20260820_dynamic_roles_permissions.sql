-- ─────────────────────────────────────────────────────────────────────────────
-- Roles y permisos dinámicos (administrables desde la app)
-- Mueve la asignación módulo→rol de código a base de datos, con granularidad
-- por acción: ver / crear / editar / eliminar.
-- ─────────────────────────────────────────────────────────────────────────────

-- Catálogo de roles. Los 6 base entran como is_system (no borrables).
create table if not exists public.roles (
  key         text primary key,
  name        text not null,
  description text,
  scope       text not null default 'internal' check (scope in ('internal', 'client')),
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Un renglón = qué puede hacer un rol sobre un módulo.
create table if not exists public.role_permissions (
  role_key   text    not null references public.roles(key) on delete cascade,
  module     text    not null,
  can_view   boolean not null default true,
  can_create boolean not null default false,
  can_update boolean not null default false,
  can_delete boolean not null default false,
  primary key (role_key, module)
);

create index if not exists idx_role_permissions_role on public.role_permissions(role_key);

-- ── Siembra: roles base ───────────────────────────────────────────────────────
insert into public.roles (key, name, description, scope, is_system) values
  ('admin',        'Administrador',        'Acceso total al sistema',            'internal', true),
  ('rs_admin',     'Administrador Finto',  'Gestión interna de la firma',        'internal', true),
  ('rs_staff',     'Staff Finto',          'Operación interna',                  'internal', true),
  ('contador',     'Contador',             'Contabilidad y participaciones',     'internal', true),
  ('client_owner', 'Titular',              'Titular de la empresa cliente',      'client',   true),
  ('client_user',  'Usuario',              'Usuario de la empresa cliente',      'client',   true)
on conflict (key) do nothing;

-- ── Siembra: permisos, reflejando el MODULE_PERMISSIONS actual ────────────────
-- Todo rol que hoy tiene acceso recibe CRUD completo sobre el módulo; el admin
-- podrá restringir acciones desde la UI. Preserva el comportamiento actual.
with pairs(role_key, module) as (values
  -- dashboard: todos
  ('admin','dashboard'),('rs_admin','dashboard'),('rs_staff','dashboard'),
  ('contador','dashboard'),('client_owner','dashboard'),('client_user','dashboard'),
  -- onboarding
  ('admin','onboarding'),('rs_admin','onboarding'),('rs_staff','onboarding'),
  -- companies
  ('admin','companies'),('rs_admin','companies'),('rs_staff','companies'),('client_owner','companies'),
  -- tasks: todos
  ('admin','tasks'),('rs_admin','tasks'),('rs_staff','tasks'),
  ('contador','tasks'),('client_owner','tasks'),('client_user','tasks'),
  -- operational_requests
  ('admin','operational_requests'),('rs_admin','operational_requests'),('rs_staff','operational_requests'),
  ('client_owner','operational_requests'),('client_user','operational_requests'),
  -- collection
  ('admin','collection'),('rs_admin','collection'),('rs_staff','collection'),('client_owner','collection'),
  -- accounting
  ('admin','accounting'),('rs_admin','accounting'),('contador','accounting'),
  -- participations
  ('admin','participations'),('rs_admin','participations'),('contador','participations'),
  -- documents: todos
  ('admin','documents'),('rs_admin','documents'),('rs_staff','documents'),
  ('contador','documents'),('client_owner','documents'),('client_user','documents'),
  -- team_management
  ('admin','team_management'),('rs_admin','team_management'),('client_owner','team_management'),
  -- users_admin (solo admin)
  ('admin','users_admin'),
  -- settings
  ('admin','settings'),('rs_admin','settings'),
  -- notifications_log
  ('admin','notifications_log'),('rs_admin','notifications_log'),
  -- roles (nueva página de administración de roles — solo admin)
  ('admin','roles')
)
insert into public.role_permissions (role_key, module, can_view, can_create, can_update, can_delete)
select role_key, module, true, true, true, true from pairs
on conflict (role_key, module) do nothing;

-- ── profiles.role referencia a roles.key ──────────────────────────────────────
-- NOT VALID: no revalida filas legadas, pero aplica de aquí en adelante.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_fk'
  ) then
    alter table public.profiles
      add constraint profiles_role_fk
      foreign key (role) references public.roles(key)
      not valid;
  end if;
end $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Toda escritura y lectura funcional pasa por el backend (service_role, que
-- bypassa RLS). Se habilita RLS y solo se expone SELECT a admin/rs_admin como
-- defensa en profundidad; no hay policies de insert/update/delete a propósito,
-- así ningún cliente con anon/authenticated puede modificar roles ni permisos.
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;

create policy "roles: admins pueden leer"
  on public.roles for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role in ('admin', 'rs_admin')
    )
  );

create policy "role_permissions: admins pueden leer"
  on public.role_permissions for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role in ('admin', 'rs_admin')
    )
  );
