-- Historial del porcentaje de participación de cada servicio con tercero.
-- El % puede cambiar de un mes a otro; cada factura (y cada OC mensual) usa el
-- % vigente en su mes, no el último configurado. Así, reimportar el reporte de
-- movimiento no recalcula los meses anteriores con el % nuevo.
--   valid_from = primer día del mes desde el que rige el porcentaje

create table if not exists participation_rates (
  id                uuid primary key default gen_random_uuid(),
  participation_id  uuid not null references service_participations(id) on delete cascade,
  percentage        numeric(5,2) not null check (percentage >= 0 and percentage <= 100),
  valid_from        date not null,
  created_at        timestamptz not null default now(),
  unique (participation_id, valid_from)
);

create index if not exists participation_rates_part_idx on participation_rates (participation_id, valid_from);

alter table participation_rates enable row level security;

-- El % actual de cada participación rige desde su fecha de inicio (mes completo).
insert into participation_rates (participation_id, percentage, valid_from)
select id, percentage, date_trunc('month', start_date)::date
from service_participations
where start_date is not null
on conflict (participation_id, valid_from) do nothing;
