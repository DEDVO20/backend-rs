-- ─────────────────────────────────────────────────────────────────────────────
-- Consultas Siigo en SQL
-- Los filtros, la paginación y los agregados se resuelven en Postgres en lugar
-- de cargar toda la tabla en el backend (PostgREST corta en max-rows = 1000).
-- El aislamiento multi-empresa se hace solo por company_id.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists siigo_sales_lines_company_date_idx
  on public.siigo_sales_lines (company_id, doc_date desc, comprobante desc, line_index);

create index if not exists siigo_sales_lines_unlinked_idx
  on public.siigo_sales_lines (normalized_nit)
  where company_id is null;

-- Líneas filtradas: única definición de filtros, usada por la consulta paginada,
-- el export y el reporte de agregados.
create or replace function public.siigo_sales_lines_filtered(
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
  where (p_company_id   is null or l.company_id = p_company_id)
    and (p_start        is null or l.doc_date >= p_start)
    and (p_end          is null or l.doc_date <= p_end)
    and (p_period       is null or l.period = p_period)
    and (p_doc_type     is null or l.doc_type = p_doc_type)
    and (p_product_code is null or l.product_code = p_product_code)
    and (
      p_nit is null
      or position(p_nit in l.normalized_nit) > 0
      -- el filtro trae dígito de verificación y la línea no
      or (length(p_nit) = length(l.normalized_nit) + 1 and left(p_nit, -1) = l.normalized_nit)
    )
    and (
      p_search is null
      or position(lower(p_search) in lower(concat_ws(' ',
           l.comprobante, l.customer_name, l.customer_nit, l.product_code, l.product_description))) > 0
    )
$$;

-- KPIs, desglose mensual, por producto, por cliente y catálogos para los selectores.
-- Los catálogos usan solo el alcance de empresa (sin los demás filtros).
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
          round(sum(subtotal), 2)      as subtotal,
          round(sum(tax_charge), 2)    as impuestos,
          round(sum(tax_retention), 2) as retenciones,
          round(sum(total), 2)         as total
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
          count(*)                as lineas,
          round(sum(subtotal), 2) as subtotal,
          round(sum(total), 2)    as total
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

-- Reemplaza atómicamente las líneas de los documentos re-sincronizados.
-- Borra las líneas previas por siigo_doc_id y también las filas sembradas desde el
-- Excel legacy (siigo_doc_id = comprobante) de esos mismos comprobantes, para no duplicar.
-- Sirve también para limpiar documentos anulados (p_lines vacío).
create or replace function public.siigo_replace_doc_lines(
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
  where siigo_doc_id = any(p_doc_ids)
     or (siigo_doc_id = comprobante and comprobante = any(p_comprobantes));

  insert into public.siigo_sales_lines (
    siigo_doc_id, line_index, doc_type, comprobante, doc_date, period,
    customer_nit, normalized_nit, company_id, sucursal, customer_name, seller_id,
    product_code, product_description, gross_value, discount, subtotal,
    tax_charge, tax_retention, total_charges, total_discounts, total, synced_at
  )
  select
    r.siigo_doc_id, r.line_index, r.doc_type, r.comprobante, r.doc_date, r.period,
    r.customer_nit, r.normalized_nit, r.company_id, r.sucursal, r.customer_name, r.seller_id,
    r.product_code, r.product_description, r.gross_value, r.discount, r.subtotal,
    r.tax_charge, r.tax_retention, r.total_charges, r.total_discounts, r.total, now()
  from jsonb_populate_recordset(null::public.siigo_sales_lines, coalesce(p_lines, '[]'::jsonb)) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- NIT de líneas que aún no están vinculadas a una empresa (para re-vincular tras crear empresas)
create or replace function public.siigo_unlinked_nits()
returns setof text
language sql
stable
as $$
  select distinct normalized_nit
  from public.siigo_sales_lines
  where company_id is null and normalized_nit <> ''
$$;

-- Solo el backend (service_role) ejecuta estas funciones
revoke execute on function public.siigo_sales_lines_filtered(uuid, date, date, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.siigo_sales_report(uuid, date, date, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.siigo_replace_doc_lines(text[], text[], jsonb) from public, anon, authenticated;
revoke execute on function public.siigo_unlinked_nits() from public, anon, authenticated;

grant execute on function public.siigo_sales_lines_filtered(uuid, date, date, text, text, text, text, text) to service_role;
grant execute on function public.siigo_sales_report(uuid, date, date, text, text, text, text, text, boolean) to service_role;
grant execute on function public.siigo_replace_doc_lines(text[], text[], jsonb) to service_role;
grant execute on function public.siigo_unlinked_nits() to service_role;
