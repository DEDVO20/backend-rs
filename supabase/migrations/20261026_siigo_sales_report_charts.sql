-- ─────────────────────────────────────────────────────────────────────────────
-- Gráficas de facturación Siigo
-- Amplía siigo_sales_report con el valor bruto y los valores de facturas / notas
-- crédito por mes y el bruto por servicio (vista de gráficas del portal).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.siigo_sales_report(
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
      p_company_id, p_start, p_end, p_period, p_doc_type, p_product_code, p_nit, p_search)
  ),
  scope as (
    select * from public.siigo_sales_lines
    where p_company_id is null or company_id = p_company_id
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

revoke execute on function public.siigo_sales_report(uuid, date, date, text, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.siigo_sales_report(uuid, date, date, text, text, text, text, text, boolean) to service_role;
