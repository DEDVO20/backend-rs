import { supabase }           from '../../lib/supabase.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import type { z }             from 'zod'
import type {
  listCompaniesQuerySchema,
  updateCompanySchema,
} from './companies.schema.js'

type ListQuery   = z.infer<typeof listCompaniesQuerySchema>
type UpdateInput = z.infer<typeof updateCompanySchema>

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

export class CompaniesService {
  static async create(input: Record<string, unknown>) {
    const { data, error } = await supabase
      .from('companies')
      .insert(input)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async list(query: ListQuery) {
    const { status, search, page, limit } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('companies')
      .select('*', { count: 'exact' })
      .order('name')
      .range(from, from + limit - 1)

    if (status) q = q.eq('status', status)
    if (search) q = q.ilike('name', `%${search}%`)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async getById(id: string) {
    const { data, error } = await supabase
      .from('companies')
      .select(`
        *,
        company_services(*,services(*)),
        profiles(id,full_name,email,role,active)
      `)
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  }

  static async getByIdForClient(id: string) {
    const { data, error } = await supabase
      .from('companies')
      .select('id,name,nit,city,sector,phone,address,website,max_users,status')
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  }

  static async update(id: string, input: UpdateInput) {
    const { data, error } = await supabase
      .from('companies')
      .update(input)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async getTeam(companyId: string) {
    const { data, error } = await supabase
      .from('company_team_view')
      .select('*')
      .eq('company_id', companyId)

    if (error) throw error
    return data
  }

  static async inviteUser(companyId: string, email: string, role: string, inviterId: string) {
    const { data, error } = await supabase.rpc('invite_company_user', {
      p_company_id: companyId,
      p_email:      email,
      p_role:       role,
    })
    if (error) throw error

    // Leer nombre de la empresa para personalizar el email
    const { data: company } = await supabase
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .single()

    void NotificationService.enqueue({
      channel:  'email',
      template: 'invitation',
      to:       email,
      data: {
        name:        null,
        companyName: company?.name ?? '',
        inviteUrl:   `${PLATFORM_URL}/invitations/accept?token=${(data as { token?: string })?.token ?? ''}`,
      },
      companyId,
    })

    return data
  }

  static async deactivateMember(companyId: string, userId: string) {
    const { data, error } = await supabase
      .from('profiles')
      .update({ active: false })
      .eq('id', userId)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async getServices(companyId: string) {
    const { data, error } = await supabase
      .from('company_services')
      .select('*,services(*)')
      .eq('company_id', companyId)
      .eq('active', true)

    if (error) throw error
    return data
  }
}
