import { z } from 'zod'
import { PERIODICITIES } from './accounting.domain.js'

export const periodicitySchema = z.enum(PERIODICITIES)

export const masterItemSchema = z.object({
  title:        z.string().min(3, 'El título debe tener al menos 3 caracteres').max(200),
  description:  z.string().max(500).optional(),
  entity:       z.string().max(120).nullable().optional(),
  is_mandatory: z.boolean(),
  sort_order:   z.coerce.number().int().default(0),
  // Cada cuánto se presenta: genera un vencimiento por período en cada año
  periodicity:  periodicitySchema.default('anual'),
  // Días de anticipación: con cuántos días antes del vencimiento se crea la
  // tarea y empiezan los recordatorios (algunas obligaciones requieren un mes+)
  notice_days:  z.coerce.number().int().min(1).max(120).default(5),
})

export const updateMasterItemSchema = masterItemSchema.partial()

// Obligación de una empresa: override de periodicidad (null = la de la maestra)
export const updateEntrySchema = z.object({
  periodicity: periodicitySchema.nullable().optional(),
  notes:       z.string().max(500).nullable().optional(),
})

export const yearSchema = z.coerce.number().int().min(2020).max(2100)

// Fecha de vencimiento de un período
export const updateDeadlineSchema = z.object({
  due_date:     z.string().date().nullable().optional(),
  notes:        z.string().max(500).nullable().optional(),
  // Solo editable en las fechas adicionales (custom)
  period_label: z.string().min(2).max(120).optional(),
})

// Fecha adicional agregada por el contador (ej. "Pago 2a cuota")
export const createDeadlineSchema = z.object({
  year:         yearSchema,
  period_label: z.string().min(2, 'Describe el período o la cuota').max(120),
  due_date:     z.string().date().nullable().optional(),
})
