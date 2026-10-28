-- ─────────────────────────────────────────────────────────────────────────────
-- Gráficas del balance de prueba
-- Series mensuales (estado de resultados y estructura del balance), saldos por
-- cuenta y mayores saldos de cartera. Con p_company_id solo entran las filas donde
-- esa empresa es el tercero (vista del cliente).
-- Misma regla que siigo_trial_balance_report para no contar dos veces: si una
-- cuenta trae filas por tercero en el mes se suman esas; si no, la fila de la cuenta.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.siigo_trial_balance_series(
  p_from       text default null, -- 'YYYY-MM'
  p_to         text default null,
  p_company_id uuid default null
)
returns jsonb
language sql
stable
as $$
  with f as (
    select * from public.siigo_trial_balance_lines
    where (p_from is null or period >= p_from)
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
    -- Movimientos del mes (estado de resultados) y saldos finales (estructura del balance).
    -- Pasivo, patrimonio e ingresos son de naturaleza crédito: se presentan en positivo.
    'monthly', coalesce((
      select jsonb_agg(m order by m.period)
      from (
        select
          period,
          round(coalesce(sum(credit - debit) filter (where account_code like '4%'), 0), 2)       as ingresos,
          round(coalesce(sum(debit - credit) filter (where account_code like '5%'), 0), 2)       as gastos,
          round(coalesce(sum(debit - credit) filter (where account_code ~ '^[67]'), 0), 2)       as costos,
          round(coalesce(sum(final_balance)  filter (where account_code like '1%'), 0), 2)       as activo,
          round(coalesce(-sum(final_balance) filter (where account_code like '2%'), 0), 2)       as pasivo,
          round(coalesce(-sum(final_balance) filter (where account_code like '3%'), 0), 2)       as patrimonio,
          round(coalesce(sum(final_balance)  filter (where account_code like '13%'), 0), 2)      as cartera,
          round(coalesce(-sum(final_balance) filter (where account_code like '2805%'), 0), 2)    as anticipos,
          round(coalesce(sum(debit), 0), 2)                                                      as debito,
          round(coalesce(sum(credit), 0), 2)                                                     as credito
        from base
        group by period
      ) m
    ), '[]'::jsonb),
    -- Saldos por cuenta en el último mes del rango
    'byAccount', coalesce((
      select jsonb_agg(a order by abs(a."finalBalance") desc)
      from (
        select
          account_code                                    as code,
          coalesce(nullif(max(account_name), ''), account_code) as name,
          round(sum(debit), 2)                            as debit,
          round(sum(credit), 2)                           as credit,
          round(sum(final_balance), 2)                    as "finalBalance"
        from base
        where period = (select period from latest)
        group by account_code
        order by abs(sum(final_balance)) desc
        limit 15
      ) a
    ), '[]'::jsonb),
    -- Mayores saldos de cartera (cuentas 13) por tercero en el último mes (solo vista global)
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

revoke execute on function public.siigo_trial_balance_series(text, text, uuid) from public, anon, authenticated;
grant execute on function public.siigo_trial_balance_series(text, text, uuid) to service_role;
