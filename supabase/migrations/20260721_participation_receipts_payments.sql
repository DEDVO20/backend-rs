-- Ciclo completo de cada participación mensual:
--   facturación → recaudo (recibo de caja) → pago al tercero (comprobante de egreso)
-- CxC Clientes y CxP Terceros NO se almacenan: son derivados y se calculan al
-- vuelo para que nunca queden desactualizados frente a facturas/recibos.

-- Recaudo del cliente (CxC Clientes)
alter table participation_invoicing add column if not exists cash_receipt       text;
alter table participation_invoicing add column if not exists cash_receipt_date  date;
alter table participation_invoicing add column if not exists cash_receipt_value numeric(14,2);
alter table participation_invoicing add column if not exists cash_account       text;

-- Pago al tercero (CxP Terceros)
alter table participation_invoicing add column if not exists egress_voucher       text;
alter table participation_invoicing add column if not exists egress_voucher_date  date;
alter table participation_invoicing add column if not exists egress_voucher_value numeric(14,2);

comment on column participation_invoicing.cash_receipt        is 'Número del recibo de caja (recaudo del cliente)';
comment on column participation_invoicing.cash_receipt_value  is 'V. Recibo — valor recaudado';
comment on column participation_invoicing.cash_account        is 'Caja / cuenta donde ingresó el dinero';
comment on column participation_invoicing.egress_voucher      is 'Número del comprobante de egreso (pago al tercero)';
comment on column participation_invoicing.egress_voucher_value is 'V. CE — valor pagado al tercero';

-- Búsqueda de facturas ya registradas (alerta de duplicado, no bloqueante)
create index if not exists participation_invoicing_finto_idx on participation_invoicing (finto_invoice);
create index if not exists participation_invoicing_third_idx on participation_invoicing (third_party_invoice);

-- Nuevo estado 'closed' (cerrada: recaudada y pagada) además de pending/validated/review
