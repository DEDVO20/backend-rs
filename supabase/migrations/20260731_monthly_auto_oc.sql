-- OC mensual automática por servicio contratado.
-- La OC ya no nace solo de la factura de venta (FV): un cron la crea a inicio de
-- mes para cada participación activa con tercero. La FV se asocia después, al
-- importar las ventas (por cliente + periodo). Por eso:
--   1. finto_invoice deja de ser obligatoria (la OC vive sin FV hasta que llega).
--   2. se agrega 'period' (YYYY-MM) como llave del mes.
--   3. el único cambia: una sola OC "pendiente" (sin FV) por servicio y mes,
--      y la FV sigue siendo única cuando existe.

alter table invoice_participations alter column finto_invoice drop not null;

alter table invoice_participations add column if not exists period text;  -- 'YYYY-MM'

-- Backfill del periodo para filas existentes (a partir de la fecha de la FV)
update invoice_participations
   set period = to_char(finto_invoice_date, 'YYYY-MM')
 where period is null and finto_invoice_date is not null;

-- Reemplazar el único global de la FV por dos índices parciales
alter table invoice_participations drop constraint if exists invoice_participations_finto_invoice_key;

-- A lo sumo una OC pendiente (sin FV) por servicio y mes → idempotencia del cron
create unique index if not exists invoice_participations_pending_uq
  on invoice_participations (participation_id, period)
  where finto_invoice is null;

-- La FV sigue siendo única cuando está registrada
create unique index if not exists invoice_participations_finto_uq
  on invoice_participations (finto_invoice)
  where finto_invoice is not null;

create index if not exists invoice_participations_period_idx
  on invoice_participations (period);
