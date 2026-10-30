-- ─────────────────────────────────────────────────────────────────────────────
-- Siigo multiempresa: una conexión (credenciales) por cuenta de Siigo
--
-- Hasta ahora todo venía de UNA cuenta, la de Finto. Cada empresa cliente tiene
-- su propia cuenta de Siigo: sus clientes deben ver SUS libros, no los de Finto.
--
-- - siigo_connections: la conexión de plataforma (Finto, sin empresa) y una por empresa.
-- - Todas las tablas Siigo llevan connection_id ("de quién son los libros").
--   company_id sigue indicando el TERCERO (p. ej. el cliente dentro de los libros de Finto).
-- - Los datos existentes se asignan a la conexión de Finto.
-- - Todas las funciones reciben p_connection (obligatorio) y solo tocan esos libros.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.siigo_connections (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid unique references public.companies(id) on delete cascade,
  is_platform            boolean not null default false,
  label                  text not null,
  username               text not null default '',
  access_key_enc         text,          -- AES-256-GCM, cifrada por el backend (nunca sale al navegador)
  partner_id             text not null default '',
  seller_filter          text not null default '',
  sales_start_year       int,
  collections_start_date date,
  active                 boolean not null default true,
  last_test_at           timestamptz,
  last_test_ok           boolean,
  last_test_message      text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references public.profiles(id) on delete set null,
  constraint siigo_connections_owner_chk check (
    (is_platform and company_id is null) or (not is_platform and company_id is not null)
  )
);

create unique index if not exists siigo_connections_one_platform
  on public.siigo_connections (is_platform) where is_platform;

alter table public.siigo_connections enable row level security;

-- Conexión de plataforma (Finto). Sus credenciales pueden venir del .env del backend.
insert into public.siigo_connections (is_platform, label)
select true, 'Finto'
where not exists (select 1 from public.siigo_connections where is_platform);

-- ── connection_id en todas las tablas, con los datos existentes asignados a Finto ──
do $$
declare
  v_platform uuid := (select id from public.siigo_connections where is_platform);
  t text;
begin
  foreach t in array array[
    'siigo_sales_lines', 'siigo_sync_logs', 'siigo_catalog_cache',
    'siigo_collection_lines', 'siigo_collection_sync_logs',
    'siigo_trial_balance_lines', 'siigo_trial_balance_periods', 'siigo_trial_balance_sync_logs'
  ] loop
    execute format('alter table public.%I add column if not exists connection_id uuid references public.siigo_connections(id) on delete cascade', t);
    execute format('update public.%I set connection_id = $1 where connection_id is null', t) using v_platform;
    execute format('alter table public.%I alter column connection_id set not null', t);
  end loop;
end $$;

-- Claves únicas por conexión (dos cuentas de Siigo pueden repetir ids, comprobantes o periodos)
alter table public.siigo_sales_lines drop constraint if exists siigo_sales_lines_siigo_doc_id_line_index_key;
alter table public.siigo_sales_lines
  add constraint siigo_sales_lines_conn_doc_line_key unique (connection_id, siigo_doc_id, line_index);

alter table public.siigo_catalog_cache drop constraint if exists siigo_catalog_cache_pkey;
alter table public.siigo_catalog_cache add primary key (connection_id, cache_type, cache_key);

alter table public.siigo_trial_balance_periods drop constraint if exists siigo_trial_balance_periods_pkey;
alter table public.siigo_trial_balance_periods add primary key (connection_id, period);

create index if not exists siigo_sales_lines_conn_date_idx       on public.siigo_sales_lines (connection_id, doc_date desc);
create index if not exists siigo_sync_logs_conn_idx              on public.siigo_sync_logs (connection_id, started_at desc);
create index if not exists siigo_collection_lines_conn_date_idx  on public.siigo_collection_lines (connection_id, collection_date desc);
create index if not exists siigo_collection_sync_logs_conn_idx   on public.siigo_collection_sync_logs (connection_id, started_at desc);
create index if not exists siigo_trial_balance_conn_period_idx   on public.siigo_trial_balance_lines (connection_id, period, account_code);
create index if not exists siigo_trial_balance_sync_logs_conn_idx on public.siigo_trial_balance_sync_logs (connection_id, started_at desc);

