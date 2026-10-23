-- ─────────────────────────────────────────────────────────────────────────────
-- Consultas de Facturación y Ventas Siigo (Ítem por Ítem)
-- Almacena las líneas desglosadas de Facturas (FV) y Notas Crédito (NC) desde
-- la API de Siigo, vinculadas por NIT con la tabla `companies` para permitir
-- consultas multi-empresa (cada cliente ve solo sus propios datos) y alimentar
-- los dashboards de clientes.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.siigo_sales_lines (
  id                  uuid primary key default gen_random_uuid(),
  siigo_doc_id        text not null,
  line_index          int  not null default 0,
  doc_type            text not null check (doc_type in ('FACTURA', 'NOTA_CREDITO')),
  comprobante         text not null,
  doc_date            date not null,
  period              text not null, -- 'YYYY-MM'
  customer_nit        text not null default '',
  normalized_nit      text not null default '',
  company_id          uuid references public.companies(id) on delete set null,
  sucursal            text not null default '',
  customer_name       text not null default '',
  seller_id           text not null default '',
  product_code        text not null default '',
  product_description text not null default '',
  gross_value         numeric(14,2) not null default 0,
  discount            numeric(14,2) not null default 0,
  subtotal            numeric(14,2) not null default 0,
  tax_charge          numeric(14,2) not null default 0,
  tax_retention       numeric(14,2) not null default 0,
  total_charges       numeric(14,2) not null default 0,
  total_discounts     numeric(14,2) not null default 0,
  total               numeric(14,2) not null default 0,
  synced_at           timestamptz not null default now(),
  unique (siigo_doc_id, line_index)
);

create index if not exists siigo_sales_lines_company_idx    on public.siigo_sales_lines (company_id);
create index if not exists siigo_sales_lines_norm_nit_idx   on public.siigo_sales_lines (normalized_nit);
create index if not exists siigo_sales_lines_date_idx       on public.siigo_sales_lines (doc_date desc);
create index if not exists siigo_sales_lines_period_idx     on public.siigo_sales_lines (period);
create index if not exists siigo_sales_lines_doc_type_idx   on public.siigo_sales_lines (doc_type);
create index if not exists siigo_sales_lines_comprobante_idx on public.siigo_sales_lines (comprobante);

alter table public.siigo_sales_lines enable row level security;

-- Historial de ejecuciones de sincronización con Siigo API
create table if not exists public.siigo_sync_logs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running' check (status in ('running', 'completed', 'failed')),
  start_date          date not null,
  end_date            date not null,
  seller_filter       text not null default '',
  invoices_count      int  not null default 0,
  credit_notes_count  int  not null default 0,
  lines_count         int  not null default 0,
  http_requests_count int  not null default 0,
  duration_sec        int  not null default 0,
  error_message       text,
  triggered_by        uuid references public.profiles(id) on delete set null
);

create index if not exists siigo_sync_logs_started_idx on public.siigo_sync_logs (started_at desc);

alter table public.siigo_sync_logs enable row level security;

-- Caché persistente de catálogos de Siigo (clientes y productos)
create table if not exists public.siigo_catalog_cache (
  cache_type  text not null check (cache_type in ('customer', 'product')),
  cache_key   text not null,
  value       text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (cache_type, cache_key)
);

alter table public.siigo_catalog_cache enable row level security;

-- Permisos para el módulo 'siigo' (Consultas de Facturación Siigo)
insert into public.role_permissions (role_key, module, can_view, can_create, can_update, can_delete)
values
  ('admin',        'siigo', true, true, true, true),
  ('rs_admin',     'siigo', true, true, true, true),
  ('rs_staff',     'siigo', true, false, false, false),
  ('contador',     'siigo', true, true, true, false),
  ('client_owner', 'siigo', true, false, false, false),
  ('client_user',  'siigo', true, false, false, false)
on conflict (role_key, module) do update
set
  can_view   = excluded.can_view,
  can_create = excluded.can_create,
  can_update = excluded.can_update,
  can_delete = excluded.can_delete;
