import { z } from 'zod'

export const listDebtorsQuerySchema = z.object({
  status:     z.enum(['pending','in_collection','promised','agreement','partially_paid','paid','defaulted','uncontactable']).optional(),
  search:     z.string().optional(),
  assigned:   z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  page:       z.coerce.number().int().positive().default(1),
  limit:      z.coerce.number().int().positive().max(500).default(20),
})

export const updateDebtorSchema = z.object({
  status:            z.enum(['pending','in_collection','promised','agreement','partially_paid','paid','defaulted','uncontactable']).optional(),
  assigned_user_id:  z.string().uuid().nullable().optional(),
  preferred_channel: z.enum(['sms','email','whatsapp','phone','manual']).optional(),
  notes:             z.string().optional(),
  debtor_name:       z.string().min(2).optional(),
  phone:             z.string().optional(),
  whatsapp:          z.string().optional(),
  email:             z.string().email().optional().or(z.literal('')),
  city:              z.string().optional(),
})

export const createActionSchema = z.object({
  debtor_id:      z.string().uuid(),
  channel:        z.enum(['sms','email','whatsapp','phone','manual']),
  result:         z.enum(['contacted','no_answer','wrong_number','bounced_email','whatsapp_unavailable','requested_extension','payment_promise','payment_agreement','partial_payment','paid','rejected','uncontactable']),
  notes:          z.string().optional(),
  next_follow_up: z.string().date().optional(),
})

export const createAgreementSchema = z.object({
  debtor_id:         z.string().uuid(),
  type:              z.enum(['promise','installment']),
  promised_amount:   z.number().nonnegative(),
  total_amount:      z.number().nonnegative(),
  installment_count: z.number().int().positive().default(1),
  first_due_date:    z.string().date().optional(),
  notes:             z.string().optional(),
})

export const createCampaignSchema = z.object({
  name:             z.string().min(3),
  channel:          z.enum(['sms','email','whatsapp','manual']),
  template_id:      z.string().uuid().optional(),
  segment_filter:   z.record(z.unknown()).optional(),
  scheduled_at:     z.string().datetime().optional(),
  debtor_ids:       z.array(z.string().uuid()).optional(),
  message_template: z.string().optional(),
  company_id:       z.string().uuid().optional(),
})

export const listActionsQuerySchema = z.object({
  debtor_id: z.string().uuid().optional(),
  page:      z.coerce.number().int().positive().default(1),
  limit:     z.coerce.number().int().positive().max(100).default(50),
})

export const createDebtorSchema = z.object({
  debtor_document:   z.string().min(1),
  debtor_name:       z.string().min(2),
  city:              z.string().optional(),
  phone:             z.string().optional(),
  email:             z.string().email().optional().or(z.literal('')),
  whatsapp:          z.string().optional(),
  preferred_channel: z.enum(['sms','email','whatsapp','phone','manual']).optional(),
  notes:             z.string().optional(),
})

export const createDebtSchema = z.object({
  debtor_id:         z.string().uuid(),
  siigo_document:    z.string().min(1),
  due_date:          z.string().date().optional(),
  branch:            z.string().optional(),
  cost_center:       z.string().optional(),
  seller:            z.string().optional(),
  overdue_1_30:      z.number().nonnegative().default(0),
  overdue_31_60:     z.number().nonnegative().default(0),
  overdue_61_90:     z.number().nonnegative().default(0),
  overdue_91_plus:   z.number().nonnegative().default(0),
  not_yet_due:       z.number().nonnegative().default(0),
  credit_balance:    z.number().nonnegative().default(0),
  total_balance:     z.number().default(0),
  outstanding_amount: z.number().nonnegative().default(0),
  currency:          z.string().default('COP'),
})

export const createTemplateSchema = z.object({
  name:               z.string().min(2),
  channel:            z.enum(['sms','email','whatsapp','manual']),
  subject:            z.string().optional(),
  body:               z.string().min(5),
  is_active:          z.boolean().default(true),
  is_global:          z.boolean().default(false),
  tramo:              z.number().int().min(0).optional(),
})

export const createCollectionTaskSchema = z.object({
  debtor_id:        z.string().uuid().optional(),
  assigned_user_id: z.string().uuid().optional(),
  title:            z.string().min(3),
  description:      z.string().optional(),
  due_date:         z.string().date().optional(),
  priority:         z.enum(['high','medium','low']).default('medium'),
})

export const updateCollectionTaskSchema = createCollectionTaskSchema.partial().extend({
  status: z.enum(['pending','in_progress','completed','cancelled']).optional(),
})

export const listMessagesQuerySchema = z.object({
  debtor_id:  z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  status:     z.enum(['unread','read']).optional(),
  page:       z.coerce.number().int().positive().default(1),
  limit:      z.coerce.number().int().positive().max(100).default(50),
})
