-- ─────────────────────────────────────────────────────────────────────────────
-- contact_leads v2: almacena los leads del cotizador del landing page
-- Si la tabla ya existe, aplica los cambios de columnas necesarios
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.contact_leads (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Servicios seleccionados (csv de módulos, ej: "control,contabilidad")
  service         text not null,

  -- Tamaño de operación: '0-3' | '4-9' | '10-24' | '25+'
  company_size    text not null,

  -- Volumen mensual (ya no se pregunta, se guarda como NULL)
  monthly_volume  text,

  -- Cuándo quiere empezar
  start_date      text not null,

  -- Datos de contacto (email es el campo más importante)
  name            text not null,
  company         text not null,
  phone           text not null,
  email           text not null,

  -- Seguimiento interno
  status          text not null default 'new' check (status in ('new', 'contacted', 'converted', 'lost')),
  notes           text
);

-- Si la tabla ya existe pero monthly_volume es NOT NULL, hacerla nullable
alter table public.contact_leads
  alter column monthly_volume drop not null;

-- Índices útiles para el CRM interno
create index if not exists contact_leads_email_idx   on public.contact_leads (email);
create index if not exists contact_leads_status_idx  on public.contact_leads (status);
create index if not exists contact_leads_created_idx on public.contact_leads (created_at desc);

-- RLS: solo el service_role puede leer/escribir
alter table public.contact_leads enable row level security;
