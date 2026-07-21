import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import type { z }   from 'zod'
import type { masterItemSchema, updateMasterItemSchema, updateEntrySchema } from './accounting.schema.js'

type MasterInput       = z.infer<typeof masterItemSchema>
type MasterUpdateInput = z.infer<typeof updateMasterItemSchema>
type EntryUpdateInput  = z.infer<typeof updateEntrySchema>

// Anticipación por defecto si la tarea de la maestra no define notice_days
const DEFAULT_NOTICE_DAYS = 5

// Máximo horizonte que revisa el cron (cubre notice_days de hasta ~4 meses)
const MAX_NOTICE_DAYS = 120

// Hitos de recordatorio: se notifica al contador cuando faltan estos días
const REMINDER_MILESTONES = [30, 15, 7, 3, 1, 0]

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

const toDateStr = (d: Date) => d.toISOString().split('T')[0]!

// Días completos entre hoy y una fecha (yyyy-mm-dd), en zona local del server
function daysUntil(dueDate: string, today: Date): number {
  const due = new Date(dueDate + 'T00:00:00')
  const t   = new Date(today); t.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - t.getTime()) / 86_400_000)
}

export class AccountingService {

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Correos de los contadores activos; fallback al equipo si no hay ninguno */
  static async contadorRecipients(): Promise<string[]> {
    const { data } = await supabase
      .from('profiles')
      .select('email')
      .eq('role', 'contador')
      .eq('active', true)

    const emails = (data ?? []).map((p: any) => p.email).filter(Boolean)
    if (emails.length) return emails

    // Sin contadores registrados → notificar al equipo interno
    const fallback = process.env.RS_TEAM_EMAIL
    return fallback ? [fallback] : []
  }

  /** IDs de los servicios que representan el módulo contable */
  static async accountingServiceIds(): Promise<string[]> {
    const { data, error } = await supabase
      .from('services')
      .select('id')
      .ilike('name', '%contab%')
    if (error) throw error
    return (data ?? []).map(s => s.id)
  }

