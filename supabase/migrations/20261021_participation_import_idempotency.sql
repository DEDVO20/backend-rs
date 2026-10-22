-- Importación idempotente del reporte "Movimiento por cuenta contable".
-- Subir el mismo archivo dos veces no debe duplicar documentos ni deshacer lo
-- que se corrigió a mano después de importar.

-- Firma de lo CAUSADO que trajo el último import de cada OC (valor de factura,
-- NC/ND, participación…). Si el siguiente import trae exactamente lo mismo, la
-- OC no se toca y se conservan las correcciones manuales; si trae algo distinto
-- (otra NC, otro valor), se actualiza.
alter table invoice_participations
  add column if not exists import_signature text;

comment on column invoice_participations.import_signature is
  'Firma de los valores causados que trajo el último import del reporte de movimiento';

-- Registro de archivos importados (huella del contenido) para avisar si se
-- intenta aplicar de nuevo el mismo reporte.
create table if not exists participation_imports (
  id           uuid primary key default gen_random_uuid(),
  content_hash text not null,
  file_name    text,
  imported_by  text,
  summary      jsonb,
  imported_at  timestamptz not null default now()
);

create index if not exists participation_imports_hash_idx on participation_imports (content_hash);

alter table participation_imports enable row level security;
