-- Una factura de venta (FV) puede repartirse entre varias OC (cada una con una
-- parte de su valor; ver ParticipationsService.assignSaleInvoice). El índice
-- único de la FV (20260731_monthly_auto_oc.sql) lo impedía:
--   duplicate key value violates unique constraint "invoice_participations_finto_uq"
-- Se reemplaza por un índice normal para seguir buscando rápido por FV.

drop index if exists invoice_participations_finto_uq;

create index if not exists invoice_participations_finto_idx
  on invoice_participations (finto_invoice)
  where finto_invoice is not null;
