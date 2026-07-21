-- Anticipación configurable por tarea del calendario tributario.
-- Cada tarea de la maestra define cuántos días antes del vencimiento se crea
-- su tarea (algunas obligaciones requieren hasta un mes o más de trabajo).

alter table tax_calendar_master add column if not exists notice_days int not null default 5;

comment on column tax_calendar_master.notice_days is
  'días de anticipación con los que el cron crea la tarea antes del vencimiento';
