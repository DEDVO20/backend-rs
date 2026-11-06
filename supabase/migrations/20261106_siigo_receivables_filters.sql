-- ─────────────────────────────────────────────────────────────────────────────
-- Cartera: filtros cruzados en las gráficas (edad, vendedor y cliente).
-- Cada desglose aplica todos los filtros menos el suyo, para que la gráfica
-- donde se hizo clic siga mostrando todas las barras (con la elegida resaltada).
-- La evolución diaria (siigo_receivable_history) solo se filtra por empresa.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.siigo_receivables_report(uuid, uuid, date, date);

create function public.siigo_receivables_report(
  p_connection uuid,
  p_company_id uuid default null,
  p_from       date default null,
  p_to         date default null,
  p_bucket     text default null,
  p_seller     text default null,
  p_nit        text default null
)
returns jsonb
language sql
stable
as $$
  with base as (
    select
      l.*,
      coalesce(nullif(l.seller_name, ''), nullif(l.seller_id, ''), 'Sin vendedor') as seller_key,
      (p_bucket is null or l.aging_bucket = p_bucket)                                          as m_bucket,
      (p_seller is null or coalesce(nullif(l.seller_name, ''), nullif(l.seller_id, ''), 'Sin vendedor') = p_seller) as m_seller,
      (p_nit    is null or l.identification = p_nit)                                           as m_nit
    from public.siigo_receivable_lines l
    where l.connection_id = p_connection
      and (p_company_id is null or l.company_id = p_company_id)
  ),
  filtered as (select * from base where m_bucket and m_seller and m_nit),
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
      from filtered
    ),
    'byBucket', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', b.bucket, 'total', coalesce(x.total, 0), 'facturas', coalesce(x.facturas, 0)) order by b.ord)
      from buckets b
      left join (
        select aging_bucket, round(sum(balance), 2) as total, count(*) as facturas
        from base where m_seller and m_nit
        group by aging_bucket
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
        where m_bucket and m_seller
        group by identification
        -- El cliente seleccionado siempre aparece, aunque no esté en el top 15
        order by (p_nit is not null and identification = p_nit) desc, sum(balance) desc
        limit 15
      ) c
    ), '[]'::jsonb),
    'bySeller', coalesce((
      select jsonb_agg(s order by s.total desc)
      from (
        select
          seller_key                                                          as seller,
          round(sum(balance), 2)                                              as total,
          round(coalesce(sum(balance) filter (where days_overdue > 0), 0), 2) as vencido,
          count(*)                                                            as facturas
        from base
        where m_bucket and m_nit
        group by seller_key
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
        from filtered
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

-- Solo el backend (service_role) ejecuta esta función
revoke execute on function public.siigo_receivables_report(uuid, uuid, date, date, text, text, text) from public, anon, authenticated;
grant  execute on function public.siigo_receivables_report(uuid, uuid, date, date, text, text, text) to service_role;