-- ── Funciones: se reemplazan por versiones con p_connection ─────────────────────
drop function if exists public.siigo_sales_report(uuid, date, date, text, text, text, text, text, boolean);
drop function if exists public.siigo_sales_lines_filtered(uuid, date, date, text, text, text, text, text);
drop function if exists public.siigo_replace_doc_lines(text[], text[], jsonb);
drop function if exists public.siigo_unlinked_nits();
drop function if exists public.siigo_collection_report(uuid, date, date, text, text, boolean);
drop function if exists public.siigo_collection_lines_filtered(uuid, date, date, text, text);
drop function if exists public.siigo_replace_collection_lines(date, date, jsonb);
drop function if exists public.siigo_trial_balance_report(text, text, uuid, text);
drop function if exists public.siigo_trial_balance_filtered(text, text, uuid, text);
drop function if exists public.siigo_replace_trial_balance_period(text, jsonb);
drop function if exists public.siigo_trial_balance_series(text, text, uuid);

-- Facturación ───────────────────────────────────────────────────────────────────

create function public.siigo_sales_lines_filtered(
  p_connection   uuid,
  p_company_id   uuid default null,
  p_start        date default null,
  p_end          date default null,
  p_period       text default null,
  p_doc_type     text default null,
  p_product_code text default null,
  p_nit          text default null,
  p_search       text default null
)
returns setof public.siigo_sales_lines
language sql
stable
as $$
  select l.*
  from public.siigo_sales_lines l
  where l.connection_id = p_connection
    and (p_company_id   is null or l.company_id = p_company_id)
    and (p_start        is null or l.doc_date >= p_start)
    and (p_end          is null or l.doc_date <= p_end)
    and (p_period       is null or l.period = p_period)
    and (p_doc_type     is null or l.doc_type = p_doc_type)
    and (p_product_code is null or l.product_code = p_product_code)
    and (
      p_nit is null
      or position(p_nit in l.normalized_nit) > 0
      or (length(p_nit) = length(l.normalized_nit) + 1 and left(p_nit, -1) = l.normalized_nit)
    )
    and (
      p_search is null
      or position(lower(p_search) in lower(concat_ws(' ',
           l.comprobante, l.customer_name, l.customer_nit, l.product_code, l.product_description))) > 0
    )
$$;

create function public.siigo_sales_report(
  p_connection        uuid,
  p_company_id        uuid    default null,
  p_start             date    default null,
  p_end               date    default null,
  p_period            text    default null,
  p_doc_type          text    default null,
  p_product_code      text    default null,
  p_nit               text    default null,
  p_search            text    default null,
  p_include_customers boolean default false
)
returns jsonb
language sql
stable
as $$
  with f as (
    select * from public.siigo_sales_lines_filtered(
      p_connection, p_company_id, p_start, p_end, p_period, p_doc_type, p_product_code, p_nit, p_search)
  ),
  scope as (
    select * from public.siigo_sales_lines
    where connection_id = p_connection and (p_company_id is null or company_id = p_company_id)
  )
  select jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'totalFacturas',     count(distinct comprobante) filter (where doc_type = 'FACTURA'),
        'totalNotasCredito', count(distinct comprobante) filter (where doc_type = 'NOTA_CREDITO'),
        'totalLineas',       count(*),
        'totalBruto',        round(coalesce(sum(gross_value), 0), 2),
        'totalDescuento',    round(coalesce(sum(discount), 0), 2),
        'totalSubtotal',     round(coalesce(sum(subtotal), 0), 2),
        'totalImpuestos',    round(coalesce(sum(tax_charge), 0), 2),
        'totalRetenciones',  round(coalesce(sum(tax_retention), 0), 2),
        'totalNeto',         round(coalesce(sum(total), 0), 2)
      )
      from f
    ),
    'monthly', coalesce((
      select jsonb_agg(m order by m.period)
      from (
        select
          period,
          count(distinct comprobante) filter (where doc_type = 'FACTURA')      as facturas,
          count(distinct comprobante) filter (where doc_type = 'NOTA_CREDITO') as "notasCredito",
          count(*)                                                             as lineas,
          round(sum(gross_value), 2)   as bruto,
          round(sum(subtotal), 2)      as subtotal,
          round(sum(tax_charge), 2)    as impuestos,
          round(sum(tax_retention), 2) as retenciones,
          round(sum(total), 2)         as total,
          round(coalesce(sum(total) filter (where doc_type = 'FACTURA'), 0), 2)      as "totalFacturado",
          round(coalesce(sum(total) filter (where doc_type = 'NOTA_CREDITO'), 0), 2) as "totalNotasCredito"
        from f
        group by period
      ) m
    ), '[]'::jsonb),
    'byProduct', coalesce((
      select jsonb_agg(p order by p.total desc)
      from (
        select
          coalesce(nullif(max(product_code), ''), '—')                   as code,
          coalesce(nullif(min(product_description), ''), 'SIN PRODUCTO') as description,
          count(*)                   as lineas,
          round(sum(gross_value), 2) as bruto,
          round(sum(subtotal), 2)    as subtotal,
          round(sum(total), 2)       as total
        from f
        group by coalesce(nullif(product_code, ''), nullif(product_description, ''), 'SIN_CODIGO')
      ) p
    ), '[]'::jsonb),
    'byCustomer', case when p_include_customers then coalesce((
      select jsonb_agg(c order by c.total desc)
      from (
        select
          max(customer_nit)                                          as nit,
          coalesce(nullif(max(customer_name), ''), max(customer_nit)) as name,
          (array_agg(company_id) filter (where company_id is not null))[1] as "companyId",
          count(distinct comprobante) filter (where doc_type = 'FACTURA')      as facturas,
          count(distinct comprobante) filter (where doc_type = 'NOTA_CREDITO') as "notasCredito",
          round(sum(subtotal), 2) as subtotal,
          round(sum(total), 2)    as total
        from f
        group by coalesce(nullif(customer_nit, ''), nullif(customer_name, ''), 'SIN_NIT')
      ) c
    ), '[]'::jsonb) else '[]'::jsonb end,
    'catalogs', jsonb_build_object(
      'products', coalesce((
        select jsonb_agg(p order by p.code)
        from (
          select
            coalesce(nullif(product_code, ''), product_description)          as code,
            coalesce(nullif(min(product_description), ''), max(product_code)) as description
          from scope
          where product_code <> '' or product_description <> ''
          group by coalesce(nullif(product_code, ''), product_description)
        ) p
      ), '[]'::jsonb),
      'customers', case when p_include_customers then coalesce((
        select jsonb_agg(c order by c.name)
        from (
          select
            customer_nit                                         as nit,
            coalesce(nullif(max(customer_name), ''), customer_nit) as name,
            (array_agg(company_id) filter (where company_id is not null))[1] as "companyId"
          from scope
          where customer_nit <> ''
          group by customer_nit
        ) c
      ), '[]'::jsonb) else '[]'::jsonb end
    )
  )
