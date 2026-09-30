-- Conciliación manual asistida (Opción C, Fase 1 — el dinero).
-- Cada fila enlaza UN documento de dinero (RC/FC/RP) con UNA OC
-- (invoice_participations) por un monto. Es la única fuente de verdad del cruce
-- del dinero: los campos de recaudo/factura tercero/pago de la OC se derivan de
-- aquí, y el saldo de cada RC/FC/RP = valor del doc − Σ asignado.
--   origin = 'auto'   → propuesto por el FIFO (sugerencia aplicada)
--   origin = 'manual' → asignado por el usuario (nunca lo pisa el auto)

create table if not exists participation_allocations (
  id                        uuid primary key default gen_random_uuid(),
  source_doc_type           text not null check (source_doc_type in ('RC','FC','RP')),
  source_comprobante        text not null,
  source_nit                text,                 -- cliente (RC) o tercero (FC/RP)
  invoice_participation_id  uuid not null references invoice_participations(id) on delete cascade,
  amount                    numeric(14,2) not null default 0 check (amount >= 0),
  origin                    text not null default 'manual' check (origin in ('auto','manual')),
  note                      text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  -- un mismo comprobante no se enlaza dos veces a la misma OC (se acumula en amount)
  unique (source_doc_type, source_comprobante, invoice_participation_id)
);

create index if not exists participation_allocations_oc_idx
  on participation_allocations (invoice_participation_id);
create index if not exists participation_allocations_src_idx
  on participation_allocations (source_doc_type, source_comprobante);

alter table participation_allocations enable row level security;
