-- Cierre manual de tareas por administradores.
-- Permite marcar una tarea como completada saltando el flujo normal
-- (owner_type / documento requerido), dejando registro de quién y por qué.

alter table tasks add column if not exists closed_manually boolean not null default false;
alter table tasks add column if not exists closed_by       uuid references auth.users(id) on delete set null;
alter table tasks add column if not exists closure_reason  text;
alter table tasks add column if not exists closed_at       timestamptz;

comment on column tasks.closed_manually is 'true si un admin cerró la tarea manualmente (fuera del flujo normal)';
comment on column tasks.closed_by       is 'usuario que realizó el cierre manual';
comment on column tasks.closure_reason  is 'motivo del cierre manual';
comment on column tasks.closed_at       is 'fecha del cierre manual';
