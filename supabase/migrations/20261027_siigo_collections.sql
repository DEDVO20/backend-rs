-- ─────────────────────────────────────────────────────────────────────────────
-- Recaudo Siigo (recibos de caja / vouchers RC)
-- Un registro por movimiento aplicado de cada recibo (factura, anticipo, saldo a
-- favor…), vinculado por NIT con `companies` para el aislamiento multi-empresa.
-- La sincronización reprocesa el periodo completo en orden cronológico (la
-- resolución de saldos depende del orden), por eso reemplaza por rango de fechas.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.siigo_collection_lines (
  id                  uuid primary key default gen_random_uuid(),
  voucher_id          text not null default '',
  line_index          int  not null default 0,
  collection_date     date not null,
  period              text not null, -- 'YYYY-MM'
  receipt             text not null, -- RC-1-45
  customer_nit        text not null default '',
  normalized_nit      text not null default '',
  company_id          uuid references public.companies(id) on delete set null,
  customer_name       text not null default '',
  invoice             text not null default '', -- documento aplicado (FV, CC, RC)
  product_code        text not null default '',
  product_description text not null default '',
  installment         text not null default '',
  due_date            date,
  applied_value       numeric(14,2) not null default 0,
  movement_class      text not null default 'ITEM'
                      check (movement_class in ('ITEM', 'ANTICIPO', 'OTRO_INGRESO', 'PAGO_SIN_ITEMS')),
  account             text not null default '',
  observations        text not null default '',
  synced_at           timestamptz not null default now()
);

create index if not exists siigo_collection_lines_company_date_idx
  on public.siigo_collection_lines (company_id, collection_date desc, receipt, line_index);
create index if not exists siigo_collection_lines_date_idx
  on public.siigo_collection_lines (collection_date desc);
create index if not exists siigo_collection_lines_nit_idx
  on public.siigo_collection_lines (normalized_nit);

alter table public.siigo_collection_lines enable row level security;

create table if not exists public.siigo_collection_sync_logs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running' check (status in ('running', 'completed', 'failed')),
  start_date          date not null,
  end_date            date not null,
  vouchers_count      int  not null default 0,
  lines_count         int  not null default 0,
  total_applied       numeric(16,2) not null default 0,
  http_requests_count int  not null default 0,
  duration_sec        int  not null default 0,
  details             jsonb not null default '{}'::jsonb,
  error_message       text,
  triggered_by        uuid references public.profiles(id) on delete set null
);

create index if not exists siigo_collection_sync_logs_started_idx
  on public.siigo_collection_sync_logs (started_at desc);

alter table public.siigo_collection_sync_logs enable row level security;

-- Reemplaza atómicamente las líneas del rango sincronizado
create or replace function public.siigo_replace_collection_lines(
  p_start date,
  p_end   date,
  p_lines jsonb
)
returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  delete from public.siigo_collection_lines
  where collection_date between p_start and p_end;

  insert into public.siigo_collection_lines (
    voucher_id, line_index, collection_date, period, receipt, customer_nit, normalized_nit,
    company_id, customer_name, invoice, product_code, product_description, installment,
    due_date, applied_value, movement_class, account, observations, synced_at
  )
  select
    r.voucher_id, r.line_index, r.collection_date, r.period, r.receipt, r.customer_nit, r.normalized_nit,
    r.company_id, r.customer_name, r.invoice, r.product_code, r.product_description, r.installment,
    r.due_date, r.applied_value, r.movement_class, r.account, r.observations, now()
  from jsonb_populate_recordset(null::public.siigo_collection_lines, coalesce(p_lines, '[]'::jsonb)) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.siigo_collection_lines_filtered(
  p_company_id uuid default null,
  p_start      date default null,
  p_end        date default null,
  p_nit        text default null,
  p_search     text default null
)
returns setof public.siigo_collection_lines
language sql
stable
as $$
  select l.*
  from public.siigo_collection_lines l
  where (p_company_id is null or l.company_id = p_company_id)
    and (p_start      is null or l.collection_date >= p_start)
    and (p_end        is null or l.collection_date <= p_end)
    and (
      p_nit is null
      or position(p_nit in l.normalized_nit) > 0
      or (length(p_nit) = length(l.normalized_nit) + 1 and left(p_nit, -1) = l.normalized_nit)
    )
    and (
      p_search is null
      or position(lower(p_search) in lower(concat_ws(' ',
           l.receipt, l.invoice, l.customer_name, l.customer_nit, l.product_description, l.observations))) > 0
    )
$$;

-- KPIs y agregados de recaudo (mensual, por servicio y por cliente)
create or replace function public.siigo_collection_report(
  p_company_id        uuid    default null,
  p_start             date    default null,
  p_end               date    default null,
  p_nit               text    default null,
  p_search            text    default null,
  p_include_customers boolean default false
)
returns jsonb
language sql
stable
as $$
  with f as (
    select * from public.siigo_collection_lines_filtered(p_company_id, p_start, p_end, p_nit, p_search)
  )
  select jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'totalRecaudado', round(coalesce(sum(applied_value), 0), 2),
        'recibos',        count(distinct receipt),
        'movimientos',    count(*),
        'facturas',       count(distinct invoice) filter (where invoice ilike 'FV-%'),
        'anticipos',      round(coalesce(sum(applied_value) filter (where movement_class <> 'ITEM' or invoice not ilike 'FV-%'), 0), 2),
        'clientes',       count(distinct nullif(customer_nit, ''))
      )
      from f
    ),
    'monthly', coalesce((
      select jsonb_agg(m order by m.period)
      from (
        select
          period,
          round(sum(applied_value), 2) as recaudado,
          count(distinct receipt)      as recibos,
          count(*)                     as movimientos
        from f
        group by period
      ) m
    ), '[]'::jsonb),
    'byProduct', coalesce((
      select jsonb_agg(p order by p.recaudado desc)
      from (
        select
          coalesce(nullif(product_description, ''), 'Sin producto (anticipos / otros)') as description,
          round(sum(applied_value), 2) as recaudado,
          count(*)                     as movimientos
        from f
        group by coalesce(nullif(product_description, ''), 'Sin producto (anticipos / otros)')
      ) p
    ), '[]'::jsonb),
    'byCustomer', case when p_include_customers then coalesce((
      select jsonb_agg(c order by c.recaudado desc)
      from (
        select
          max(customer_nit)                                           as nit,
          coalesce(nullif(max(customer_name), ''), max(customer_nit)) as name,
          (array_agg(company_id) filter (where company_id is not null))[1] as "companyId",
          count(distinct receipt)      as recibos,
          round(sum(applied_value), 2) as recaudado
        from f
        group by coalesce(nullif(customer_nit, ''), nullif(customer_name, ''), 'SIN_NIT')
      ) c
    ), '[]'::jsonb) else '[]'::jsonb end
  )
$$;

revoke execute on function public.siigo_replace_collection_lines(date, date, jsonb) from public, anon, authenticated;
revoke execute on function public.siigo_collection_lines_filtered(uuid, date, date, text, text) from public, anon, authenticated;
revoke execute on function public.siigo_collection_report(uuid, date, date, text, text, boolean) from public, anon, authenticated;

grant execute on function public.siigo_replace_collection_lines(date, date, jsonb) to service_role;
grant execute on function public.siigo_collection_lines_filtered(uuid, date, date, text, text) to service_role;
grant execute on function public.siigo_collection_report(uuid, date, date, text, text, boolean) to service_role;
