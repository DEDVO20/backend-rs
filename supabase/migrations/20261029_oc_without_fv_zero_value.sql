-- Las OC mensuales automáticas se creaban con finto_invoice_value = valor del
-- servicio aunque aún no tuvieran factura de venta (FV). Se veía "Valor factura"
-- y "Por cobrar" de algo no facturado. Sin FV el valor de la factura es 0; la
-- participación esperada del mes (participation_value) no cambia.

update invoice_participations
   set finto_invoice_value   = 0,
       available_for_payment = 0,
       updated_at            = now()
 where finto_invoice is null
   and coalesce(finto_invoice_value, 0) <> 0;
