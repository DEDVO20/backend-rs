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

    // 1. Crear la empresa
    let companyId = data.company_id
    if (!companyId) {
      const { data: company, error: companyErr } = await supabase
        .from('companies')
        .insert({
          name:    data.company_name,
          nit:     data.company_nit ?? null,
          city:    data.company_city ?? null,
          sector:  data.company_sector ?? null,
          phone:   data.company_phone ?? null,
          address: data.company_address ?? null,
          website: data.company_website ?? null,
          status:  'activa',
        })
        .select()
        .single()

      if (companyErr) {
        logger.error({ companyErr }, 'Error creando empresa desde onboarding')
      } else {
        companyId = company.id
        // Vincular empresa al onboarding
        await supabase.from('client_onboardings').update({ company_id: companyId }).eq('id', id)
      }
    }

    // 2. Crear invitación para que el representante asigne su contraseña
    const token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    await supabase.from('company_invitations').insert({
      email:      data.rep_email.toLowerCase().trim(),
      full_name:  data.rep_name,
      role:       'client_owner',
      company_id: companyId,
      token,
      status:     'pending',
      expires_at: expiresAt,
    })

    // 3. Enviar email con link para crear contraseña
    void NotificationService.enqueue({
      channel:  'email',
      template: 'kyc-approved',
      to:       data.rep_email,
      data: {
        ownerName:   data.rep_name,
        companyName: data.company_name,
        platformUrl: `${PLATFORM_URL}/invitations/accept?token=${token}`,
      },
      companyId: companyId ?? undefined,
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
      if (error.code === '23505') {
        // Devolver el registro existente en vez de error 409
        let q = supabase.from('client_onboardings').select('*')
        if (input.company_nit) q = q.eq('company_nit', input.company_nit)
        else q = q.eq('rep_email', input.rep_email)
        const { data: existing } = await q.single()
        if (existing) return existing

        const conflict = new Error('Ya existe una solicitud con esos datos.') as any
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
        file_name:         input.original_name ?? input.file_name ?? null,
        storage_path:      input.storage_path,
        file_size_bytes:   input.size_bytes ?? input.file_size_bytes ?? null,
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
