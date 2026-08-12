-- Nombre de la persona que administra / se encarga del correo (tesorería) del deudor.
alter table collection_debtors add column if not exists email_contact_name text;

comment on column collection_debtors.email_contact_name is
  'Nombre de la persona encargada del correo (tesorería) del deudor';