$$;

create function public.siigo_replace_doc_lines(
  p_connection   uuid,
  p_doc_ids      text[],
  p_comprobantes text[],
  p_lines        jsonb
)
returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  delete from public.siigo_sales_lines
  where connection_id = p_connection
    and (siigo_doc_id = any(p_doc_ids)
         or (siigo_doc_id = comprobante and comprobante = any(p_comprobantes)));

  insert into public.siigo_sales_lines (
    connection_id, siigo_doc_id, line_index, doc_type, comprobante, doc_date, period,
    customer_nit, normalized_nit, company_id, sucursal, customer_name, seller_id,
    product_code, product_description, gross_value, discount, subtotal,
    tax_charge, tax_retention, total_charges, total_discounts, total, synced_at
  )
  select
    p_connection, r.siigo_doc_id, r.line_index, r.doc_type, r.comprobante, r.doc_date, r.period,
    r.customer_nit, r.normalized_nit, r.company_id, r.sucursal, r.customer_name, r.seller_id,
    r.product_code, r.product_description, r.gross_value, r.discount, r.subtotal,
    r.tax_charge, r.tax_retention, r.total_charges, r.total_discounts, r.total, now()
  from jsonb_populate_recordset(null::public.siigo_sales_lines, coalesce(p_lines, '[]'::jsonb)) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create function public.siigo_unlinked_nits(p_connection uuid)
returns setof text
language sql
stable
as $$
  select distinct normalized_nit
  from public.siigo_sales_lines
  where connection_id = p_connection and company_id is null and normalized_nit <> ''
$$;

-- Recaudo ──────────────────────────────────────────────────────────────────────

