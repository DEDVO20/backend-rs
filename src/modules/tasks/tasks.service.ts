import { supabase }           from '../../lib/supabase.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import type { z }             from 'zod'
import type {
  listTasksQuerySchema,
  updateTaskSchema,
  createTaskSchema,
} from './tasks.schema.js'

type ListQuery   = z.infer<typeof listTasksQuerySchema>
type UpdateInput = z.infer<typeof updateTaskSchema>
type CreateInput = z.infer<typeof createTaskSchema>

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

export class TasksService {
  static async list(query: ListQuery, userCompanyId: string | null, isInternal: boolean) {
    const { company_id, status, owner_type, service_id, page, limit } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('tasks')
      .select('*,services(name)', { count: 'exact' })
      .order('due_date', { ascending: true })
      .range(from, from + limit - 1)

    if (!isInternal) {
      if (!userCompanyId) return { data: [], total: 0, page, limit }
      q = q.eq('company_id', userCompanyId)
    } else if (company_id) {
      q = q.eq('company_id', company_id)
    }

    if (status)     q = q.eq('status', status)
    if (owner_type) q = q.eq('owner_type', owner_type)
    if (service_id) q = q.eq('service_id', service_id)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async getById(id: string) {
    const { data, error } = await supabase
      .from('tasks')
      .select('*,services(name),documents(*)')
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  }

  static async create(input: CreateInput) {
    const { data, error } = await supabase
      .from('tasks')
      .insert(input)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async update(id: string, input: UpdateInput) {
    const task = await TasksService.getById(id)

    const { data, error } = await supabase
      .from('tasks')
      .update(input)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    // Notificar al owner cuando una tarea vence
    if (input.status === 'overdue' && task.company_id) {
      const { data: owner } = await supabase
        .from('profiles')
        .select('email')
        .eq('company_id', task.company_id)
        .eq('role', 'client_owner')
        .eq('active', true)
        .single()

      if (owner?.email) {
        void NotificationService.enqueue({
          channel:  'email',
          template: 'task-overdue',
          to:       owner.email,
          data: {
            taskTitle:   task.title,
            companyName: '',
          },
          companyId: task.company_id,
        })
      }
    }

    return data
  }

  static async generateTasks(params: {
    year:   number
    month?: number
    day?:   number
  }): Promise<{ generated: Record<string, number> }> {
    const { year, month, day } = params
    const results: Record<string, number> = {}

    const rpcs: Array<{
      name:   string
      fn:     string
      args:   Record<string, number>
    }> = [
      { name: 'annual',     fn: 'generate_annual_tasks',     args: { p_year: year } },
      { name: 'monthly',    fn: 'generate_monthly_tasks',    args: { p_year: year, p_month: month ?? new Date().getMonth() + 1 } },
      { name: 'weekly',     fn: 'generate_weekly_tasks',     args: { p_year: year, p_month: month ?? new Date().getMonth() + 1, p_day: day ?? new Date().getDate() } },
      { name: 'semestral',  fn: 'generate_semestral_tasks',  args: { p_year: year, p_month: month ?? new Date().getMonth() + 1 } },
      { name: 'trimestral', fn: 'generate_trimestral_tasks', args: { p_year: year, p_month: month ?? new Date().getMonth() + 1 } },
    ]

    await Promise.all(
      rpcs.map(async ({ name, fn, args }) => {
        const { data, error } = await supabase.rpc(fn as any, args)
        if (error) throw Object.assign(new Error(`RPC ${fn} falló: ${error.message}`), { fn })
        results[name] = typeof data === 'number' ? data : (data as any)?.count ?? 0
      }),
    )

    return { generated: results }
  }

  static async sendReminders(): Promise<number> {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = tomorrow.toISOString().split('T')[0]

    const { data: tasks } = await supabase
      .from('tasks')
      .select('id,title,due_date,company_id,companies(name,profiles(role,email))')
      .eq('status', 'pending')
      .eq('due_date', dateStr)

    if (!tasks?.length) return 0

    for (const task of tasks) {
      const company = (task as any).companies
      if (!company) continue

      const profiles: Array<{ role: string; email: string }> =
        Array.isArray(company.profiles) ? company.profiles : [company.profiles]

      const owner = profiles.find(p => p?.role === 'client_owner')
      if (!owner?.email) continue

      void NotificationService.enqueue({
        channel:  'email',
        template: 'task-reminder',
        to:       owner.email,
        data: {
          taskTitle:   task.title,
          dueDate:     task.due_date,
          companyName: company.name ?? '',
          taskUrl:     `${PLATFORM_URL}/tasks/${task.id}`,
        },
        companyId: task.company_id ?? undefined,
      })
    }

    return tasks.length
  }

  static async markOverdue(): Promise<number> {
    const today = new Date().toISOString().split('T')[0]!
    const { data, error } = await supabase
      .from('tasks')
      .update({ status: 'overdue' })
      .eq('status', 'pending')
      .lt('due_date', today)
      .select('id')
    if (error) throw error
    return data?.length ?? 0
  }
}
