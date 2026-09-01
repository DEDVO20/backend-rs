-- Notas crédito / débito aplicadas al valor neto del servicio.
--   valor_neto = finto_invoice_value - credit_note_value + debit_note_value
--   participation_value = valor_neto × %  (o porción de mandato neta)
-- Solo se aplican las NC/ND que referencian la FV en su descripción; las demás
-- se informan pero no ajustan (quedan en 0 aquí).

alter table invoice_participations
  add column if not exists credit_note_value numeric(14,2) not null default 0;

alter table invoice_participations
  add column if not exists debit_note_value numeric(14,2) not null default 0;

comment on column invoice_participations.credit_note_value is 'Suma de notas crédito (NC) ligadas a la FV — restan del valor neto';
comment on column invoice_participations.debit_note_value  is 'Suma de notas débito (ND) ligadas a la FV — suman al valor neto';