create function public.siigo_replace_collection_lines(
  p_connection uuid,
  p_start      date,
  p_end        date,
  p_lines      jsonb
)
returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  delete from public.siigo_collection_lines
  where connection_id = p_connection and collection_date between p_start and p_end;

  insert into public.siigo_collection_lines (
    connection_id, voucher_id, line_index, collection_date, period, receipt, customer_nit, normalized_nit,
    company_id, customer_name, invoice, product_code, product_description, installment,
    due_date, applied_value, movement_class, account, observations, synced_at
  )
  select
    p_connection, r.voucher_id, r.line_index, r.collection_date, r.period, r.receipt, r.customer_nit, r.normalized_nit,
    r.company_id, r.customer_name, r.invoice, r.product_code, r.product_description, r.installment,
    r.due_date, r.applied_value, r.movement_class, r.account, r.observations, now()
  from jsonb_populate_recordset(null::public.siigo_collection_lines, coalesce(p_lines, '[]'::jsonb)) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create function public.siigo_collection_lines_filtered(
  p_connection uuid,
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
  where l.connection_id = p_connection
    and (p_company_id is null or l.company_id = p_company_id)
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

create function public.siigo_collection_report(
  p_connection        uuid,
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
    select * from public.siigo_collection_lines_filtered(p_connection, p_company_id, p_start, p_end, p_nit, p_search)
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
        select period, round(sum(applied_value), 2) as recaudado, count(distinct receipt) as recibos, count(*) as movimientos
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

-- Balance de prueba ────────────────────────────────────────────────────────────

create function public.siigo_replace_trial_balance_period(
  p_connection uuid,
  p_period     text,
  p_lines      jsonb
)
returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  delete from public.siigo_trial_balance_lines where connection_id = p_connection and period = p_period;

  insert into public.siigo_trial_balance_lines (
    connection_id, period, year, month, cut_date, cut_type, level, class_label, group_label, account_label,
    subaccount_label, auxiliary_label, subauxiliary_label, transactional, account_code, account_name,
    identification, normalized_nit, company_id, branch, third_party_name,
    initial_balance, debit, credit, final_balance, synced_at
  )
  select
    p_connection, r.period, r.year, r.month, r.cut_date, coalesce(r.cut_type, 'Cierre mensual'), coalesce(r.level, ''),
    coalesce(r.class_label, ''), coalesce(r.group_label, ''), coalesce(r.account_label, ''),
    coalesce(r.subaccount_label, ''), coalesce(r.auxiliary_label, ''), coalesce(r.subauxiliary_label, ''),
    coalesce(r.transactional, ''), r.account_code, coalesce(r.account_name, ''),
    coalesce(r.identification, ''), coalesce(r.normalized_nit, ''), r.company_id, coalesce(r.branch, ''),
    coalesce(r.third_party_name, ''),
    coalesce(r.initial_balance, 0), coalesce(r.debit, 0), coalesce(r.credit, 0), coalesce(r.final_balance, 0), now()
  from jsonb_populate_recordset(null::public.siigo_trial_balance_lines, coalesce(p_lines, '[]'::jsonb)) r
  where r.period = p_period;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create function public.siigo_trial_balance_filtered(
  p_connection uuid,
  p_period     text,
  p_account    text default null,
  p_company_id uuid default null,
  p_search     text default null
)
returns setof public.siigo_trial_balance_lines
language sql
stable
as $$
  select l.*
  from public.siigo_trial_balance_lines l
  where l.connection_id = p_connection
    and l.period = p_period
    and (p_account    is null or l.account_code like p_account || '%')
    and (p_company_id is null or l.company_id = p_company_id)
    and (
      p_search is null
      or position(lower(p_search) in lower(concat_ws(' ',
           l.account_code, l.account_name, l.identification, l.third_party_name))) > 0
    )
$$;

create function public.siigo_trial_balance_report(
  p_connection uuid,
  p_period     text,
  p_account    text default null,
  p_company_id uuid default null,
  p_search     text default null
)
returns jsonb
language sql
stable
as $$
  with f as (
    select * from public.siigo_trial_balance_filtered(p_connection, p_period, p_account, p_company_id, p_search)
  ),
  con_tercero as (
    select distinct account_code from f where identification <> ''
  ),
  base as (
    select * from f
    where identification <> '' or account_code not in (select account_code from con_tercero)
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'initialBalance', round(coalesce(sum(initial_balance), 0), 2),
        'debit',          round(coalesce(sum(debit), 0), 2),
        'credit',         round(coalesce(sum(credit), 0), 2),
        'finalBalance',   round(coalesce(sum(final_balance), 0), 2),
        'accounts',       count(distinct account_code),
        'thirdParties',   count(distinct nullif(identification, ''))
      )
      from base
    ),
    'byClass', coalesce((
      select jsonb_agg(c order by c.code)
      from (
        select
          left(account_code, 1)                                         as code,
          coalesce(nullif(max(class_label), ''), left(account_code, 1)) as label,
          round(sum(initial_balance), 2) as "initialBalance",
          round(sum(debit), 2)           as debit,
          round(sum(credit), 2)          as credit,
          round(sum(final_balance), 2)   as "finalBalance"
        from base
        group by left(account_code, 1)
      ) c
    ), '[]'::jsonb)
  )
