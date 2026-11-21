-- ─────────────────────────────────────────────────────────────────────────────
-- Estados financieros desplegables a partir del balance de prueba por tercero.
-- Solo una función de consulta (no crea tablas): devuelve los hijos de una cuenta,
-- agrupados por columna, para desplegar la tabla nivel a nivel
-- (clase → grupo → cuenta → subcuenta → auxiliar → … → tercero).
--
-- - 'resultados' (clases 4–7): movimiento del mes (débito − crédito) sumado por AÑO.
--   Los ingresos quedan en negativo (naturaleza crédito), como en el informe contable.
-- - 'situacion'  (clases 1–3): saldo final al cierre de cada MES (pasivo y patrimonio en negativo).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.siigo_trial_balance_tree(
  p_connection uuid,
  p_statement  text,                  -- 'resultados' | 'situacion'
  p_parent     text default '',       -- código de la cuenta a desplegar ('' = clases)
  p_from       text default null,     -- 'YYYY-MM'
  p_to         text default null,     -- 'YYYY-MM'
  p_tercero    text default null,     -- NIT o nombre del tercero (contiene)
  p_company_id uuid default null
)
returns jsonb
language sql
stable
as $$
  with params as (
    select
      coalesce(p_parent, '') as parent,
      -- Longitud del siguiente nivel del PUC: 1, 2, 4, 6, 8, 10…
      case length(coalesce(p_parent, '')) when 0 then 1 when 1 then 2 else length(coalesce(p_parent, '')) + 2 end as nl
  ),
  f as (
    select l.*
    from public.siigo_trial_balance_lines l
    where l.connection_id = p_connection
      and left(l.account_code, 1) = any (case when p_statement = 'resultados' then array['4','5','6','7'] else array['1','2','3'] end)
      and l.account_code like (select parent from params) || '%'
      and (p_from is null or l.period >= p_from)
      and (p_to   is null or l.period <= p_to)
      and (p_company_id is null or l.company_id = p_company_id)
      and (p_tercero is null or p_tercero = ''
           or l.identification ilike '%' || p_tercero || '%'
           or l.third_party_name ilike '%' || p_tercero || '%')
  ),
  -- Sin doble conteo: por mes y cuenta, las filas por tercero si existen; si no, la de la cuenta
  con_tercero as (
    select distinct period, account_code from f where identification <> ''
  ),
  base as (
    select
      f.*,
      case when p_statement = 'resultados' then left(f.period, 4) else f.period end as col,
      case when p_statement = 'resultados' then f.debit - f.credit else f.final_balance end as val
    from f
    where f.identification <> ''
       or not exists (select 1 from con_tercero c where c.period = f.period and c.account_code = f.account_code)
  ),
  -- Cuentas hijas (un nivel más abajo)
  cuentas as (
    select
      left(b.account_code, p.nl) as code,
      coalesce(
        nullif(max(case when b.account_code = left(b.account_code, p.nl) then b.account_code || ' - ' || b.account_name end), ''),
        nullif(max(case p.nl
          when 1 then b.class_label when 2 then b.group_label when 4 then b.account_label
          when 6 then b.subaccount_label when 8 then b.auxiliary_label else b.subauxiliary_label end), ''),
        left(b.account_code, p.nl)
      ) as label,
      bool_or(length(b.account_code) > p.nl or b.identification <> '') as has_children,
      false as is_tercero,
      b.col,
      sum(b.val) as val
    from base b, params p
    where length(b.account_code) >= p.nl and length(b.account_code) > length(p.parent)
    group by left(b.account_code, p.nl), b.col
  ),
  -- Terceros de la cuenta desplegada (cuando la cuenta misma tiene movimiento por tercero)
  terceros as (
    select
      'T:' || b.identification as code,
      coalesce(nullif(max(b.third_party_name), ''), b.identification) || ' · ' || b.identification as label,
      false as has_children,
      true as is_tercero,
      b.col,
      sum(b.val) as val
    from base b, params p
    where p.parent <> '' and b.account_code = p.parent and b.identification <> ''
    group by b.identification, b.col
  ),
  filas as (
    select * from cuentas
    union all
    select * from terceros
  ),
  agrupadas as (
    select
      code,
      max(label)                                         as label,
      bool_or(has_children)                              as "hasChildren",
      bool_or(is_tercero)                                as "isTercero",
      jsonb_object_agg(col, round(val, 2))               as "values",
      round(sum(val), 2)                                 as total
    from filas
    group by code
  )
  select jsonb_build_object(
    'columns', coalesce((select jsonb_agg(c order by c) from (select distinct col as c from base) x), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(a) order by a."isTercero", a.code)
      from agrupadas a
    ), '[]'::jsonb),
    -- Total del nivel desplegado (en la raíz, el total del estado)
    'totals', coalesce((
      select jsonb_object_agg(col, round(s, 2))
      from (select col, sum(val) as s from base group by col) t
    ), '{}'::jsonb)
  )
$$;

revoke execute on function public.siigo_trial_balance_tree(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant  execute on function public.siigo_trial_balance_tree(uuid, text, text, text, text, text, uuid) to service_role;
