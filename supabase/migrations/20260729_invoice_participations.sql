-- Fase 2: modelo "por factura". Cada factura de venta (FV) que cruza con una
-- participación configurada genera una fila aquí. El recaudo (recibos de caja)
-- determina cuánto queda disponible para pagar al tercero (proporcional).

create table if not exists invoice_participations (
  id                    uuid primary key default gen_random_uuid(),
  participation_id      uuid not null references service_participations(id) on delete cascade,
  company_id            uuid references companies(id) on delete set null,

  -- Factura de Finto (FV) que origina la participación
  finto_invoice         text not null,
  finto_invoice_date    date,
  finto_invoice_value   numeric(14,2) not null,

  -- Snapshot de la configuración al momento de crearla
  participation_type    text not null default 'percentage',
  percentage            numeric(5,2) not null default 0,
  fixed_value           numeric(14,2),
  participation_value   numeric(14,2) not null,      -- participación total calculada
  purchase_order        text not null,               -- OC-YYYYMM-NNNNNN

  -- Recaudo del cliente y disponible para pago (proporcional)
  collected             numeric(14,2) not null default 0,
  cash_receipts         text,                         -- números de recibo aplicados
  available_for_payment numeric(14,2) not null default 0,

  -- Lado del tercero (Fase 3/4)
  third_party_invoice       text,
  third_party_invoice_date  date,
  third_party_invoice_value numeric(14,2),
  egress_voucher            text,
  egress_voucher_date       date,
  egress_voucher_value      numeric(14,2),

  -- Estado del proceso (ver deriveInvoiceStatus)
  status                text not null default 'invoiced',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Una FV genera una sola participación (idempotencia al reimportar)
  unique (finto_invoice)
);

create index if not exists invoice_participations_company_idx on invoice_participations (company_id);
create index if not exists invoice_participations_status_idx  on invoice_participations (status);
create index if not exists invoice_participations_part_idx    on invoice_participations (participation_id);

alter table invoice_participations enable row level security;
