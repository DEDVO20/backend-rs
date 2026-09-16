-- Registro de documentos del reporte "Movimiento por cuenta contable" para el
-- Cruce (alertas de no cruzados) y Pagos (saldos de RC/RP). Se llena en cada
-- import (apply). Un documento se identifica por (tipo, comprobante, factura).
--   amount  = valor del documento
--   applied = cuánto se cruzó/aplicó a participaciones
--   saldo   = amount - applied (columna generada)
--   matched = si cruzó con algo del sistema

create table if not exists siigo_documents (
  id            uuid primary key default gen_random_uuid(),
  doc_type      text not null check (doc_type in ('FV','RC','NC','ND','FC','RP')),
  comprobante   text not null,
  fv_ref        text not null default '',     -- factura referenciada (RC/NC/ND/RP) o ''
  tercero_nit   text,                          -- NIT del asiento (cliente en FV/RC; tercero en FC/RP)
  tercero_name  text,
  period        text,                          -- yyyy-mm
  doc_date      date,
  amount        numeric(14,2) not null default 0,
  applied       numeric(14,2) not null default 0,
  saldo         numeric(14,2) generated always as (amount - applied) stored,
  matched       boolean not null default false,
  note          text,
  imported_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (doc_type, comprobante, fv_ref)
);

create index if not exists siigo_documents_type_idx    on siigo_documents (doc_type);
create index if not exists siigo_documents_matched_idx on siigo_documents (matched);
create index if not exists siigo_documents_period_idx  on siigo_documents (period);
create index if not exists siigo_documents_nit_idx     on siigo_documents (tercero_nit);

alter table siigo_documents enable row level security;
