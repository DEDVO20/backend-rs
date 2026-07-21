-- Módulo: Participación de Terceros en la Facturación
-- Administra la participación de terceros sobre servicios contratados y el
-- cálculo mensual de dichas participaciones. Sin integración SIIGO en v1:
-- la facturación se registra manualmente y se concilia contra lo calculado.

-- Valor mensual del servicio (antes de IVA) — vive en el servicio contratado
alter table company_services add column if not exists service_value numeric(14,2);

-- ── Catálogo de terceros ─────────────────────────────────────────────────────
create table if not exists third_parties (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  identification text,            -- NIT o documento
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- ── Configuración de participación por servicio contratado ───────────────────
create table if not exists service_participations (
  id                 uuid primary key default gen_random_uuid(),
  company_service_id uuid not null references company_services(id) on delete cascade,
  third_party_id     uuid not null references third_parties(id) on delete restrict,
  percentage         numeric(5,2) not null check (percentage >= 0 and percentage <= 100),
  start_date         date not null,
  -- "Tiene tercero": el servicio tiene participación configurada
  has_third_party    boolean not null default true,
  -- "Estado": activa/suspendida. Independiente de has_third_party (spec §1)
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Un servicio contratado tiene a lo sumo una participación de tercero
  unique (company_service_id)
);

-- Idempotente por si la tabla ya existía sin la columna
alter table service_participations add column if not exists has_third_party boolean not null default true;

create index if not exists service_participations_cs_idx on service_participations (company_service_id);

-- ── Participación mensual calculada por el cron ──────────────────────────────
create table if not exists monthly_participations (
  id                  uuid primary key default gen_random_uuid(),
  participation_id    uuid not null references service_participations(id) on delete cascade,
  month               int not null check (month between 1 and 12),
  year                int not null,
  service_value       numeric(14,2) not null,
  percentage          numeric(5,2) not null,
  participation_value numeric(14,2) not null,
  purchase_order      text not null,          -- OC-YYYYMM-NNNNNN
  status              text not null default 'pending',  -- pending | validated | review
  generated_at        timestamptz not null default now(),
  -- Evitar duplicados para el mismo servicio, mes y año
  unique (participation_id, month, year)
);

create index if not exists monthly_participations_period_idx on monthly_participations (year, month);

-- ── Registro manual de facturación (Finto + tercero) ─────────────────────────
create table if not exists participation_invoicing (
  id                        uuid primary key default gen_random_uuid(),
  monthly_participation_id  uuid not null references monthly_participations(id) on delete cascade,
  finto_invoice             text,
  finto_invoice_date        date,
  finto_invoice_value       numeric(14,2),
  third_party_invoice       text,
  third_party_invoice_date  date,
  third_party_invoice_value numeric(14,2),
  observations              text,
  updated_by                uuid references auth.users(id) on delete set null,
  updated_at                timestamptz not null default now(),
  unique (monthly_participation_id)
);

-- Solo el backend (service_role) accede a estas tablas
alter table third_parties           enable row level security;
alter table service_participations  enable row level security;
alter table monthly_participations  enable row level security;
alter table participation_invoicing enable row level security;
