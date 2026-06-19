-- Tabla de audit log para rastrear acciones críticas del sistema
create table if not exists audit_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  user_email    text,
  user_role     text,
  company_id    uuid,
  action        text        not null,  -- 'create' | 'update' | 'delete' | 'login' | 'invite' | etc.
  resource      text        not null,  -- tabla o entidad afectada: 'companies', 'tasks', etc.
  resource_id   text,                  -- id del registro afectado (puede ser uuid o string)
  metadata      jsonb,                 -- payload adicional (cambios, parámetros, etc.)
  ip_address    text,
  user_agent    text,
  created_at    timestamptz not null default now()
);

-- Índices para consultas frecuentes
create index if not exists audit_logs_user_id_idx     on audit_logs (user_id);
create index if not exists audit_logs_resource_idx    on audit_logs (resource, resource_id);
create index if not exists audit_logs_company_id_idx  on audit_logs (company_id);
create index if not exists audit_logs_created_at_idx  on audit_logs (created_at desc);
create index if not exists audit_logs_action_idx      on audit_logs (action);

-- Solo admins pueden leer audit_logs; nadie puede insertar/modificar desde el cliente
alter table audit_logs enable row level security;

create policy "admins pueden leer audit_logs"
  on audit_logs for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.role in ('admin', 'rs_admin')
    )
  );

-- Inserción solo desde service_role (el backend)
-- No se necesita policy de insert porque service_role bypasea RLS
