import { z } from 'zod'

export const masterItemSchema = z.object({
  title:        z.string().min(3, 'El título debe tener al menos 3 caracteres').max(200),
  description:  z.string().max(500).optional(),
  is_mandatory: z.boolean(),
  sort_order:   z.coerce.number().int().default(0),
  // Días de anticipación: con cuántos días antes del vencimiento se crea la
  // tarea y empiezan los recordatorios (algunas obligaciones requieren un mes+)
  notice_days:  z.coerce.number().int().min(1).max(120).default(5),
})

export const updateMasterItemSchema = masterItemSchema.partial()

export const updateEntrySchema = z.object({
  due_date: z.string().date().nullable().optional(),
  notes:    z.string().max(500).nullable().optional(),
})
