-- Contrato de mandato en participaciones.
-- Agrega el "Tipo" de contrato de la config (hoja `servicio`, columna Tipo):
--   servicio = participación estándar (la firma cobra su comisión al tercero).
--   mandato  = contrato de mandato: la porción del tercero (mandante) se reconoce
--              como cuenta por pagar (cuenta 28150601 en SIIGO) al facturar. El
--              monto NO se calcula: se lee del reporte "Movimiento por cuenta
--              contable" de la cuenta 28150601.

alter table service_participations
  add column if not exists contract_type text not null default 'servicio'
    check (contract_type in ('servicio', 'mandato'));

comment on column service_participations.contract_type is
  'servicio = participación estándar (comisión); mandato = contrato de mandato (la porción del tercero se lee de la cuenta 28150601 en SIIGO, no se calcula)';

-- Snapshot del tipo de contrato al crear la participación por factura
alter table invoice_participations
  add column if not exists contract_type text not null default 'servicio'
    check (contract_type in ('servicio', 'mandato'));

create index if not exists invoice_participations_contract_idx
  on invoice_participations (contract_type);
