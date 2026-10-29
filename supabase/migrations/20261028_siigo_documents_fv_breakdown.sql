-- Desglose de la factura de venta (FV) del reporte de movimiento contable.
-- En una FV: amount = lo que paga el cliente (neto a cobrar) =
--   base_amount + vat_amount − retenciones (tax_income/ica/iva_withholding).
-- Una FV puede repartirse entre varias OC; su saldo por asignar es
-- amount − Σ finto_invoice_value de las OC que la tienen.

alter table siigo_documents
  add column if not exists base_amount numeric(14,2) not null default 0,
  add column if not exists vat_amount  numeric(14,2) not null default 0;

comment on column siigo_documents.base_amount is 'FV: base (ingresos 41 + porción de mandato)';
comment on column siigo_documents.vat_amount  is 'FV: IVA facturado (2408)';
