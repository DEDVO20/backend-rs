import { z } from 'zod'

export const createOnboardingSchema = z.object({
  company_name:    z.string().min(2),
  company_nit:     z.string().optional(),
  company_type:    z.string().optional(),
  company_sector:  z.string().optional(),
  company_city:    z.string().optional(),
  company_address: z.string().optional(),
  company_phone:   z.string().optional(),
  company_website: z.string().url().optional().or(z.literal('')),
  rep_name:        z.string().min(2),
  rep_email:       z.string().email(),
  rep_phone:       z.string().optional(),
  rep_cedula:      z.string().optional(),
  rep_position:    z.string().optional(),
  ip_address:      z.string().optional(),
  user_agent:      z.string().optional(),
  utm_source:      z.string().optional(),
  referral_code:   z.string().optional(),
})

export const updateOnboardingSchema = createOnboardingSchema.partial().extend({
  status:       z.string().optional(),
  review_notes: z.string().nullable().optional(),
})

export const selectServicesSchema = z.object({
  services: z.array(z.object({
    service_id:        z.string().uuid(),
    price_cop:         z.number().positive().optional(),
    billing_frequency: z.enum(['monthly', 'quarterly', 'annual']).optional(),
  })).min(1),
})

export const acceptPoliciesSchema = z.object({
  policies: z.array(z.object({
    policy_version_id:  z.string().uuid(),
    accepted_by_name:   z.string().min(2),
    accepted_by_email:  z.string().email(),
    accepted_by_cedula: z.string().optional(),
    ip_address:         z.string().optional(),
    user_agent:         z.string().optional(),
  })).min(1),
})

export const uploadKycDocSchema = z.object({
  doc_type:        z.enum(['rut','cedula_representante','sarlaft_form','camara_comercio','estados_financieros','otro']),
  storage_path:    z.string(),
  file_url:        z.string().optional(),
  original_name:   z.string().optional(),
  file_name:       z.string().optional(),
  mime_type:       z.string().optional(),
  size_bytes:      z.number().int().positive().optional(),
  file_size_bytes: z.number().int().positive().optional(),
})

export const reviewKycDocSchema = z.object({
  status:           z.enum(['verified','rejected']),
  rejection_reason: z.string().optional(),
})

export const submitOnboardingSchema = z.object({
  company_name:    z.string().min(2),
  company_nit:     z.string().optional(),
  company_type:    z.string().optional(),
  company_sector:  z.string().optional(),
  company_city:    z.string().optional(),
  company_address: z.string().optional(),
  company_phone:   z.string().optional(),
  company_website: z.string().url().optional().or(z.literal('')),
  rep_name:        z.string().min(2),
  rep_email:       z.string().email(),
  rep_phone:       z.string().optional(),
  rep_cedula:      z.string().optional(),
  rep_position:    z.string().optional(),
})

export const rejectOnboardingSchema = z.object({
  rejection_reason: z.string().min(10),
  review_notes:     z.string().optional(),
})

export const listOnboardingQuerySchema = z.object({
  status: z.enum([
    'draft','services_selected','policies_accepted','kyc_submitted',
    'pending_review','approved','rejected','resubmit','needs_correction',
  ]).optional(),
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})
