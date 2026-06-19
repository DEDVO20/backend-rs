import { supabase }           from '../../lib/supabase.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import type { z }             from 'zod'
import type {
  createRequestSchema,
  updateRequestSchema,
  listRequestsQuerySchema,
} from './requests.schema.js'

type CreateInput = z.infer<typeof createRequestSchema>
type UpdateInput = z.infer<typeof updateRequestSchema>
type ListQuery   = z.infer<typeof listRequestsQuerySchema>

const now = () => new Date()

export class RequestsService {
  static async list(query: ListQuery, userCompanyId: string | null, isInternal: boolean) {
    const {
      company_id, status, priority, request_type_id,
      period_year, period_month, page, limit,
    } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('operational_requests')
      .select(`
        *,
        operational_request_types(code,name),
        services(name),
        created_by:profiles!fk_operational_requests_created_by(full_name,email),
        assigned_to:profiles!fk_operational_requests_assigned_to(full_name,email)
      `, { count: 'exact' })
      .order('requested_at', { ascending: false })
      .range(from, from + limit - 1)

    if (!isInternal) {
      if (!userCompanyId) return { data: [], total: 0, page, limit }
      q = q.eq('company_id', userCompanyId)
    } else if (company_id) {
      q = q.eq('company_id', company_id)
    }

    if (status)          q = q.eq('status', status)
    if (priority)        q = q.eq('priority', priority)
    if (request_type_id) q = q.eq('request_type_id', request_type_id)
    if (period_year)     q = q.eq('period_year', period_year)
    if (period_month)    q = q.eq('period_month', period_month)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async getById(id: string) {
    const { data, error } = await supabase
      .from('operational_requests')
      .select(`
        *,
        operational_request_types(*),
        services(name),
        created_by:profiles!fk_operational_requests_created_by(full_name,email),
        assigned_to:profiles!fk_operational_requests_assigned_to(full_name,email)
      `)
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  }

  static async create(input: CreateInput, userId: string, companyId: string) {
    const n = now()
    const { data, error } = await supabase
      .from('operational_requests')
      .insert({
        ...input,
        company_id:         companyId,
        created_by_user_id: userId,
        period_year:        n.getFullYear(),
        period_month:       n.getMonth() + 1,
      })
      .select(`
        *,
        operational_request_types(name),
        created_by:profiles!fk_operational_requests_created_by(email)
      `)
      .single()

    if (error) throw error

    const creatorEmail = (data as any).created_by?.email
    const typeName     = (data as any).operational_request_types?.name ?? 'Solicitud'

    if (creatorEmail) {
      void NotificationService.enqueue({
        channel:  'email',
        template: 'request-received',
        to:       creatorEmail,
        data: {
          requestTitle: typeName,
          slaHours:     48,
          ticketId:     data.id.slice(0, 8).toUpperCase(),
        },
        companyId,
      })
    }

    return data
  }

  static async update(id: string, input: UpdateInput) {
    const extra: Record<string, unknown> = {}
    if (input.status === 'resolved') extra.completed_at = new Date().toISOString()
    if (input.status === 'closed')   extra.closed_at    = new Date().toISOString()

    const { data, error } = await supabase
      .from('operational_requests')
      .update({ ...input, ...extra })
      .eq('id', id)
      .select(`
        *,
        operational_request_types(name),
        created_by:profiles!fk_operational_requests_created_by(email)
      `)
      .single()

    if (error) throw error

    if (input.status === 'resolved' || input.status === 'closed') {
      const creatorEmail = (data as any).created_by?.email
      const typeName     = (data as any).operational_request_types?.name ?? 'Solicitud'

      if (creatorEmail) {
        void NotificationService.enqueue({
          channel:  'email',
          template: 'request-resolved',
          to:       creatorEmail,
          data: {
            requestTitle: typeName,
            ticketId:     data.id.slice(0, 8).toUpperCase(),
            notes:        null,
          },
          companyId: data.company_id,
        })
      }
    }

    return data
  }

  static async listTypes() {
    const { data, error } = await supabase
      .from('operational_request_types')
      .select('*,services(name)')
      .eq('active', true)
      .order('name')

    if (error) throw error
    return data
  }
}
