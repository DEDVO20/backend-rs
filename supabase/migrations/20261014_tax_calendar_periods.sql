-- Calendario tributario por períodos.
--
-- Antes cada obligación tenía UNA sola fecha por empresa (company_tax_entries.due_date),
-- lo que no sirve para obligaciones que se presentan varias veces al año
-- (retención mensual, RetICA bimestral, IVA cuatrimestral…) y cuyo día de
-- vencimiento cambia en cada período.
--
-- - tax_calendar_master.periodicity: periodicidad por defecto de la obligación.
-- - tax_calendar_master.entity:      entidad (DIAN, PILA, Secretaría de Hacienda…).
-- - company_tax_entries.periodicity: override por empresa (ej. IVA bimestral vs
--   cuatrimestral según el contribuyente). NULL = usa la de la maestra.
-- - company_tax_deadlines: una fila por (obligación de la empresa, año, período)
--   con su propia fecha de vencimiento. Las filas `is_custom` son fechas
--   adicionales que agrega el contador (ej. 2a cuota de renta).
-- - El cron crea tareas por cada vencimiento (unique_key 'taxcal_d_{deadline_id}').

alter table tax_calendar_master add column if not exists periodicity text not null default 'anual';
alter table tax_calendar_master add column if not exists entity text;
-- Viene de 20260716_tax_calendar_notice_days.sql; se repite (idempotente) por si
-- esa migración no se aplicó, ya que los inserts de abajo la usan.
alter table tax_calendar_master add column if not exists notice_days int not null default 5;

alter table tax_calendar_master drop constraint if exists tax_calendar_master_periodicity_check;
alter table tax_calendar_master add constraint tax_calendar_master_periodicity_check
  check (periodicity in ('mensual', 'bimestral', 'trimestral', 'cuatrimestral', 'semestral', 'anual'));

alter table company_tax_entries add column if not exists periodicity text;
alter table company_tax_entries drop constraint if exists company_tax_entries_periodicity_check;
alter table company_tax_entries add constraint company_tax_entries_periodicity_check
  check (periodicity is null or periodicity in ('mensual', 'bimestral', 'trimestral', 'cuatrimestral', 'semestral', 'anual'));

comment on column company_tax_entries.due_date is
  'OBSOLETO: reemplazado por company_tax_deadlines (una fecha por período)';

create table if not exists company_tax_deadlines (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references company_tax_entries(id) on delete cascade,
  company_id    uuid not null references companies(id) on delete cascade,
  year          int  not null,
  period_index  int  not null,
  period_label  text not null,
  is_custom     boolean not null default false,
  due_date      date,
  notes         text,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (entry_id, year, period_index)
);

create index if not exists company_tax_deadlines_company_year_idx on company_tax_deadlines (company_id, year);
create index if not exists company_tax_deadlines_due_date_idx     on company_tax_deadlines (due_date);

alter table company_tax_deadlines enable row level security;

-- ── Periodicidad de la semilla existente ─────────────────────────────────────
update tax_calendar_master set periodicity = 'mensual',       entity = 'DIAN'
  where title = 'Retención en la fuente';
update tax_calendar_master set periodicity = 'cuatrimestral', entity = 'DIAN'
  where title = 'Declaración de IVA';
update tax_calendar_master set periodicity = 'anual',         entity = 'DIAN'
  where title in ('Declaración de renta', 'Información exógena nacional', 'Impuesto al patrimonio');
update tax_calendar_master set periodicity = 'anual',         entity = 'Secretaría de Hacienda'
  where title in ('Industria y comercio (ICA)', 'Información exógena distrital/municipal');
update tax_calendar_master set periodicity = 'anual',         entity = 'Cámara de comercio'
  where title = 'Renovación matrícula mercantil';

-- Obligaciones periódicas que faltaban en la maestra
insert into tax_calendar_master (title, description, is_mandatory, sort_order, periodicity, entity, notice_days)
select 'Aportes seguridad social y parafiscales', 'Planilla PILA', true, 4, 'mensual', 'Seguridad Social (PILA)', 5
where not exists (select 1 from tax_calendar_master where title = 'Aportes seguridad social y parafiscales');

insert into tax_calendar_master (title, description, is_mandatory, sort_order, periodicity, entity, notice_days)
select 'RetICA', 'Declaración y pago bimestral de retención de ICA', false, 5, 'bimestral', 'Secretaría de Hacienda', 5
where not exists (select 1 from tax_calendar_master where title = 'RetICA');

-- ── Conservar las fechas que ya se habían diligenciado ───────────────────────
-- Se migran como fechas adicionales (custom) para no chocar con los períodos generados.
insert into company_tax_deadlines (entry_id, company_id, year, period_index, period_label, is_custom, due_date, notes)
select e.id, e.company_id, extract(year from e.due_date)::int, 101,
       'Fecha registrada (calendario anterior)', true, e.due_date, e.notes
from company_tax_entries e
where e.due_date is not null
on conflict (entry_id, year, period_index) do nothing;