  /** Empresas con el servicio contable activo */
  static async companiesWithAccounting(): Promise<{ id: string; name: string }[]> {
    const serviceIds = await AccountingService.accountingServiceIds()
    if (!serviceIds.length) return []

    const { data, error } = await supabase
      .from('company_services')
      .select('company_id, companies(id, name)')
      .in('service_id', serviceIds)
      .eq('active', true)
    if (error) throw error

    // Deduplicar (una empresa puede tener más de un servicio contable)
    const map = new Map<string, { id: string; name: string }>()
    for (const row of data ?? []) {
      const co = (row as any).companies
      if (co && !map.has(co.id)) map.set(co.id, { id: co.id, name: co.name ?? '—' })
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // ── Plantilla maestra ──────────────────────────────────────────────────────

  static async listMaster() {
    const { data, error } = await supabase
      .from('tax_calendar_master')
      .select('*')
      .order('sort_order')
      .order('title')
    if (error) throw error
    return data
  }

  /** Crea una tarea en la maestra y la propaga a todas las fichas existentes (2.d) */
  static async createMaster(input: MasterInput) {
    const { data, error } = await supabase
      .from('tax_calendar_master')
      .insert(input)
      .select()
      .single()
    if (error) throw error

    const companies = await AccountingService.companiesWithAccounting()
    if (companies.length) {
      const rows = companies.map(c => ({
        company_id:   c.id,
        master_id:    data.id,
        is_mandatory: data.is_mandatory,
      }))
      const { error: propErr } = await supabase
        .from('company_tax_entries')
        .upsert(rows, { onConflict: 'company_id,master_id', ignoreDuplicates: true })
      if (propErr) throw propErr
    }

    return { ...data, propagated_to: companies.length }
  }

  /** Actualiza la maestra; si cambia obligatoria/opcional propaga el flag a las fichas */
  static async updateMaster(id: string, input: MasterUpdateInput) {
    const { data, error } = await supabase
      .from('tax_calendar_master')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error

    if (input.is_mandatory !== undefined) {
      const { error: propErr } = await supabase
        .from('company_tax_entries')
        .update({ is_mandatory: input.is_mandatory })
        .eq('master_id', id)
      if (propErr) throw propErr
    }

    return data
  }

  /** Elimina de la maestra; el FK on delete cascade borra las entradas de todas las fichas */
  static async deleteMaster(id: string) {
    const { count } = await supabase
      .from('company_tax_entries')
      .select('id', { count: 'exact', head: true })
      .eq('master_id', id)

    const { error } = await supabase
      .from('tax_calendar_master')
      .delete()
      .eq('id', id)
    if (error) throw error

    return { deleted_entries: count ?? 0 }
  }

  // ── Fichas por empresa ─────────────────────────────────────────────────────

  /** Crea (si faltan) las entradas de la ficha copiando la plantilla maestra (punto 3) */
  static async ensureFicha(companyId: string) {
    const master = await AccountingService.listMaster()
    if (!master?.length) return { created: 0 }

    const rows = master.map((m: any) => ({
      company_id:   companyId,
      master_id:    m.id,
      is_mandatory: m.is_mandatory,
    }))

    const { error } = await supabase
      .from('company_tax_entries')
      .upsert(rows, { onConflict: 'company_id,master_id', ignoreDuplicates: true })
    if (error) throw error

    return { created: rows.length }
  }

  /** Genera fichas para todas las empresas con servicio contable activo */
  static async backfill() {
    const companies = await AccountingService.companiesWithAccounting()
    for (const c of companies) {
      await AccountingService.ensureFicha(c.id)
    }
    return { companies: companies.length }
  }

  /** Empresas con servicio contable + resumen del estado de su calendario (análisis) */
  static async getCompanies() {
    const companies = await AccountingService.companiesWithAccounting()
    if (!companies.length) return []

    const { data: entries, error } = await supabase
      .from('company_tax_entries')
      .select('company_id, is_mandatory, due_date')
      .in('company_id', companies.map(c => c.id))
    if (error) throw error

    return companies.map(c => {
      const rows = (entries ?? []).filter(e => e.company_id === c.id)
      const mandatory = rows.filter(e => e.is_mandatory)
      const optional  = rows.filter(e => !e.is_mandatory)
      const mandatoryWithDate = mandatory.filter(e => e.due_date).length
      const optionalWithDate  = optional.filter(e => e.due_date).length
      return {
        ...c,
        total_entries:          rows.length,
        mandatory_total:        mandatory.length,
        mandatory_with_date:    mandatoryWithDate,
        mandatory_without_date: mandatory.length - mandatoryWithDate,
        optional_total:         optional.length,
        optional_with_date:     optionalWithDate,
        optional_without_date:  optional.length - optionalWithDate,
        has_ficha:              rows.length > 0,
        // Completo = todas las obligatorias tienen fecha (punto 3)
        complete:               rows.length > 0 && mandatory.length > 0 && mandatoryWithDate === mandatory.length,
      }
    })
  }

  /** Calendario de una empresa (crea la ficha si no existe) */
  static async getCompanyCalendar(companyId: string) {
    await AccountingService.ensureFicha(companyId)

    const { data, error } = await supabase
      .from('company_tax_entries')
      .select('*, master:tax_calendar_master(title, description, sort_order)')
      .eq('company_id', companyId)
    if (error) throw error

    return (data ?? []).sort((a: any, b: any) =>
      (a.master?.sort_order ?? 0) - (b.master?.sort_order ?? 0) ||
      String(a.master?.title ?? '').localeCompare(String(b.master?.title ?? '')))
  }

  /** Modifica la fecha/notas de una entrada individual del calendario */
  static async updateEntry(id: string, input: EntryUpdateInput, userId: string) {
    const { data, error } = await supabase
      .from('company_tax_entries')
      .update({ ...input, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, master:tax_calendar_master(title)')
      .single()
    if (error) throw error
    return data
  }

  // ── Estadísticas del dashboard ─────────────────────────────────────────────

  static async stats() {
    const today = new Date()
    const todayStr = toDateStr(today)
    const in7  = toDateStr(new Date(today.getTime() + 7  * 86_400_000))
    const in15 = toDateStr(new Date(today.getTime() + 15 * 86_400_000))

    const [companies, { data: taxTasks, error: tasksErr }] = await Promise.all([
      AccountingService.getCompanies(),
      supabase
        .from('tasks')
        .select('id, status, due_date')
        .like('unique_key', 'taxcal_%'),
    ])
    if (tasksErr) throw tasksErr

    const tasks = taxTasks ?? []
    const open  = tasks.filter(t => t.status !== 'done')

    const incomplete = companies.filter(c => !c.complete)

    return {
      tasks: {
        total:      tasks.length,
        done:       tasks.filter(t => t.status === 'done').length,
        overdue:    open.filter(t => t.due_date && t.due_date < todayStr).length,
        due_7_days:  open.filter(t => t.due_date && t.due_date >= todayStr && t.due_date <= in7).length,
        due_15_days: open.filter(t => t.due_date && t.due_date >= todayStr && t.due_date <= in15).length,
        pending:    open.length,
      },
      companies: {
        total:      companies.length,
        complete:   companies.length - incomplete.length,
        incomplete: incomplete.length,
        // Alerta del dashboard: empresas sin calendario tributario completo
        incomplete_list: incomplete.map(c => ({
          id: c.id, name: c.name, mandatory_without_date: c.mandatory_without_date,
        })),
      },
    }
  }

  // ── Cron: crear tareas según la anticipación de cada obligación (punto 4) ──

  static async generateTaxTasks() {
    const today = new Date()
    const todayStr = toDateStr(today)
    // Horizonte máximo; luego se filtra por notice_days de cada tarea
    const limitStr = toDateStr(new Date(today.getTime() + MAX_NOTICE_DAYS * 86_400_000))

    const { data: entries, error } = await supabase
      .from('company_tax_entries')
      .select('id, company_id, due_date, master:tax_calendar_master(title, notice_days), companies(name)')
      .not('due_date', 'is', null)
      .gte('due_date', todayStr)
      .lte('due_date', limitStr)
    if (error) throw error

    if (!entries?.length) return { created: 0 }

    // Solo las que ya entraron en su ventana de anticipación
    const inWindow = (entries as any[]).filter(e => {
      const notice = e.master?.notice_days ?? DEFAULT_NOTICE_DAYS
      return daysUntil(e.due_date, today) <= notice
    })
    if (!inWindow.length) return { created: 0 }

    const serviceIds = await AccountingService.accountingServiceIds()
    const serviceId  = serviceIds[0] ?? null

    const rows = inWindow.map((e: any) => ({
      company_id:        e.company_id,
      title:             `${e.master?.title ?? 'Obligación tributaria'} — vence ${e.due_date}`,
      status:            'pending',
      due_date:          e.due_date,
      owner_type:        'rs_team',
      unique_key:        `taxcal_${e.id}_${String(e.due_date).slice(0, 4)}`,
      service_id:        serviceId,
      requires_document: false,
    }))

    // upsert con ignoreDuplicates → solo inserta las que aún no existían.
    // select() devuelve las filas realmente insertadas para poder notificar.
    const { data: inserted, error: insertErr } = await supabase
      .from('tasks')
      .upsert(rows, { onConflict: 'unique_key', ignoreDuplicates: true })
      .select('id, title, company_id, due_date, companies(name)')
    if (insertErr) throw insertErr

    const created = inserted ?? []

    // Notificar al contador las tareas recién creadas (anticipación de la obligación)
    if (created.length) {
      const recipients = await AccountingService.contadorRecipients()
      if (recipients.length) {
        const items = created
          .map((t: any) => `• ${t.title}  (${t.companies?.name ?? ''})`)
          .join('\n')
        for (const to of recipients) {
          void NotificationService.enqueue({
            channel:  'email',
            template: 'tax-calendar-digest',
            to,
            data: {
              subject: `${created.length} nueva(s) tarea(s) del calendario tributario`,
              title:   'Nuevas obligaciones tributarias',
              intro:   `Se crearon ${created.length} tarea(s) próximas a vencer según su anticipación configurada:`,
              items,
              url:     `${PLATFORM_URL}/app/accounting`,
            },
          })
        }
      }
    }

    logger.info({ created: created.length }, 'Cron: tareas de calendario tributario generadas')
    return { created: created.length }
  }

  // ── Cron: recordatorios al contador por hitos de vencimiento ───────────────

  static async sendTaxReminders() {
    const today = new Date()
    const todayStr = toDateStr(today)
    const limitStr = toDateStr(new Date(today.getTime() + MAX_NOTICE_DAYS * 86_400_000))

    const { data: entries, error } = await supabase
      .from('company_tax_entries')
      .select('id, due_date, master:tax_calendar_master(title, notice_days), companies(name)')
      .not('due_date', 'is', null)
      .gte('due_date', todayStr)
      .lte('due_date', limitStr)
    if (error) throw error

    if (!entries?.length) return { reminded: 0 }

    // Incluir las que hoy caen en un hito de recordatorio dentro de su ventana
    const due: { title: string; company: string; days: number; date: string }[] = []
    for (const e of entries as any[]) {
      const notice = e.master?.notice_days ?? DEFAULT_NOTICE_DAYS
      const d = daysUntil(e.due_date, today)
      if (d <= notice && REMINDER_MILESTONES.includes(d)) {
        due.push({
          title:   e.master?.title ?? 'Obligación tributaria',
          company: e.companies?.name ?? '',
          days:    d,
          date:    e.due_date,
        })
      }
    }

    if (!due.length) return { reminded: 0 }

    const recipients = await AccountingService.contadorRecipients()
    if (!recipients.length) return { reminded: 0 }

    due.sort((a, b) => a.days - b.days)
    const items = due
      .map(x => {
        const when = x.days === 0 ? 'vence hoy' : x.days === 1 ? 'vence mañana' : `faltan ${x.days} días`
        return `• ${x.title} (${x.company}) — ${when} · ${x.date}`
      })
      .join('\n')

    for (const to of recipients) {
      void NotificationService.enqueue({
        channel:  'email',
        template: 'tax-calendar-digest',
        to,
        data: {
          subject: `Recordatorio: ${due.length} obligación(es) tributaria(s) próxima(s)`,
          title:   'Recordatorio de calendario tributario',
          intro:   'Estas obligaciones tributarias están próximas a vencer:',
          items,
          url:     `${PLATFORM_URL}/app/accounting`,
        },
      })
    }

    logger.info({ reminders: due.length, recipients: recipients.length }, 'Cron: recordatorios de calendario tributario enviados')
    return { reminded: due.length }
  }
}
