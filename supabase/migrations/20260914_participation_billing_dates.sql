-- Fechas de facturación y prorrateo para la generación de OC.
--  · billing_day  : el servicio arranca/factura el día 1 o el 15 del mes.
--  · billing_mode : el servicio se factura 'vencido' (OC del mes anterior) o
--                   'anticipado' (OC del mes actual).
--  · proration    : factor del primer mes (1 = mes completo si inicia el 1;
--                   0.5 = medio mes si inicia el 15). Se guarda en cada OC.
--  · fecha_vinculacion : fecha de vinculación del cliente, editable y distinta
--                   de created_at.

alter table service_participations
  add column if not exists billing_day smallint not null default 1
    check (billing_day in (1, 15));

alter table service_participations
  add column if not exists billing_mode text not null default 'vencido'
    check (billing_mode in ('vencido', 'anticipado'));

comment on column service_participations.billing_day  is 'Día de inicio/facturación del servicio: 1 o 15';
comment on column service_participations.billing_mode is 'vencido = OC del mes anterior; anticipado = OC del mes actual';

alter table invoice_participations
  add column if not exists proration numeric(5,4) not null default 1;

comment on column invoice_participations.proration is 'Factor del mes (1 = completo; 0.5 = medio mes cuando inicia el 15)';

alter table companies
  add column if not exists fecha_vinculacion date;

comment on column companies.fecha_vinculacion is 'Fecha de vinculación del cliente (editable; distinta de created_at)';
