-- Elimina el modelo mensual de participaciones (Fase 1).
-- Reemplazado por el modelo por factura: invoice_participations (Fase 2+).
-- participation_invoicing referencia a monthly_participations con ON DELETE CASCADE,
-- pero la borramos explícitamente primero por claridad.

drop table if exists participation_invoicing cascade;
drop table if exists monthly_participations cascade;
