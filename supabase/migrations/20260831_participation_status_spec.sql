-- Estados de la relación según el spec (§15). Reemplaza el vocabulario anterior
-- (orientado al recaudo) por el de conciliación con el tercero. El recaudo sigue
-- reflejándose en available_for_payment (numérico), no en el estado.
--   pending_invoice        (OC del mes sin FV)            — se conserva
--   pending_third_invoice  (PENDIENTE_FACTURA_TERCERO)
--   value_difference       (DIFERENCIA_VALOR)
--   pending_payment        (PENDIENTE_PAGO)
--   complete               (COMPLETA)

-- Remapeo de los estados anteriores en filas ya existentes
update invoice_participations set status = 'complete'
  where status in ('paid', 'closed');
update invoice_participations set status = 'pending_payment'
  where status = 'payment_in_process';
update invoice_participations set status = 'pending_third_invoice'
  where status in ('invoiced', 'partial_collection', 'available');

-- Nuevo default
alter table invoice_participations alter column status set default 'pending_third_invoice';
