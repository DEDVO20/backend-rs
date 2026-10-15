import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import type { z }   from 'zod'
import type {
  masterItemSchema, updateMasterItemSchema, updateEntrySchema,
  updateDeadlineSchema, createDeadlineSchema,
} from './accounting.schema.js'
import {
  periodsFor, periodCount, isPeriodicity, CUSTOM_INDEX_START, type Periodicity,
} from './accounting.domain.js'

type MasterInput         = z.infer<typeof masterItemSchema>
type MasterUpdateInput   = z.infer<typeof updateMasterItemSchema>
type EntryUpdateInput    = z.infer<typeof updateEntrySchema>
type DeadlineUpdateInput = z.infer<typeof updateDeadlineSchema>
type DeadlineCreateInput = z.infer<typeof createDeadlineSchema>

// Anticipación por defecto si la tarea de la maestra no define notice_days
const DEFAULT_NOTICE_DAYS = 5

// Máximo horizonte que revisa el cron (cubre notice_days de hasta ~4 meses)
const MAX_NOTICE_DAYS = 120

// Hitos de recordatorio: se notifica al contador cuando faltan estos días
const REMINDER_MILESTONES = [30, 15, 7, 3, 1, 0]

// Ventana de "próximos vencimientos" del dashboard
const UPCOMING_DAYS = 30

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

const toDateStr = (d: Date) => d.toISOString().split('T')[0]!

// Días completos entre hoy y una fecha (yyyy-mm-dd), en zona local del server
function daysUntil(dueDate: string, today: Date): number {
  const due = new Date(dueDate + 'T00:00:00')
  const t   = new Date(today); t.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - t.getTime()) / 86_400_000)
}

// Periodicidad efectiva: override de la empresa o la de la maestra
function effectivePeriodicity(entry: any): Periodicity {
  if (isPeriodicity(entry.periodicity)) return entry.periodicity
  if (isPeriodicity(entry.master?.periodicity)) return entry.master.periodicity
  return 'anual'
}

// Error 400 para el handler global (lee statusCode)
function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

const taskKey = (deadlineId: string) => `taxcal_d_${deadlineId}`

const taskTitle = (title: string, periodLabel: string, dueDate: string) =>
  `${title} — ${periodLabel} — vence ${dueDate}`

