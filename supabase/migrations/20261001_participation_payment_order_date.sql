-- Faltas históricas de columnas en invoice_participations: el código las lee y
-- escribe, pero ninguna migración las había creado para ESTA tabla (cash_receipt_date
-- solo se agregó a la tabla vieja participation_invoicing). En una base construida
-- desde las migraciones no existen → los INSERT/UPDATE fallan con
-- "Could not find the '<col>' column ... in the schema cache" y, en el caso del
-- SELECT, se reportaba engañosamente como "Factura de participación no encontrada".

alter table invoice_participations
  add column if not exists payment_order_date date;

alter table invoice_participations
  add column if not exists cash_receipt_date date;

comment on column invoice_participations.payment_order_date is
  'Fecha de la Orden de Pago (OP) generada al conciliar la factura del tercero';
comment on column invoice_participations.cash_receipt_date is
  'Fecha del recibo de caja (RC) con que se recaudó la factura';
