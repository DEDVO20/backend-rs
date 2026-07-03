-- Dependencias entre servicios para generación de tareas.
-- provider_service_id: servicio que puede producir internamente el documento
-- que esta tarea le pediría al cliente. Si el cliente tiene ese servicio
-- contratado, la tarea se asigna al área interna en vez del cliente.

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS provider_service_id uuid REFERENCES services(id) ON DELETE SET NULL;

-- En la tarea generada guardamos qué servicio interno quedó responsable
-- (null = la tarea quedó asignada según su owner_type original)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS provider_service_id uuid REFERENCES services(id) ON DELETE SET NULL;
