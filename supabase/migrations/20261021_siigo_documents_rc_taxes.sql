-- Impuestos retenidos por el cliente en cada recaudo (RC). El reporte
-- "Movimiento por cuenta contable" trae, junto a la línea de cartera 13050501,
-- las líneas de anticipo de impuestos 1355… (retefuente 135515, reteIVA 135517,
-- reteICA 135518) que el cliente descontó al pagar. Se guardan en el documento
-- RC para mostrarlos en el informe de participaciones.

alter table siigo_documents
  add column if not exists tax_income_withholding numeric(14,2) not null default 0,
  add column if not exists tax_ica_withholding    numeric(14,2) not null default 0,
  add column if not exists tax_iva_withholding    numeric(14,2) not null default 0;

comment on column siigo_documents.tax_income_withholding is 'RC: retención en la fuente que practicó el cliente (1355…)';
comment on column siigo_documents.tax_ica_withholding    is 'RC: reteICA que practicó el cliente (135518…)';
comment on column siigo_documents.tax_iva_withholding    is 'RC: reteIVA que practicó el cliente (135517…)';
