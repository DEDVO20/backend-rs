-- Vincula documentos con el servicio/área contratada.
-- El filtro de "áreas" en documentos sale de los servicios (services /
-- company_services), no de una lista quemada en el frontend.

alter table documents add column if not exists service_id uuid references services(id) on delete set null;

create index if not exists documents_service_id_idx on documents (service_id);
create index if not exists documents_company_id_idx on documents (company_id);

-- Best-effort: mapear las categorías de texto existentes ('facturacion',
-- 'contabilidad', ...) al servicio cuyo nombre coincida sin tildes.
update documents d
set service_id = s.id
from services s
where d.service_id is null
  and d.category is not null
  and lower(translate(s.name, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) = lower(d.category);
