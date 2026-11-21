import { supabase }           from '../../lib/supabase.js'
import { isCompanyInactive }  from '../../lib/companyStatus.js'

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}
import type { z }             from 'zod'
import type {
  listCompaniesQuerySchema,
  updateCompanySchema,
} from './companies.schema.js'

type ListQuery   = z.infer<typeof listCompaniesQuerySchema>
type UpdateInput = z.infer<typeof updateCompanySchema>

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
        profiles!profiles_company_id_fkey(id,full_name,email,role,active)
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

  /**
   * Inactiva la empresa: sus usuarios pierden acceso (authMiddleware), se cancelan
   * sus invitaciones pendientes y sale de tareas automáticas y sincronizaciones.
   * Los perfiles NO se desactivan, para que la reactivación restaure el acceso.
   */
  static async inactivate(id: string, userId: string, reason?: string | null) {
    const { data: current, error: curErr } = await supabase
      .from('companies').select('id, status').eq('id', id).maybeSingle()
    if (curErr) throw curErr
    if (!current) throw httpError('Empresa no encontrada', 404)
    if (isCompanyInactive(current.status)) throw httpError('La empresa ya está inactiva', 409)

    const { data, error } = await supabase
      .from('companies')
      .update({
        status:              'inactive',
        inactivated_at:      new Date().toISOString(),
        inactivated_by:      userId,
        inactivation_reason: reason?.trim() || null,
      })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error

    const { count, error: invErr } = await supabase
      .from('company_invitations')
      .update({ status: 'cancelled' }, { count: 'exact' })
      .eq('company_id', id)
      .eq('status', 'pending')
    if (invErr) throw invErr

    return { ...data, cancelled_invitations: count ?? 0 }
  }

  static async reactivate(id: string) {
    const { data: current, error: curErr } = await supabase
      .from('companies').select('id, status').eq('id', id).maybeSingle()
    if (curErr) throw curErr
    if (!current) throw httpError('Empresa no encontrada', 404)
    if (!isCompanyInactive(current.status)) throw httpError('La empresa no está inactiva', 409)

    const { data, error } = await supabase
      .from('companies')
      .update({ status: 'activa', inactivated_at: null, inactivated_by: null, inactivation_reason: null })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
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
