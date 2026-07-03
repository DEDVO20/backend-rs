-- Índices para acelerar las consultas más frecuentes de tareas y cron logs.

-- Listado de tareas: siempre filtra por company_id y ordena por due_date
CREATE INDEX IF NOT EXISTS idx_tasks_company_due
  ON tasks (company_id, due_date);

-- Filtros habituales del listado
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_type ON tasks (owner_type);
CREATE INDEX IF NOT EXISTS idx_tasks_service    ON tasks (service_id);

-- Recordatorios diarios: busca por status + due_date
CREATE INDEX IF NOT EXISTS idx_tasks_status_due
  ON tasks (status, due_date);

-- Historial de cron: ordena por executed_at descendente
CREATE INDEX IF NOT EXISTS idx_cron_logs_executed
  ON cron_logs (executed_at DESC);

-- Generación de tareas: lookup de servicios activos por empresa
CREATE INDEX IF NOT EXISTS idx_company_services_active
  ON company_services (service_id, company_id) WHERE active = true;

-- Auth: el middleware lee el perfil en cada login/refresh
-- (profiles.id ya es PK, no necesita índice extra)