$$;

create function public.siigo_trial_balance_series(
  p_connection uuid,
  p_from       text default null,
  p_to         text default null,
  p_company_id uuid default null
)
returns jsonb
language sql
stable
as $$
  with f as (
    select * from public.siigo_trial_balance_lines
    where connection_id = p_connection
      and (p_from is null or period >= p_from)
      and (p_to   is null or period <= p_to)
      and (p_company_id is null or company_id = p_company_id)
  ),
  con_tercero as (
    select distinct period, account_code from f where identification <> ''
  ),
  base as (
    select f.* from f
    where f.identification <> ''
       or not exists (select 1 from con_tercero c where c.period = f.period and c.account_code = f.account_code)
  ),
  latest as (
    select max(period) as period from base
  )
  select jsonb_build_object(
    'latestPeriod', (select period from latest),
    'monthly', coalesce((
      select jsonb_agg(m order by m.period)
      from (
        select
          period,
          round(coalesce(sum(credit - debit) filter (where account_code like '4%'), 0), 2)    as ingresos,
          round(coalesce(sum(debit - credit) filter (where account_code like '5%'), 0), 2)    as gastos,
          round(coalesce(sum(debit - credit) filter (where account_code ~ '^[67]'), 0), 2)    as costos,
          round(coalesce(sum(final_balance)  filter (where account_code like '1%'), 0), 2)    as activo,
          round(coalesce(-sum(final_balance) filter (where account_code like '2%'), 0), 2)    as pasivo,
          round(coalesce(-sum(final_balance) filter (where account_code like '3%'), 0), 2)    as patrimonio,
          round(coalesce(sum(final_balance)  filter (where account_code like '13%'), 0), 2)   as cartera,
          round(coalesce(-sum(final_balance) filter (where account_code like '2805%'), 0), 2) as anticipos,
          round(coalesce(sum(debit), 0), 2)                                                   as debito,
          round(coalesce(sum(credit), 0), 2)                                                  as credito
        from base
        group by period
      ) m
    ), '[]'::jsonb),
    'byAccount', coalesce((
      select jsonb_agg(a order by abs(a."finalBalance") desc)
      from (
        select
          account_code                                          as code,
          coalesce(nullif(max(account_name), ''), account_code) as name,
          round(sum(debit), 2)                                  as debit,
          round(sum(credit), 2)                                 as credit,
          round(sum(final_balance), 2)                          as "finalBalance"
        from base
        where period = (select period from latest)
        group by account_code
        order by abs(sum(final_balance)) desc
        limit 15
      ) a
    ), '[]'::jsonb),
    'topCartera', case when p_company_id is null then coalesce((
      select jsonb_agg(t order by t.saldo desc)
      from (
        select
          identification                                              as nit,
          coalesce(nullif(max(third_party_name), ''), identification) as name,
          (array_agg(company_id) filter (where company_id is not null))[1] as "companyId",
          round(sum(final_balance), 2)                                as saldo
        from base
        where period = (select period from latest)
          and account_code like '13%'
          and identification <> ''
        group by identification
        having sum(final_balance) > 0
        order by sum(final_balance) desc
        limit 10
      ) t
    ), '[]'::jsonb) else '[]'::jsonb end
  )
$$;

-- Solo el backend (service_role) ejecuta estas funciones
do $$
declare
  f text;
begin
  foreach f in array array[
    'siigo_sales_lines_filtered(uuid, uuid, date, date, text, text, text, text, text)',
    'siigo_sales_report(uuid, uuid, date, date, text, text, text, text, text, boolean)',
    'siigo_replace_doc_lines(uuid, text[], text[], jsonb)',
    'siigo_unlinked_nits(uuid)',
    'siigo_replace_collection_lines(uuid, date, date, jsonb)',
    'siigo_collection_lines_filtered(uuid, uuid, date, date, text, text)',
    'siigo_collection_report(uuid, uuid, date, date, text, text, boolean)',
    'siigo_replace_trial_balance_period(uuid, text, jsonb)',
    'siigo_trial_balance_filtered(uuid, text, text, uuid, text)',
    'siigo_trial_balance_report(uuid, text, text, uuid, text)',
    'siigo_trial_balance_series(uuid, text, text, uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