// PostgREST corta en 1000 filas: trae todas las páginas de una consulta
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
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

  /**
   * Borra los vencimientos generados (no los adicionales) desde el año actual
   * de las obligaciones indicadas, para regenerarlos con la nueva periodicidad.
   */
  static async resetGeneratedDeadlines(entryIds: string[]) {
    if (!entryIds.length) return
    const { error } = await supabase
      .from('company_tax_deadlines')
      .delete()
      .in('entry_id', entryIds)
      .eq('is_custom', false)
      .gte('year', new Date().getFullYear())
    if (error) throw error
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

  /** Actualiza la maestra; propaga obligatoria/opcional y la periodicidad a las fichas */
  static async updateMaster(id: string, input: MasterUpdateInput) {
    const { data: before } = await supabase
      .from('tax_calendar_master')
      .select('periodicity')
      .eq('id', id)
      .maybeSingle()

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

    // Nueva periodicidad → regenerar los períodos de las fichas que no la sobrescriben
    if (input.periodicity && before && before.periodicity !== input.periodicity) {
      const { data: entries, error: entErr } = await supabase
        .from('company_tax_entries')
        .select('id')
        .eq('master_id', id)
        .is('periodicity', null)
      if (entErr) throw entErr
      await AccountingService.resetGeneratedDeadlines((entries ?? []).map(e => e.id))
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

  /** Crea (si faltan) los vencimientos de cada período del año para una empresa */
  static async ensureDeadlines(companyId: string, year: number) {
    const { data: entries, error } = await supabase
      .from('company_tax_entries')
      .select('id, periodicity, master:tax_calendar_master(periodicity)')
      .eq('company_id', companyId)
    if (error) throw error

    const rows = (entries ?? []).flatMap((e: any) =>
      periodsFor(effectivePeriodicity(e), year).map(p => ({
        entry_id:     e.id,
        company_id:   companyId,
        year,
        period_index: p.index,
        period_label: p.label,
        is_custom:    false,
      })))
    if (!rows.length) return

    const { error: upErr } = await supabase
      .from('company_tax_deadlines')
      .upsert(rows, { onConflict: 'entry_id,year,period_index', ignoreDuplicates: true })
    if (upErr) throw upErr
  }

  /** Genera fichas para todas las empresas con servicio contable activo */
  static async backfill() {
    const companies = await AccountingService.companiesWithAccounting()
    const year = new Date().getFullYear()
    for (const c of companies) {
      await AccountingService.ensureFicha(c.id)
      await AccountingService.ensureDeadlines(c.id, year)
    }
    return { companies: companies.length }
  }

  /**
   * Empresas con servicio contable + resumen del estado de su calendario del año.
   * Los contadores son de períodos (fechas), no de obligaciones: una retención
   * mensual aporta 12 fechas por diligenciar.
   */
  static async getCompanies(year = new Date().getFullYear()) {
    const companies = await AccountingService.companiesWithAccounting()
    if (!companies.length) return []
    const companyIds = companies.map(c => c.id)

    const [entries, deadlines] = await Promise.all([
      fetchAll<any>((from, to) => supabase
        .from('company_tax_entries')
        .select('id, company_id, is_mandatory, periodicity, master:tax_calendar_master(periodicity)')
        .in('company_id', companyIds)
        .order('id')
        .range(from, to)),
      fetchAll<any>((from, to) => supabase
        .from('company_tax_deadlines')
        .select('entry_id, period_index')
        .in('company_id', companyIds)
        .eq('year', year)
        .eq('is_custom', false)
        .not('due_date', 'is', null)
        .order('id')
        .range(from, to)),
    ])

    // Períodos con fecha por obligación (solo índices válidos para su periodicidad)
    const datedByEntry = new Map<string, Set<number>>()
    for (const d of deadlines) {
      if (!datedByEntry.has(d.entry_id)) datedByEntry.set(d.entry_id, new Set())
      datedByEntry.get(d.entry_id)!.add(d.period_index)
    }

    return companies.map(c => {
      const rows = entries.filter(e => e.company_id === c.id)
      const tally = { mandatory_total: 0, mandatory_with_date: 0, optional_total: 0, optional_with_date: 0 }
      for (const e of rows) {
        const expected = periodCount(effectivePeriodicity(e))
        const dated = [...(datedByEntry.get(e.id) ?? [])].filter(i => i <= expected).length
        if (e.is_mandatory) { tally.mandatory_total += expected; tally.mandatory_with_date += dated }
        else                { tally.optional_total  += expected; tally.optional_with_date  += dated }
      }
      const mandatoryWithout = tally.mandatory_total - tally.mandatory_with_date
      return {
        ...c,
        year,
        total_entries:          rows.length,
        ...tally,
        mandatory_without_date: mandatoryWithout,
        optional_without_date:  tally.optional_total - tally.optional_with_date,
        has_ficha:              rows.length > 0,
        // Completo = todos los períodos de las obligatorias tienen fecha (punto 3)
        complete:               rows.length > 0 && tally.mandatory_total > 0 && mandatoryWithout === 0,
      }
    })
  }

  /** Calendario de una empresa para un año (crea ficha y períodos si faltan) */
  static async getCompanyCalendar(companyId: string, year: number) {
    await AccountingService.ensureFicha(companyId)
    await AccountingService.ensureDeadlines(companyId, year)

    const [{ data: entries, error }, { data: deadlines, error: dlErr }] = await Promise.all([
      supabase
        .from('company_tax_entries')
        .select('*, master:tax_calendar_master(title, description, entity, periodicity, notice_days, sort_order)')
        .eq('company_id', companyId),
      supabase
        .from('company_tax_deadlines')
        .select('*')
        .eq('company_id', companyId)
        .eq('year', year)
        .order('period_index'),
    ])
    if (error) throw error
    if (dlErr) throw dlErr

    const sorted = (entries ?? []).sort((a: any, b: any) =>
      (a.master?.sort_order ?? 0) - (b.master?.sort_order ?? 0) ||
      String(a.master?.title ?? '').localeCompare(String(b.master?.title ?? '')))

    return {
      year,
      entries: sorted.map((e: any) => {
        const periodicity = effectivePeriodicity(e)
        const count = periodCount(periodicity)
        return {
          ...e,
          effective_periodicity: periodicity,
          // Se ocultan períodos huérfanos de una periodicidad anterior
          deadlines: (deadlines ?? []).filter((d: any) =>
            d.entry_id === e.id && (d.is_custom || d.period_index <= count)),
        }
      }),
    }
  }

  /** Cambia la periodicidad (override por empresa) o las notas de una obligación */
  static async updateEntry(id: string, input: EntryUpdateInput, userId: string) {
    const { data: before, error: beforeErr } = await supabase
      .from('company_tax_entries')
      .select('periodicity')
      .eq('id', id)
      .single()
    if (beforeErr) throw beforeErr

    const { data, error } = await supabase
      .from('company_tax_entries')
      .update({ ...input, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, master:tax_calendar_master(title)')
      .single()
    if (error) throw error

    if (input.periodicity !== undefined && input.periodicity !== before.periodicity) {
      await AccountingService.resetGeneratedDeadlines([id])
    }
    return data
  }

  // ── Vencimientos por período ───────────────────────────────────────────────

  /** Modifica la fecha/notas de un período; sincroniza la tarea ya creada por el cron */
  static async updateDeadline(id: string, input: DeadlineUpdateInput, userId: string) {
    const { data: current, error: curErr } = await supabase
      .from('company_tax_deadlines')
      .select('is_custom')
      .eq('id', id)
      .single()
    if (curErr) throw curErr

    const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date().toISOString() }
    if (input.due_date !== undefined) patch.due_date = input.due_date
    if (input.notes !== undefined)    patch.notes = input.notes
    if (input.period_label !== undefined) {
      if (!current.is_custom) throw badRequest('Solo se puede renombrar una fecha adicional')
      patch.period_label = input.period_label
    }

    const { data, error } = await supabase
      .from('company_tax_deadlines')
      .update(patch)
      .eq('id', id)
      .select('*, entry:company_tax_entries(master:tax_calendar_master(title))')
      .single()
    if (error) throw error

    // Si el cron ya creó la tarea, mantenerla alineada con la nueva fecha
    if (data.due_date) {
      const title = (data as any).entry?.master?.title ?? 'Obligación tributaria'
      await supabase
        .from('tasks')
        .update({ due_date: data.due_date, title: taskTitle(title, data.period_label, data.due_date) })
        .eq('unique_key', taskKey(id))
        .neq('status', 'done')
    }
    return data
  }

  /** Agrega una fecha adicional a una obligación (ej. "Pago 2a cuota") */
  static async createDeadline(entryId: string, input: DeadlineCreateInput, userId: string) {
    const { data: entry, error: entErr } = await supabase
      .from('company_tax_entries')
      .select('id, company_id')
      .eq('id', entryId)
      .single()
    if (entErr) throw entErr

    const { data: last } = await supabase
      .from('company_tax_deadlines')
      .select('period_index')
      .eq('entry_id', entryId)
      .eq('year', input.year)
      .gte('period_index', CUSTOM_INDEX_START)
      .order('period_index', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data, error } = await supabase
      .from('company_tax_deadlines')
      .insert({
        entry_id:     entryId,
        company_id:   entry.company_id,
        year:         input.year,
        period_index: last ? last.period_index + 1 : CUSTOM_INDEX_START,
        period_label: input.period_label,
        is_custom:    true,
        due_date:     input.due_date ?? null,
        updated_by:   userId,
      })
      .select()
      .single()
    if (error) throw error
    return data
  }

  /** Elimina una fecha adicional (los períodos generados no se pueden borrar) */
  static async deleteDeadline(id: string) {
    const { data, error } = await supabase
      .from('company_tax_deadlines')
      .select('id, is_custom, company_id, period_label')
      .eq('id', id)
      .single()
    if (error) throw error
    if (!data.is_custom) throw badRequest('Los períodos generados no se pueden eliminar; deja la fecha vacía')

    const { error: delErr } = await supabase.from('company_tax_deadlines').delete().eq('id', id)
    if (delErr) throw delErr
    return data
  }

  // ── Estadísticas del dashboard ─────────────────────────────────────────────

  static async stats() {
    const today = new Date()
    const todayStr = toDateStr(today)
    const in7  = toDateStr(new Date(today.getTime() + 7  * 86_400_000))
    const in15 = toDateStr(new Date(today.getTime() + 15 * 86_400_000))
    const inUpcoming = toDateStr(new Date(today.getTime() + UPCOMING_DAYS * 86_400_000))

    const [companies, { data: taxTasks, error: tasksErr }, { data: upcoming, error: upErr }] = await Promise.all([
      AccountingService.getCompanies(),
      supabase
        .from('tasks')
        .select('id, status, due_date')
        .like('unique_key', 'taxcal_%'),
      supabase
        .from('company_tax_deadlines')
        .select('id, company_id, due_date, period_label, companies(name), entry:company_tax_entries(is_mandatory, master:tax_calendar_master(title, entity))')
        .gte('due_date', todayStr)
        .lte('due_date', inUpcoming)
        .order('due_date')
        .limit(100),
    ])
    if (tasksErr) throw tasksErr
    if (upErr) throw upErr

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
      // Próximos vencimientos (todas las empresas), estilo calendario
      upcoming: (upcoming ?? []).map((d: any) => ({
        id:           d.id,
        company_id:   d.company_id,
        company:      d.companies?.name ?? '—',
        due_date:     d.due_date,
        period_label: d.period_label,
        title:        d.entry?.master?.title ?? 'Obligación tributaria',
        entity:       d.entry?.master?.entity ?? null,
        days:         daysUntil(d.due_date, today),
      })),
    }
  }

  // ── Vencimientos dentro del horizonte del cron ─────────────────────────────

  private static async deadlinesInHorizon(today: Date) {
    const todayStr = toDateStr(today)
    const limitStr = toDateStr(new Date(today.getTime() + MAX_NOTICE_DAYS * 86_400_000))

    return fetchAll<any>((from, to) => supabase
      .from('company_tax_deadlines')
      .select('id, company_id, due_date, period_label, companies(name), entry:company_tax_entries(master:tax_calendar_master(title, notice_days))')
      .not('due_date', 'is', null)
      .gte('due_date', todayStr)
      .lte('due_date', limitStr)
      .order('id')
      .range(from, to))
  }

  // ── Cron: crear tareas según la anticipación de cada obligación (punto 4) ──

  static async generateTaxTasks() {
    const today = new Date()
    const deadlines = await AccountingService.deadlinesInHorizon(today)
    if (!deadlines.length) return { created: 0 }

    // Solo los que ya entraron en su ventana de anticipación
    const inWindow = deadlines.filter(d => {
      const notice = d.entry?.master?.notice_days ?? DEFAULT_NOTICE_DAYS
      return daysUntil(d.due_date, today) <= notice
    })
    if (!inWindow.length) return { created: 0 }

    const serviceIds = await AccountingService.accountingServiceIds()
    const serviceId  = serviceIds[0] ?? null

    const rows = inWindow.map(d => ({
      company_id:        d.company_id,
      title:             taskTitle(d.entry?.master?.title ?? 'Obligación tributaria', d.period_label, d.due_date),
      status:            'pending',
      due_date:          d.due_date,
      owner_type:        'rs_team',
      unique_key:        taskKey(d.id),
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
    const deadlines = await AccountingService.deadlinesInHorizon(today)
    if (!deadlines.length) return { reminded: 0 }

    // Incluir los que hoy caen en un hito de recordatorio dentro de su ventana
    const due: { title: string; period: string; company: string; days: number; date: string }[] = []
    for (const d of deadlines) {
      const notice = d.entry?.master?.notice_days ?? DEFAULT_NOTICE_DAYS
      const days = daysUntil(d.due_date, today)
      if (days <= notice && REMINDER_MILESTONES.includes(days)) {
        due.push({
          title:   d.entry?.master?.title ?? 'Obligación tributaria',
          period:  d.period_label,
          company: d.companies?.name ?? '',
          days,
          date:    d.due_date,
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
        return `• ${x.title} · ${x.period} (${x.company}) — ${when} · ${x.date}`
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
