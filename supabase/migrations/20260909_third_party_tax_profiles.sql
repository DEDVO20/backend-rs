-- Módulo: Perfiles tributarios (Colombia)
-- Un PERFIL TRIBUTARIO es un catálogo reutilizable (clasificación DIAN) que se
-- ASIGNA a un tercero. El perfil descompone las características tributarias
-- (spec §2): régimen de renta, responsabilidad de IVA, gran contribuyente,
-- autorretenedor, sujeción a cada retención y capacidad de ser agente retenedor.
-- El motor de cálculo (src/modules/tax/tax.domain.ts) es puro y parametrizable:
-- agregar un perfil nuevo NO cambia la lógica (spec §9).

-- ── Catálogo de perfiles tributarios ─────────────────────────────────────────
create table if not exists tax_profiles (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  description  text,

  -- regimen_renta — "Gran Contribuyente" NO es un régimen: es una calificación.
  tax_regime   text not null default 'ORDINARY' check (tax_regime in ('ORDINARY', 'SIMPLE')),
  -- responsable_iva — independiente del régimen (spec §1)
  iva_responsible boolean not null default false,
  -- calificaciones adicionales
  grand_taxpayer  boolean not null default false,   -- gran contribuyente
  self_withholder boolean not null default false,   -- autorretenedor de renta

  -- Como EMISOR: ¿está sujeto a cada retención? (configurable, spec §1)
  subject_income_withholding boolean not null default false,
  subject_ica_withholding    boolean not null default false,
  subject_iva_withholding    boolean not null default false,

  -- Como RECEPTOR/pagador: ¿es agente retenedor de cada tipo?
  agent_income_withholding boolean not null default false,
  agent_ica_withholding    boolean not null default false,
  agent_iva_withholding    boolean not null default false,

  -- Overrides de tarifa (null ⇒ usar la tarifa por defecto de la operación)
  iva_rate                numeric(6,5),
  income_withholding_rate numeric(6,5),
  ica_withholding_rate    numeric(6,5),
  iva_withholding_rate    numeric(6,5),

  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Asignación del perfil al tercero ─────────────────────────────────────────
-- El tercero conserva su identidad (tipo de persona) y apunta a un perfil.
alter table third_parties
  add column if not exists person_type text not null default 'NATURAL'
    check (person_type in ('NATURAL', 'JURIDICA')),
  add column if not exists tax_profile_id uuid references tax_profiles(id) on delete set null;

-- ── Limpieza del diseño anterior (perfiles inline + terceros de ejemplo) ─────
-- Idempotente: solo actúa si venías del primer intento.
delete from third_parties where identification like 'SAMPLE-%';
alter table third_parties
  drop column if exists is_tax_sample,
  drop column if exists tax_regime,
  drop column if exists iva_responsible,
  drop column if exists grand_taxpayer,
  drop column if exists agent_income_withholding,
  drop column if exists agent_ica_withholding,
  drop column if exists agent_iva_withholding,
  drop column if exists subject_income_withholding,
  drop column if exists subject_ica_withholding,
  drop column if exists subject_iva_withholding,
  drop column if exists iva_rate,
  drop column if exists income_withholding_rate,
  drop column if exists ica_withholding_rate,
  drop column if exists iva_withholding_rate;

-- ── Parámetros por defecto de la operación (spec §3, §10) ────────────────────
-- Los porcentajes del escenario NO se escriben en el código: viven aquí y son
-- editables. Fila única (singleton).
create table if not exists tax_operation_settings (
  id                      int primary key default 1 check (id = 1),
  iva_rate                numeric(6,5) not null default 0.19000,   -- IVA de la factura
  income_withholding_rate numeric(6,5) not null default 0.11000,   -- retefuente
  ica_withholding_rate    numeric(6,5) not null default 0.00866,   -- reteICA
  iva_withholding_rate    numeric(6,5) not null default 0.15000,   -- reteIVA (sobre el IVA)
  commission_rate         numeric(6,5) not null default 0.20000,   -- comisión
  commission_iva_rate     numeric(6,5) not null default 0.19000,   -- IVA de la comisión
  default_invoice_value   numeric(14,2) not null default 600000,   -- valor factura de ejemplo
  updated_at              timestamptz not null default now()
);

insert into tax_operation_settings (id) values (1) on conflict (id) do nothing;

-- ── Semilla del catálogo DIAN (6 perfiles) — editables desde la UI ───────────
-- Tarifas null ⇒ usan la tarifa por defecto de la operación. Los flags reflejan
-- el comportamiento típico DIAN; ajustables por perfil.
insert into tax_profiles (name, description, tax_regime, iva_responsible, grand_taxpayer,
    self_withholder, subject_income_withholding, subject_ica_withholding, subject_iva_withholding,
    agent_income_withholding, agent_ica_withholding, agent_iva_withholding)
values
  ('Persona natural – No responsable de IVA',
   'Régimen ordinario, no responsable de IVA. Sujeta a retefuente y reteICA.',
   'ORDINARY', false, false, false,  true,  true,  false,  false, false, false),

  ('Persona natural – Responsable de IVA',
   'Régimen ordinario, responsable de IVA (19%). Sujeta a retefuente y reteICA.',
   'ORDINARY', true, false, false,  true,  true,  false,  false, false, false),

  ('Persona jurídica – Responsable de IVA (Régimen Ordinario)',
   'Antes "Régimen Común". Responsable de IVA (19%), agente de retención.',
   'ORDINARY', true, false, false,  true,  true,  false,  true,  true,  false),

  ('Régimen Simple (SIMPLE) – No responsable de IVA',
   'Régimen Simple de Tributación, no responsable de IVA. No sujeto a retefuente ni reteICA por terceros.',
   'SIMPLE', false, false, false,  false, false, false,  false, false, false),

  ('Régimen Simple (SIMPLE) – Responsable de IVA',
   'Régimen Simple de Tributación, responsable de IVA (19%). No sujeto a retefuente ni reteICA por terceros; sí sujeto a reteIVA (15%).',
   'SIMPLE', true, false, false,  false, false, true,  false, false, false),

  ('Gran Contribuyente',
   'Responsable de IVA (19%) y autorretenedor de renta. No le retienen renta terceros; sujeto a reteICA. Agente de retención.',
   'ORDINARY', true, true, true,  false, true, false,  true, true, true)
on conflict (name) do nothing;

alter table tax_profiles           enable row level security;
alter table tax_operation_settings enable row level security;
