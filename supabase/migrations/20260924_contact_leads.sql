-- ─────────────────────────────────────────────────────────────────────────────
-- contact_leads: almacena los leads del formulario del landing page
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.contact_leads (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Pregunta 1
  service         text not null,

  -- Pregunta 2
  company_size    text not null,

  -- Pregunta 3 (libre según servicio seleccionado)
  monthly_volume  text not null,

  -- Pregunta 4
  start_date      text not null,

  -- Datos de contacto
  name            text not null,
  company         text not null,
  phone           text not null,
  email           text not null,

  -- Seguimiento interno
  status          text not null default 'new' check (status in ('new', 'contacted', 'converted', 'lost')),
  notes           text
);

-- Índices útiles para el CRM interno
create index if not exists contact_leads_email_idx    on public.contact_leads (email);
create index if not exists contact_leads_status_idx   on public.contact_leads (status);
create index if not exists contact_leads_created_idx  on public.contact_leads (created_at desc);

-- RLS: solo el service_role puede leer/escribir (el backend usa service_role key)
alter table public.contact_leads enable row level security;

-- No se expone a usuarios autenticados normales desde el cliente
-- El backend (service role) tiene acceso completo sin RLS
