-- ─────────────────────────────────────────────────────────────────────────────
-- Balance de prueba por tercero (Siigo /v1/test-balance-report-by-thirdparty)
-- Una fila por cuenta/tercero y mes. Cada importación reemplaza el mes completo;
-- si la consulta de un mes falla, se conservan sus datos anteriores.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.siigo_trial_balance_lines (
  id                  uuid primary key default gen_random_uuid(),
  period              text not null, -- 'YYYY-MM'
  year                int  not null,
  month               int  not null check (month between 1 and 12),
  cut_date            date not null,
  cut_type            text not null default 'Cierre mensual' check (cut_type in ('Cierre mensual', 'Actual diario')),
  level               text not null default '',
  class_label         text not null default '',
  group_label         text not null default '',
  account_label       text not null default '',
  subaccount_label    text not null default '',
  auxiliary_label     text not null default '',
  subauxiliary_label  text not null default '',
  transactional       text not null default '',
  account_code        text not null,
  account_name        text not null default '',
  identification      text not null default '',
  normalized_nit      text not null default '',
  company_id          uuid references public.companies(id) on delete set null,
  branch              text not null default '',
  third_party_name    text not null default '',
  initial_balance     numeric(16,2) not null default 0,
  debit               numeric(16,2) not null default 0,
  credit              numeric(16,2) not null default 0,
  final_balance       numeric(16,2) not null default 0,
  synced_at           timestamptz not null default now()
);

create index if not exists siigo_trial_balance_period_account_idx
  on public.siigo_trial_balance_lines (period, account_code);
create index if not exists siigo_trial_balance_company_idx
  on public.siigo_trial_balance_lines (company_id, period);

alter table public.siigo_trial_balance_lines enable row level security;

-- Control por periodo (equivale a la hoja "Control 2026")
create table if not exists public.siigo_trial_balance_periods (
  period           text primary key,
  status           text not null check (status in ('OK', 'ERROR')),
  rows_count       int  not null default 0,
  cut_date         date,
  last_attempt_at  timestamptz not null default now(),
  last_success_at  timestamptz,
  detail           text not null default '',
  diagnostics      jsonb not null default '{}'::jsonb
);

alter table public.siigo_trial_balance_periods enable row level security;

-- Historial de ejecuciones (mes actual diario o año completo)
create table if not exists public.siigo_trial_balance_sync_logs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running' check (status in ('running', 'completed', 'failed')),
  mode                text not null default 'current' check (mode in ('current', 'year')),
  year                int  not null,
  months_ok           int  not null default 0,
  months_failed       int  not null default 0,
  rows_count          int  not null default 0,
  http_requests_count int  not null default 0,
  duration_sec        int  not null default 0,
  details             jsonb not null default '{}'::jsonb,
  error_message       text,
  triggered_by        uuid references public.profiles(id) on delete set null
);

create index if not exists siigo_trial_balance_sync_logs_started_idx
  on public.siigo_trial_balance_sync_logs (started_at desc);

alter table public.siigo_trial_balance_sync_logs enable row level security;

-- Reemplaza atómicamente todas las filas de un mes
create or replace function public.siigo_replace_trial_balance_period(
  p_period text,
  p_lines  jsonb
)
returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  delete from public.siigo_trial_balance_lines where period = p_period;

  insert into public.siigo_trial_balance_lines (
    period, year, month, cut_date, cut_type, level, class_label, group_label, account_label,
    subaccount_label, auxiliary_label, subauxiliary_label, transactional, account_code, account_name,
    identification, normalized_nit, company_id, branch, third_party_name,
    initial_balance, debit, credit, final_balance, synced_at
  )
  select
    r.period, r.year, r.month, r.cut_date, coalesce(r.cut_type, 'Cierre mensual'), coalesce(r.level, ''),
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

create or replace function public.siigo_trial_balance_filtered(
  p_period     text,
  p_account    text default null, -- prefijo de código (ej. 13, 1305)
  p_company_id uuid default null,
  p_search     text default null
)
returns setof public.siigo_trial_balance_lines
language sql
stable
as $$
  select l.*
  from public.siigo_trial_balance_lines l
  where l.period = p_period
    and (p_account    is null or l.account_code like p_account || '%')
    and (p_company_id is null or l.company_id = p_company_id)
    and (
      p_search is null
      or position(lower(p_search) in lower(concat_ws(' ',
           l.account_code, l.account_name, l.identification, l.third_party_name))) > 0
    )
$$;

-- Totales por clase y cuadre del periodo.
-- Para no contar dos veces: si una cuenta trae filas por tercero se suman esas;
-- si no, se suma la fila transaccional de la cuenta.
create or replace function public.siigo_trial_balance_report(
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
    select * from public.siigo_trial_balance_filtered(p_period, p_account, p_company_id, p_search)
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
          left(account_code, 1)                                     as code,
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

revoke execute on function public.siigo_replace_trial_balance_period(text, jsonb) from public, anon, authenticated;
revoke execute on function public.siigo_trial_balance_filtered(text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.siigo_trial_balance_report(text, text, uuid, text) from public, anon, authenticated;

grant execute on function public.siigo_replace_trial_balance_period(text, jsonb) to service_role;
grant execute on function public.siigo_trial_balance_filtered(text, text, uuid, text) to service_role;
grant execute on function public.siigo_trial_balance_report(text, text, uuid, text) to service_role;
