import { z } from 'zod'

export const createRequestSchema = z.object({
  request_type_id: z.string().uuid(),
  title:           z.string().min(3),
  description:     z.string().optional(),
  priority:        z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  service_id:      z.string().uuid().optional(),
  metadata:        z.record(z.unknown()).optional(),
})

export const updateRequestSchema = z.object({
  status:             z.enum(['open','in_progress','resolved','closed','cancelled']).optional(),
  assigned_to_user_id: z.string().uuid().nullable().optional(),
  priority:           z.enum(['low','medium','high','urgent']).optional(),
  due_at:             z.string().datetime().nullable().optional(),
  billing_status:     z.enum(['pending','billed','waived','not_applicable']).nullable().optional(),
  extra_fee:          z.number().nonnegative().nullable().optional(),
})

export const listRequestsQuerySchema = z.object({
  company_id:      z.string().uuid().optional(),
  status:          z.enum(['open','in_progress','resolved','closed','cancelled']).optional(),
  priority:        z.enum(['low','medium','high','urgent']).optional(),
  request_type_id: z.string().uuid().optional(),
  period_year:     z.coerce.number().int().optional(),
  period_month:    z.coerce.number().int().min(1).max(12).optional(),
  page:            z.coerce.number().int().positive().default(1),
  limit:           z.coerce.number().int().positive().max(100).default(20),
})
