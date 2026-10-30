-- La participación causada de una OC se puede corregir a mano (etapa 1 del
-- detalle). Esta marca evita que un import posterior o un cambio del % del
-- tercero la vuelva a calcular encima.

alter table invoice_participations
  add column if not exists participation_value_manual boolean not null default false;
