import { z } from 'zod'

export const listTasksQuerySchema = z.object({
  company_id: z.string().uuid().optional(),
  status:     z.enum(['pending', 'in_progress', 'done', 'overdue']).optional(),
  owner_type: z.enum(['client', 'rs_team']).optional(),
  service_id: z.string().uuid().optional(),
  page:       z.coerce.number().int().positive().default(1),
  limit:      z.coerce.number().int().positive().max(100).default(20),
})

export const updateTaskSchema = z.object({
  status:      z.enum(['pending', 'in_progress', 'done', 'overdue']).optional(),
  document_id: z.string().uuid().nullable().optional(),
})

export const createTaskSchema = z.object({
  company_id:        z.string().uuid(),
  title:             z.string().min(3),
  due_date:          z.string().date().optional(),
  owner_type:        z.enum(['client', 'rs_team']).optional(),
  service_id:        z.string().uuid().optional(),
  requires_document: z.boolean().default(false),
})

export const generateTasksSchema = z.object({
  year:  z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12).optional(),
  day:   z.coerce.number().int().min(1).max(31).optional(),
})
