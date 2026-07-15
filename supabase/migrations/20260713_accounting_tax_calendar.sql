-- Módulo de Contabilidad: calendario tributario maestro + fichas por empresa.
--
-- - tax_calendar_master: plantilla maestra (solo Super Admin la modifica).
-- - company_tax_entries: copia de la maestra por empresa con servicio contable;
--   el contador diligencia las fechas de vencimiento de cada cliente.
-- - El cron crea tareas en `tasks` 5 días antes de cada due_date
--   (unique_key 'taxcal_{entry_id}_{año}' para idempotencia).

-- ── Rol contador ─────────────────────────────────────────────────────────────
-- Si profiles.role tiene un check constraint, ampliarlo para incluir 'contador'.
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'rs_admin', 'rs_staff', 'contador', 'client_owner', 'client_user'));

-- ── Plantilla maestra ────────────────────────────────────────────────────────
create table if not exists tax_calendar_master (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  is_mandatory  boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Ficha por empresa ────────────────────────────────────────────────────────
create table if not exists company_tax_entries (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  master_id     uuid not null references tax_calendar_master(id) on delete cascade,
  is_mandatory  boolean not null default true,
  due_date      date,
  notes         text,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, master_id)
);

create index if not exists company_tax_entries_company_idx  on company_tax_entries (company_id);
create index if not exists company_tax_entries_due_date_idx on company_tax_entries (due_date);

-- Solo el backend (service_role) accede a estas tablas
alter table tax_calendar_master  enable row level security;
alter table company_tax_entries  enable row level security;

-- ── Semilla inicial de la maestra (editable por el Super Admin) ──────────────
insert into tax_calendar_master (title, description, is_mandatory, sort_order)
select * from (values
  ('Declaración de renta',                    'Impuesto de renta y complementarios',            true,  1),
  ('Declaración de IVA',                      'Impuesto sobre las ventas',                      true,  2),
  ('Retención en la fuente',                  'Declaración mensual de retenciones',             true,  3),
  ('Industria y comercio (ICA)',              'Impuesto de industria y comercio',               true,  4),
  ('Información exógena nacional',            'Medios magnéticos DIAN',                         true,  5),
  ('Información exógena distrital/municipal', 'Medios magnéticos entes territoriales',          false, 6),
  ('Impuesto al patrimonio',                  'Solo si aplica según patrimonio líquido',        false, 7),
  ('Renovación matrícula mercantil',          'Cámara de comercio',                             false, 8)
) as seed(title, description, is_mandatory, sort_order)
where not exists (select 1 from tax_calendar_master);
