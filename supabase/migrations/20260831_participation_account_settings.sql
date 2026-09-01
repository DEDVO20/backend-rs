-- Cuentas contables configurables del import de participaciones.
-- Una sola fila (id=1) con los prefijos de cuenta que usa el reporte "Movimiento
-- por cuenta contable". Permite ajustar el mapeo sin tocar código si una entidad
-- usa cuentas distintas. Los valores admiten varios prefijos separados por "|".

create table if not exists participation_account_settings (
  id                    int primary key default 1 check (id = 1),
  income_account        text not null default '41',
  mandate_account       text not null default '28150601|28051001',
  receivable_account    text not null default '13050501',
  third_invoice_account text not null default '2335',
  payment_account       text not null default '1120|1110',
  updated_at            timestamptz not null default now()
);

-- Fila única por defecto
insert into participation_account_settings (id) values (1)
  on conflict (id) do nothing;

alter table participation_account_settings enable row level security;
