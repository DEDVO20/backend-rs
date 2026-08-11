-- Fase 1 del flujo completo de participaciones:
-- tipo de participación (porcentaje o valor fijo) y vigencia (fecha fin).

alter table service_participations
  add column if not exists participation_type text not null default 'percentage'
    check (participation_type in ('percentage', 'fixed'));

alter table service_participations
  add column if not exists fixed_value numeric(14,2);

alter table service_participations
  add column if not exists end_date date;

comment on column service_participations.participation_type is 'percentage = % del valor; fixed = valor fijo que cobra el tercero';
comment on column service_participations.fixed_value is 'monto fijo cuando participation_type = fixed';
comment on column service_participations.end_date is 'vigencia: fecha hasta la cual aplica la participación (null = sin fin)';
