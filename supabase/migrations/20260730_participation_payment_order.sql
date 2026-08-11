-- Fase 3: Orden de Pago (OP) al tercero. Se genera cuando la factura del
-- tercero concilia contra lo causado (participación). El Comprobante de
-- Egreso cierra el pago.

alter table invoice_participations add column if not exists payment_order text;   -- OP-YYYYMM-NNNNNN

comment on column invoice_participations.payment_order is 'Orden de Pago generada al conciliar la factura del tercero';

create index if not exists invoice_participations_payment_order_idx on invoice_participations (payment_order);
