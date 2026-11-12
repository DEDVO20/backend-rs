-- ─────────────────────────────────────────────────────────────────────────────
-- CRM (HubSpot): negocios (deals) para las gráficas de propuestas.
-- - hubspot_connections: una por empresa (token de private app cifrado) y una de
--   plataforma (Finto, sin empresa; si no tiene token guardado usa HUBSPOT_ACCESS_TOKEN).
-- - hubspot_deals: foto de los negocios de cada conexión (cada sync la reemplaza).
-- - Gráficas: valor por etapa y socio; conversión enviadas → ganadas por mes de cierre.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.hubspot_connections (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid unique references public.companies(id) on delete cascade,
  is_platform       boolean not null default false,
  label             text not null default '',
  token_enc         text,
  active            boolean not null default true,
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_message text,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id) on delete set null,
  check (is_platform or company_id is not null)
);

-- Una sola conexión de plataforma
create unique index if not exists hubspot_connections_platform_key
  on public.hubspot_connections (is_platform) where is_platform;

insert into public.hubspot_connections (is_platform, label)
select true, 'Finto'
where not exists (select 1 from public.hubspot_connections where is_platform);

alter table public.hubspot_connections enable row level security;

create table if not exists public.hubspot_deals (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references public.hubspot_connections(id) on delete cascade,
  deal_id         text not null,
  name            text not null default '',
  amount          numeric(18,2) not null default 0,
  pipeline_id     text not null default '',
  pipeline_label  text not null default '',
  stage_id        text not null default '',
  stage_label     text not null default '',
  stage_order     int  not null default 0,
  -- open: sin propuesta · sent: propuesta enviada · won: ganada/facturada · lost: perdida
  stage_kind      text not null default 'open' check (stage_kind in ('open', 'sent', 'won', 'lost')),
  owner_id        text not null default '',
  owner_name      text not null default '',
  close_date      date,
  create_date     date,
  synced_at       timestamptz not null default now(),
  unique (connection_id, deal_id)
);

create index if not exists hubspot_deals_conn_close_idx on public.hubspot_deals (connection_id, close_date);

alter table public.hubspot_deals enable row level security;

create table if not exists public.hubspot_sync_logs (
  id                  uuid primary key default gen_random_uuid(),
  connection_id       uuid not null references public.hubspot_connections(id) on delete cascade,
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running' check (status in ('running', 'completed', 'failed')),
  deals_count         int not null default 0,
  http_requests_count int not null default 0,
  duration_sec        int not null default 0,
  details             jsonb not null default '{}'::jsonb,
  error_message       text,
  triggered_by        uuid references public.profiles(id) on delete set null
);

create index if not exists hubspot_sync_logs_conn_idx on public.hubspot_sync_logs (connection_id, started_at desc);

alter table public.hubspot_sync_logs enable row level security;

-- Reemplaza atómicamente los negocios de una conexión
create or replace function public.hubspot_replace_deals(p_connection uuid, p_deals jsonb)
returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  delete from public.hubspot_deals where connection_id = p_connection;

  insert into public.hubspot_deals (
    connection_id, deal_id, name, amount, pipeline_id, pipeline_label, stage_id, stage_label,
    stage_order, stage_kind, owner_id, owner_name, close_date, create_date, synced_at
  )
  select
    p_connection, r.deal_id, coalesce(r.name, ''), coalesce(r.amount, 0),
    coalesce(r.pipeline_id, ''), coalesce(r.pipeline_label, ''), coalesce(r.stage_id, ''), coalesce(r.stage_label, ''),
    coalesce(r.stage_order, 0), coalesce(r.stage_kind, 'open'), coalesce(r.owner_id, ''), coalesce(r.owner_name, ''),
    r.close_date, r.create_date, now()
  from jsonb_populate_recordset(null::public.hubspot_deals, coalesce(p_deals, '[]'::jsonb)) r;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

/**
 * Agregados para las gráficas de CRM. La fecha de cada negocio es su fecha de cierre
 * (o la de creación si aún no tiene); el periodo filtra por esa fecha.
 * - byStage: valor por etapa y socio.
 * - monthly: negocios con propuesta enviada (sent + won + lost) y ganados por mes.
 */
create or replace function public.hubspot_deals_report(
  p_connection uuid,
  p_from       date default null,
  p_to         date default null
)
returns jsonb
language sql
stable
as $$
  with f as (
    select *, coalesce(close_date, create_date) as fecha
    from public.hubspot_deals
    where connection_id = p_connection
      and (p_from is null or coalesce(close_date, create_date) >= p_from)
      and (p_to   is null or coalesce(close_date, create_date) <= p_to)
  )
  select jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'deals',    count(*),
        'amount',   round(coalesce(sum(amount), 0), 2),
        'enviadas', count(*) filter (where stage_kind in ('sent', 'won', 'lost')),
        'ganadas',  count(*) filter (where stage_kind = 'won'),
        'valorGanado', round(coalesce(sum(amount) filter (where stage_kind = 'won'), 0), 2)
      )
      from f
    ),
    'byStage', coalesce((
      select jsonb_agg(s order by s."order", s.owner)
      from (
        select
          stage_label                                         as stage,
          min(stage_order)                                    as "order",
          stage_kind                                          as kind,
          coalesce(nullif(owner_name, ''), 'Sin asignar')     as owner,
          round(sum(amount), 2)                               as amount,
          count(*)                                            as deals
        from f
        group by stage_label, stage_kind, coalesce(nullif(owner_name, ''), 'Sin asignar')
      ) s
    ), '[]'::jsonb),
    'monthly', coalesce((
      select jsonb_agg(m order by m.period)
      from (
        select
          to_char(fecha, 'YYYY-MM')                                      as period,
          count(*) filter (where stage_kind in ('sent', 'won', 'lost'))  as enviadas,
          count(*) filter (where stage_kind = 'won')                     as ganadas
        from f
        where fecha is not null
        group by to_char(fecha, 'YYYY-MM')
      ) m
    ), '[]'::jsonb)
  )
$$;

revoke execute on function public.hubspot_replace_deals(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.hubspot_replace_deals(uuid, jsonb) to service_role;
revoke execute on function public.hubspot_deals_report(uuid, date, date) from public, anon, authenticated;
grant  execute on function public.hubspot_deals_report(uuid, date, date) to service_role;
