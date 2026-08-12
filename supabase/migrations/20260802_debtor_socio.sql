-- "Socio" del reporte de cartera de SIIGO: identifica al socio/responsable del
-- cliente. Se guarda a nivel de deudor para poder filtrar la cartera por socio.
alter table collection_debtors add column if not exists socio text;

create index if not exists collection_debtors_socio_idx on collection_debtors (socio);

comment on column collection_debtors.socio is 'Socio responsable del cliente (columna "Socio" del reporte SIIGO)';
