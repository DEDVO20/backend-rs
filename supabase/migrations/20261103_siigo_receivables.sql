-- ─────────────────────────────────────────────────────────────────────────────
-- Cartera Siigo (facturas con saldo a la fecha de corte) — solo para gráficas.
-- Port del script "RAD - CARTERA SIIGO A GOOGLE SHEETS":
-- - Facturas de /v1/invoices con saldo, sin anular.
-- - Control contable por cliente con las cuentas 130505 + 13051001
--   (balance de prueba por tercero): el saldo de las facturas de un cliente
--   nunca supera su saldo contable; la diferencia se descuenta de las más antiguas.
-- Independiente del módulo de cobro (collection_debtors / collection_debts).
--
-- - siigo_receivable_lines:   foto actual por conexión (cada sync la reemplaza).
-- - siigo_receivable_history: saldo por cliente y fecha de corte (evolución).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.siigo_receivable_lines (
  id                   uuid primary key default gen_random_uuid(),
  connection_id        uuid not null references public.siigo_connections(id) on delete cascade,
  cut_date             date not null,
  invoice_id           text not null,
  document_id          bigint,
  prefix               text not null default '',
  number               bigint,
  invoice_name         text not null default '',
  invoice_date         date,
  due_date             date,
  days_overdue         int,
  aging_bucket         text not null check (aging_bucket in ('No vencido', '1-30', '31-60', '61-90', '91+', 'Sin vencimiento')),
  identification       text not null,
  normalized_nit       text not null default '',
  company_id           uuid references public.companies(id) on delete set null,
  branch               int  not null default 0,
  customer_name        text not null default '',
  currency             text not null default 'COP',
  exchange_rate        numeric(16,6) not null default 1,
  seller_id            text not null default '',
  seller_name          text not null default '',
  total_original       numeric(16,2) not null default 0,
  balance_original     numeric(16,2) not null default 0,
  total                numeric(16,2) not null default 0, -- en pesos
  balance_api          numeric(16,2) not null default 0, -- saldo de la factura según la API, en pesos
  control_130505       numeric(16,2),
  control_13051001     numeric(16,2),
  control_total        numeric(16,2),                    -- suma de saldos positivos de ambas cuentas
  control_reduction    numeric(16,2) not null default 0,
  balance              numeric(16,2) not null,           -- saldo final de cartera
  observations         text not null default '',
  siigo_created_at     text not null default '',
  siigo_updated_at     text not null default '',
  synced_at            timestamptz not null default now(),
  unique (connection_id, invoice_id)
);

create index if not exists siigo_receivable_lines_conn_company_idx
  on public.siigo_receivable_lines (connection_id, company_id);

alter table public.siigo_receivable_lines enable row level security;

create table if not exists public.siigo_receivable_history (
  connection_id   uuid not null references public.siigo_connections(id) on delete cascade,
  cut_date        date not null,
  normalized_nit  text not null,
  company_id      uuid references public.companies(id) on delete set null,
  customer_name   text not null default '',
  total           numeric(16,2) not null default 0,
  overdue         numeric(16,2) not null default 0,
  invoices        int not null default 0,
  primary key (connection_id, cut_date, normalized_nit)
);

alter table public.siigo_receivable_history enable row level security;

create table if not exists public.siigo_receivable_sync_logs (
  id                  uuid primary key default gen_random_uuid(),
  connection_id       uuid not null references public.siigo_connections(id) on delete cascade,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running' check (status in ('running', 'completed', 'failed')),
  cut_date            date not null,
  invoices_scanned    int not null default 0,
  invoices_count      int not null default 0,
  customers_count     int not null default 0,
  total_balance       numeric(16,2) not null default 0,
  http_requests_count int not null default 0,
  duration_sec        int not null default 0,
  details             jsonb not null default '{}'::jsonb,
  error_message       text,
  triggered_by        uuid references public.profiles(id) on delete set null
);

create index if not exists siigo_receivable_sync_logs_conn_idx
  on public.siigo_receivable_sync_logs (connection_id, started_at desc);

alter table public.siigo_receivable_sync_logs enable row level security;

-- Reemplaza atómicamente la cartera de una conexión y guarda el saldo por cliente del día
create or replace function public.siigo_replace_receivables(
  p_connection uuid,
  p_cut_date   date,
  p_lines      jsonb
)
returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  delete from public.siigo_receivable_lines where connection_id = p_connection;

  insert into public.siigo_receivable_lines (
    connection_id, cut_date, invoice_id, document_id, prefix, number, invoice_name, invoice_date, due_date,
    days_overdue, aging_bucket, identification, normalized_nit, company_id, branch, customer_name,
    currency, exchange_rate, seller_id, seller_name, total_original, balance_original, total, balance_api,
    control_130505, control_13051001, control_total, control_reduction, balance,
    observations, siigo_created_at, siigo_updated_at, synced_at
  )
  select
    p_connection, p_cut_date, r.invoice_id, r.document_id, coalesce(r.prefix, ''), r.number,
    coalesce(r.invoice_name, ''), r.invoice_date, r.due_date, r.days_overdue, r.aging_bucket,
    r.identification, coalesce(r.normalized_nit, ''), r.company_id, coalesce(r.branch, 0),
    coalesce(r.customer_name, ''), coalesce(r.currency, 'COP'), coalesce(r.exchange_rate, 1),
    coalesce(r.seller_id, ''), coalesce(r.seller_name, ''),
    coalesce(r.total_original, 0), coalesce(r.balance_original, 0), coalesce(r.total, 0), coalesce(r.balance_api, 0),
    r.control_130505, r.control_13051001, r.control_total, coalesce(r.control_reduction, 0), r.balance,
    coalesce(r.observations, ''), coalesce(r.siigo_created_at, ''), coalesce(r.siigo_updated_at, ''), now()
  from jsonb_populate_recordset(null::public.siigo_receivable_lines, coalesce(p_lines, '[]'::jsonb)) r;

  get diagnostics v_inserted = row_count;

  -- Saldo por cliente del día (una nueva sync del mismo día lo reemplaza)
  delete from public.siigo_receivable_history where connection_id = p_connection and cut_date = p_cut_date;

  insert into public.siigo_receivable_history (connection_id, cut_date, normalized_nit, company_id, customer_name, total, overdue, invoices)
  select
    p_connection, p_cut_date,
    coalesce(nullif(normalized_nit, ''), identification),
    (array_agg(company_id) filter (where company_id is not null))[1],
    max(customer_name),
    round(sum(balance), 2),
    round(coalesce(sum(balance) filter (where days_overdue > 0), 0), 2),
    count(*)
  from public.siigo_receivable_lines
  where connection_id = p_connection
  group by coalesce(nullif(normalized_nit, ''), identification);

  return v_inserted;
