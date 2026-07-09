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
      .select('*,services!tasks_service_id_fkey(name),companies(name)', { count: 'exact' })
      .order('due_date', { ascending: true })
      .range(from, from + limit - 1)

    if (!isInternal) {
      if (!userCompanyId) return { data: [], total: 0, page, limit }
      q = q.eq('company_id', userCompanyId).eq('owner_type', 'client')
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
      .select('*,services!tasks_service_id_fkey(name),documents(*)')
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

  // Cierre manual por un admin: marca la tarea como completada saltando el
  // flujo normal (owner_type / documento requerido), dejando trazabilidad.
  static async closeManually(id: string, userId: string, reason: string) {
    const task = await TasksService.getById(id)
    if (task.status === 'done') {
      throw Object.assign(new Error('La tarea ya está completada'), { statusCode: 409 })
    }

    const { data, error } = await supabase
      .from('tasks')
      .update({
        status:          'done',
        closed_manually: true,
        closed_by:       userId,
        closure_reason:  reason,
        closed_at:       new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async generateTasks(params: {
    year:   number
    month?: number
    day?:   number
  }): Promise<{ generated: Record<string, number> }> {
    const now   = new Date()
    const year  = params.year
    const month = params.month ?? (now.getMonth() + 1)
    const day   = params.day   ?? now.getDate()

    const MES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']
    const pad = (n: number) => String(n).padStart(2, '0')
    const lastDayOf = (y: number, m: number) => new Date(y, m, 0).getDate()

    // Dos queries separados porque no hay FK directa entre task_templates y company_services
    const [{ data: templates, error: errT }, { data: activeServices, error: errCS }] = await Promise.all([
      supabase
        .from('task_templates')
        .select('id, title, frequency, due_day, create_day, owner_type, service_id, requires_document, provider_service_id')
        .eq('active', true),
      supabase
        .from('company_services')
        .select('company_id, service_id')
        .eq('active', true),
    ])

    if (errT)  throw new Error(`Error cargando plantillas: ${errT.message}`)
    if (errCS) throw new Error(`Error cargando servicios de empresa: ${errCS.message}`)

    // Agrupar company_services por service_id para lookup eficiente
    const serviceToCompanies = new Map<string, string[]>()
    // Y el inverso: servicios activos por empresa, para resolver dependencias
    const companyActiveServices = new Map<string, Set<string>>()
    for (const cs of activeServices ?? []) {
      const list = serviceToCompanies.get(cs.service_id) ?? []
      list.push(cs.company_id)
      serviceToCompanies.set(cs.service_id, list)

      const set = companyActiveServices.get(cs.company_id) ?? new Set<string>()
      set.add(cs.service_id)
      companyActiveServices.set(cs.company_id, set)
    }

    type Row = {
      template_id:         string
      title:               string
      frequency:           string
      due_day:             number | null
      create_day:          number | null
      owner_type:          string
      service_id:          string
      requires_document:   boolean
      company_id:          string
      provider_service_id: string | null
    }

    // Producto cartesiano: cada plantilla × empresas que tienen ese servicio activo.
    // Dependencias entre servicios: si la tarea es del cliente pero otro servicio
    // contratado por la misma empresa puede producir el documento (provider_service_id),
    // la tarea se asigna al equipo interno de ese servicio en vez del cliente.
    const rows: Row[] = (templates ?? []).flatMap(t => {
      const companies = serviceToCompanies.get(t.service_id) ?? []
      return companies.map(company_id => {
        const providerHired = !!t.provider_service_id
          && (companyActiveServices.get(company_id)?.has(t.provider_service_id) ?? false)
        const redirected = t.owner_type === 'client' && providerHired
        return {
          template_id:         t.id,
          title:               t.title,
          frequency:           t.frequency,
          due_day:             t.due_day,
          create_day:          t.create_day,
          owner_type:          redirected ? 'rs_team' : t.owner_type,
          service_id:          t.service_id,
          requires_document:   t.requires_document,
          company_id,
          provider_service_id: redirected ? t.provider_service_id : null,
        }
      })
    })

    type TaskInsert = {
      company_id:          string
      title:               string
      status:              string
      due_date:            string
      owner_type:          string
      unique_key:          string
      service_id:          string
      requires_document:   boolean
      create_day?:         number
      provider_service_id: string | null
    }

    const buckets: Record<string, TaskInsert[]> = {
      annual: [], monthly: [], weekly: [], semestral: [], trimestral: [],
    }

    // ── Anuales (solo el 1 de enero) ─────────────────────────────────────────
    if (month === 1 && day === 1) {
      for (const r of rows.filter(r => r.frequency === 'annual')) {
        const dueDate = new Date(year + 1, 0, r.due_day ?? 1)
        buckets.annual.push({
          company_id:        r.company_id,
          title:             `${r.title} — ${year}`,
          status:            'pending',
          due_date:          dueDate.toISOString().split('T')[0],
          owner_type:        r.owner_type,
          unique_key:        `${r.company_id}_${r.template_id}_annual_${year}`,
          service_id:        r.service_id,
          requires_document: r.requires_document,
          provider_service_id: r.provider_service_id,
        })
      }
    }

    // ── Mensuales (solo las que tienen create_day === hoy) ────────────────────
    for (const r of rows.filter(r => r.frequency === 'monthly')) {
      const lastDay   = lastDayOf(year, month)
      const createDay = Math.min(r.create_day ?? 1, r.due_day ?? 1)
      if (createDay !== day) continue
      const dueDay  = Math.min(r.due_day ?? lastDay, lastDay)
      const dueDate = new Date(year, month - 1, dueDay)
      buckets.monthly.push({
        company_id:        r.company_id,
        title:             `${r.title} — ${MES[month - 1]} ${year}`,
        status:            'pending',
        due_date:          dueDate.toISOString().split('T')[0],
        owner_type:        r.owner_type,
        unique_key:        `${r.company_id}_${r.template_id}_${year}_${pad(month)}`,
        create_day:        createDay,
        service_id:        r.service_id,
        requires_document: r.requires_document,
        provider_service_id: r.provider_service_id,
      })
    }

    // ── Semanales (solo días 7, 15, 21, 28) ──────────────────────────────────
    if ([7, 15, 21, 28].includes(day)) {
      const dueDate = new Date(year, month - 1, day)
      for (const r of rows.filter(r => r.frequency === 'weekly')) {
        buckets.weekly.push({
          company_id:        r.company_id,
          title:             `${r.title} — ${pad(day)} ${MES[month - 1]} ${year}`,
          status:            'pending',
          due_date:          dueDate.toISOString().split('T')[0],
          owner_type:        r.owner_type,
          unique_key:        `${r.company_id}_${r.template_id}_${year}_${pad(month)}_${pad(day)}`,
          create_day:        day - 2,
          service_id:        r.service_id,
          requires_document: r.requires_document,
          provider_service_id: r.provider_service_id,
        })
      }
    }

    // ── Semestrales (meses 6 y 12, según create_day) ──────────────────────────
    if ([6, 12].includes(month)) {
      for (const r of rows.filter(r => r.frequency === 'annual' && r.title === 'Cálculo primas y verificación pago')) {
        const lastDay   = lastDayOf(year, month)
        const createDay = Math.min(r.create_day ?? 1, r.due_day ?? 1)
        if (createDay !== day) continue
        const dueDay  = Math.min(r.due_day ?? lastDay, lastDay)
        const dueDate = new Date(year, month - 1, dueDay)
        buckets.semestral.push({
          company_id:        r.company_id,
          title:             `${r.title} — ${MES[month - 1]} ${year}`,
          status:            'pending',
          due_date:          dueDate.toISOString().split('T')[0],
          owner_type:        r.owner_type,
          unique_key:        `${r.company_id}_${r.template_id}_${year}_${pad(month)}`,
          create_day:        createDay,
          service_id:        r.service_id,
          requires_document: r.requires_document,
          provider_service_id: r.provider_service_id,
        })
      }
    }

    // ── Trimestrales (meses 4, 8, 12, según create_day) ───────────────────────
    if ([4, 8, 12].includes(month)) {
      for (const r of rows.filter(r => r.frequency === 'annual' && r.title === 'Cotización dotaciones y verificación pago')) {
        const lastDay   = lastDayOf(year, month)
        const createDay = Math.min(r.create_day ?? 1, r.due_day ?? 1)
        if (createDay !== day) continue
        const dueDay  = Math.min(r.due_day ?? lastDay, lastDay)
        const dueDate = new Date(year, month - 1, dueDay)
        buckets.trimestral.push({
          company_id:        r.company_id,
          title:             `${r.title} — ${MES[month - 1]} ${year}`,
          status:            'pending',
          due_date:          dueDate.toISOString().split('T')[0],
          owner_type:        r.owner_type,
          unique_key:        `${r.company_id}_${r.template_id}_${year}_${pad(month)}`,
          create_day:        createDay,
          service_id:        r.service_id,
          requires_document: r.requires_document,
          provider_service_id: r.provider_service_id,
        })
      }
    }

    // ── Insertar ignorando duplicados por unique_key ───────────────────────────
    const results: Record<string, number> = {}

    await Promise.all(
      Object.entries(buckets).map(async ([name, tasks]) => {
        if (!tasks.length) { results[name] = 0; return }
        const { error: insertError } = await supabase
          .from('tasks')
          .upsert(tasks, { onConflict: 'unique_key', ignoreDuplicates: true })
        if (insertError) throw new Error(`Error generando tareas ${name}: ${insertError.message}`)
        results[name] = tasks.length
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
