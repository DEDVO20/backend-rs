import { supabase }           from '../../lib/supabase.js'
import { logger }             from '../../lib/logger.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import type { z }             from 'zod'
import type {
  listOnboardingQuerySchema,
  rejectOnboardingSchema,
  createOnboardingSchema,
  updateOnboardingSchema,
  selectServicesSchema,
  acceptPoliciesSchema,
  uploadKycDocSchema,
  reviewKycDocSchema,
} from './onboarding.schema.js'

type ListQuery      = z.infer<typeof listOnboardingQuerySchema>
type RejectInput    = z.infer<typeof rejectOnboardingSchema>
type CreateInput    = z.infer<typeof createOnboardingSchema>
type UpdateInput    = z.infer<typeof updateOnboardingSchema>
type ServicesInput  = z.infer<typeof selectServicesSchema>
type PoliciesInput  = z.infer<typeof acceptPoliciesSchema>
type KycDocInput    = z.infer<typeof uploadKycDocSchema>
type KycDocReview   = z.infer<typeof reviewKycDocSchema>

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

export class OnboardingService {
  static async list(query: ListQuery, reviewerId: string) {
    const { status, page, limit } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('client_onboardings')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (status) q = q.eq('status', status)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async getById(id: string) {
    const { data, error } = await supabase
      .from('client_onboardings')
      .select(`
        *,
        kyc_submissions(*,kyc_documents(*)),
        service_contracts(*,services(*)),
        policy_acceptances(*,policy_versions(title,version))
      `)
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  }

  static async approve(id: string, reviewerId: string) {
    const { data, error } = await supabase
      .from('client_onboardings')
      .update({
        status:      'approved',
        reviewed_by: reviewerId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    logger.info({ onboardingId: id, reviewerId }, 'Onboarding aprobado')

    void NotificationService.enqueue({
      channel:   'email',
      template:  'kyc-approved',
      to:        data.rep_email,
      data: {
        ownerName:   data.rep_name,
        companyName: data.company_name,
        platformUrl: PLATFORM_URL,
      },
      companyId: data.company_id ?? undefined,
    })

    return data
  }

  static async reject(id: string, reviewerId: string, input: RejectInput) {
    const { data, error } = await supabase
      .from('client_onboardings')
      .update({
        status:           'rejected',
        reviewed_by:      reviewerId,
        reviewed_at:      new Date().toISOString(),
        rejection_reason: input.rejection_reason,
        review_notes:     input.review_notes ?? null,
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    logger.info({ onboardingId: id, reviewerId }, 'Onboarding rechazado')

    void NotificationService.enqueue({
      channel:  'email',
      template: 'kyc-rejected',
      to:       data.rep_email,
      data: {
        ownerName: data.rep_name,
        reason:    input.rejection_reason,
      },
    })

    return data
  }

  static async create(input: CreateInput) {
    const { data, error } = await supabase
      .from('client_onboardings')
      .insert({ ...input, status: 'draft', current_step: 1 })
      .select()
      .single()

    if (error) {
      // Unique constraint violation → 409 con mensaje legible
      if (error.code === '23505') {
        const dup = error.message.includes('company_nit')
          ? 'Ya existe una solicitud con ese NIT.'
          : error.message.includes('rep_email')
          ? 'Ya existe una solicitud con ese correo electrónico.'
          : 'Ya existe una solicitud con esos datos.'
        const conflict = new Error(dup) as any
        conflict.statusCode = 409
        throw conflict
      }
      throw error
    }
    return data
  }

  static async update(id: string, input: UpdateInput) {
    const { data, error } = await supabase
      .from('client_onboardings')
      .update(input)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async selectServices(id: string, input: ServicesInput) {
    // Upsert service_contracts
    const rows = input.services.map(s => ({
      onboarding_id:     id,
      service_id:        s.service_id,
      status:            'selected',
      price_cop:         s.price_cop ?? null,
      billing_frequency: s.billing_frequency ?? null,
    }))

    const { error } = await supabase
      .from('service_contracts')
      .upsert(rows, { onConflict: 'onboarding_id,service_id' })

    if (error) throw error

    // Avanzar step
    await supabase
      .from('client_onboardings')
      .update({ status: 'services_selected', current_step: 2 })
      .eq('id', id)

    return { ok: true, count: rows.length }
  }

  static async acceptPolicies(id: string, input: PoliciesInput) {
    const rows = input.policies.map(p => ({
      onboarding_id:      id,
      policy_version_id:  p.policy_version_id,
      accepted_by_name:   p.accepted_by_name,
      accepted_by_email:  p.accepted_by_email,
      accepted_by_cedula: p.accepted_by_cedula ?? null,
      ip_address:         p.ip_address ?? null,
      user_agent:         p.user_agent ?? null,
      acceptance_method:  'checkbox',
    }))

    const { error } = await supabase
      .from('policy_acceptances')
      .upsert(rows, { onConflict: 'onboarding_id,policy_version_id' })

    if (error) throw error

    await supabase
      .from('client_onboardings')
      .update({ status: 'policies_accepted', current_step: 3 })
      .eq('id', id)

    return { ok: true, count: rows.length }
  }

  static async getOrCreateKycSubmission(onboardingId: string) {
    const { data: existing } = await supabase
      .from('kyc_submissions')
      .select('*')
      .eq('onboarding_id', onboardingId)
      .maybeSingle()

    if (existing) return existing

    const { data, error } = await supabase
      .from('kyc_submissions')
      .insert({ onboarding_id: onboardingId, status: 'pending' })
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async uploadKycDoc(onboardingId: string, input: KycDocInput, reviewerId?: string) {
    const submission = await OnboardingService.getOrCreateKycSubmission(onboardingId)

    const { data, error } = await supabase
      .from('kyc_documents')
      .upsert({
        kyc_submission_id: submission.id,
        doc_type:          input.doc_type,
        status:            'uploaded',
        original_name:     input.original_name,
        storage_path:      input.storage_path,
        file_url:          input.file_url,
        mime_type:         input.mime_type ?? null,
        size_bytes:        input.size_bytes ?? null,
        uploaded_at:       new Date().toISOString(),
      }, { onConflict: 'kyc_submission_id,doc_type' })
      .select()
      .single()

    if (error) throw error

    await supabase
      .from('client_onboardings')
      .update({ status: 'kyc_submitted', current_step: 4 })
      .eq('id', onboardingId)
      .in('status', ['policies_accepted', 'kyc_submitted', 'needs_correction'])

    return data
  }

  static async reviewKycDoc(docId: string, input: KycDocReview, reviewerId: string) {
    const { data, error } = await supabase
      .from('kyc_documents')
      .update({
        status:           input.status,
        rejection_reason: input.rejection_reason ?? null,
        verified_by:      reviewerId,
        verified_at:      input.status === 'verified' ? new Date().toISOString() : null,
      })
      .eq('id', docId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async submit(id: string) {
    const { data, error } = await supabase
      .from('client_onboardings')
      .update({
        status:       'pending_review',
        current_step: 5,
        submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    // Actualizar kyc_submission a under_review
    await supabase
      .from('kyc_submissions')
      .update({ status: 'under_review', submitted_at: new Date().toISOString() })
      .eq('onboarding_id', id)

    logger.info({ onboardingId: id }, 'Onboarding enviado a revisión')
    return data
  }

  static async requestCorrection(id: string, reviewerId: string, notes: string) {
    const { data, error } = await supabase
      .from('client_onboardings')
      .update({
        status:       'needs_correction',
        reviewed_by:  reviewerId,
        reviewed_at:  new Date().toISOString(),
        review_notes: notes,
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    void NotificationService.enqueue({
      channel:  'email',
      template: 'kyc-rejected',
      to:       data.rep_email,
      data: {
        ownerName: data.rep_name,
        reason:    notes,
      },
    })

    return data
  }
}