end;
$$;

/**
 * Agregados para las gráficas de cartera:
 * resumen, edades, clientes, vendedores, facturas más vencidas y evolución diaria.
 * p_company_id: solo internos, un tercero dentro de los libros consultados.
 */
create or replace function public.siigo_receivables_report(
  p_connection uuid,
  p_company_id uuid default null,
  p_from       date default null,
  p_to         date default null
)
returns jsonb
language sql
stable
as $$
  with base as (
    select * from public.siigo_receivable_lines
    where connection_id = p_connection
      and (p_company_id is null or company_id = p_company_id)
  ),
  buckets(bucket, ord) as (
    values ('No vencido', 1), ('1-30', 2), ('31-60', 3), ('61-90', 4), ('91+', 5), ('Sin vencimiento', 6)
  )
  select jsonb_build_object(
    'cutDate', (select max(cut_date) from base),
    'summary', (
      select jsonb_build_object(
        'total',       round(coalesce(sum(balance), 0), 2),
        'vencido',     round(coalesce(sum(balance) filter (where days_overdue > 0), 0), 2),
        'porVencer',   round(coalesce(sum(balance) filter (where days_overdue is null or days_overdue <= 0), 0), 2),
        'facturas',    count(*),
        'clientes',    count(distinct coalesce(nullif(normalized_nit, ''), identification)),
        -- Mora promedio ponderada por saldo (solo facturas vencidas)
        'diasPromedioMora', coalesce(round(
          sum(days_overdue * balance) filter (where days_overdue > 0)
          / nullif(sum(balance) filter (where days_overdue > 0), 0)
        ), 0),
        'reduccionControl', round(coalesce(sum(control_reduction), 0), 2)
      )
      from base
    ),
    'byBucket', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'total', coalesce(x.total, 0), 'facturas', coalesce(x.facturas, 0)) order by b.ord)
      from buckets b
      left join (
        select aging_bucket, round(sum(balance), 2) as total, count(*) as facturas
        from base group by aging_bucket
      ) x on x.aging_bucket = b.bucket
    ), '[]'::jsonb),
    'byCustomer', coalesce((
      select jsonb_agg(c order by c.total desc)
      from (
        select
          identification                                                   as nit,
          coalesce(nullif(max(customer_name), ''), identification)          as name,
          (array_agg(company_id) filter (where company_id is not null))[1]  as "companyId",
          round(sum(balance), 2)                                            as total,
          round(coalesce(sum(balance) filter (where days_overdue > 0), 0), 2) as vencido,
          count(*)                                                          as facturas,
          coalesce(max(days_overdue), 0)                                    as "maxDias"
        from base
        group by identification
        order by sum(balance) desc
        limit 15
      ) c
    ), '[]'::jsonb),
    'bySeller', coalesce((
      select jsonb_agg(s order by s.total desc)
      from (
        select
          coalesce(nullif(seller_name, ''), nullif(seller_id, ''), 'Sin vendedor') as seller,
          round(sum(balance), 2)                                                 as total,
          round(coalesce(sum(balance) filter (where days_overdue > 0), 0), 2)    as vencido,
          count(*)                                                               as facturas
        from base
        group by 1
      ) s
    ), '[]'::jsonb),
    'oldest', coalesce((
      select jsonb_agg(o order by o."dias" desc, o.balance desc)
      from (
        select
          invoice_name                                             as invoice,
          coalesce(nullif(customer_name, ''), identification)      as customer,
          due_date                                                 as "dueDate",
          days_overdue                                             as dias,
          balance
        from base
        where days_overdue > 0
        order by days_overdue desc, balance desc
        limit 10
      ) o
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(h order by h."cutDate")
      from (
        select cut_date as "cutDate", round(sum(total), 2) as total, round(sum(overdue), 2) as vencido
        from public.siigo_receivable_history
        where connection_id = p_connection
          and (p_company_id is null or company_id = p_company_id)
          and (p_from is null or cut_date >= p_from)
          and (p_to   is null or cut_date <= p_to)
        group by cut_date
      ) h
    ), '[]'::jsonb)
  )
$$;

-- Solo el backend (service_role) ejecuta estas funciones
revoke execute on function public.siigo_replace_receivables(uuid, date, jsonb) from public, anon, authenticated;
grant  execute on function public.siigo_replace_receivables(uuid, date, jsonb) to service_role;
revoke execute on function public.siigo_receivables_report(uuid, uuid, date, date) from public, anon, authenticated;
grant  execute on function public.siigo_receivables_report(uuid, uuid, date, date) to service_role;
