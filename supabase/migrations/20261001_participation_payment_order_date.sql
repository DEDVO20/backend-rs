-- Falta histórica: el código (updateInvoiceParticipation, generación de OP,
-- recomputeOcFromAllocations) lee y escribe `payment_order_date`, pero ninguna
-- migración la había creado. En una base construida desde las migraciones la
-- columna no existe → el SELECT falla y se reporta, engañosamente, como
-- "Factura de participación no encontrada". Esta migración la agrega.

alter table invoice_participations
  add column if not exists payment_order_date date;

comment on column invoice_participations.payment_order_date is
  'Fecha de la Orden de Pago (OP) generada al conciliar la factura del tercero';
