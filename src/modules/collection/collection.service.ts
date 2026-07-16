import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import { NotificationService } from '../../notifications/NotificationService.js'
import type { z } from 'zod'
import type {
  listDebtorsQuerySchema,
  updateDebtorSchema,
  createActionSchema,
  createAgreementSchema,
  createCampaignSchema,
  listActionsQuerySchema,
  createDebtorSchema,
  createDebtSchema,
  createTemplateSchema,
  createCollectionTaskSchema,
  updateCollectionTaskSchema,
  listMessagesQuerySchema,
} from './collection.schema.js'

type ListDebtorsQuery = z.infer<typeof listDebtorsQuerySchema>
type UpdateDebtorInput = z.infer<typeof updateDebtorSchema>
type CreateActionInput = z.infer<typeof createActionSchema>
type CreateAgreementInput = z.infer<typeof createAgreementSchema>
type CreateCampaignInput = z.infer<typeof createCampaignSchema>
type ListActionsQuery = z.infer<typeof listActionsQuerySchema>
type CreateDebtorInput = z.infer<typeof createDebtorSchema>
type CreateDebtInput = z.infer<typeof createDebtSchema>
type CreateTemplateInput = z.infer<typeof createTemplateSchema>
type CreateTaskInput = z.infer<typeof createCollectionTaskSchema>
type UpdateTaskInput = z.infer<typeof updateCollectionTaskSchema>
type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.startsWith('57')) return `+${digits}`
  if (digits.length === 10) return `+57${digits}`
  return `+${digits}`
}

function getTramoName(days: number): string {
  if (days <= 0) return 'no vencido'
  if (days <= 30) return '1-30 días'
  if (days <= 60) return '31-60 días'
  if (days <= 90) return '61-90 días'
  return '91+ días'
}

export class CollectionService {
  // ── Stats ─────────────────────────────────────────────────────────────────

  static async getStats(companyId: string | null) {
    let debtorsQ = supabase
      .from('collection_debtors')
      .select('id, status, phone, email, collection_debts(outstanding_amount, overdue_1_30, overdue_31_60, overdue_61_90, overdue_91_plus, not_yet_due)')
    if (companyId) debtorsQ = debtorsQ.eq('company_id', companyId)
    const { data: debtors, error } = await debtorsQ

    if (error) throw error

    const total = debtors?.length ?? 0
    const active = debtors?.filter(d => d.status !== 'paid').length ?? 0
    const paid = debtors?.filter(d => d.status === 'paid').length ?? 0
    const inCollection = debtors?.filter(d => d.status === 'in_collection').length ?? 0
    const noContact = debtors?.filter(d => !d.phone && !d.email).length ?? 0

    // Saldos por tramo
    let saldo1_30 = 0, saldo31_60 = 0, saldo61_90 = 0, saldo91Plus = 0, saldoNoVencido = 0, saldoTotal = 0
    debtors?.forEach(d => {
      const debts: any[] = (d as any).collection_debts ?? []
      debts.forEach((x: any) => {
        saldo1_30     += x.overdue_1_30 ?? 0
        saldo31_60    += x.overdue_31_60 ?? 0
        saldo61_90    += x.overdue_61_90 ?? 0
        saldo91Plus   += x.overdue_91_plus ?? 0
        saldoNoVencido += x.not_yet_due ?? 0
        saldoTotal    += x.outstanding_amount ?? 0
      })
    })
    const saldoVencido = saldo1_30 + saldo31_60 + saldo61_90 + saldo91Plus

    const mora91 = debtors?.filter(d => {
      const debts: any[] = (d as any).collection_debts ?? []
      return debts.some((x: any) => (x.overdue_91_plus ?? 0) > 0)
    }).length ?? 0

    // Agreements — join through debtor
    let agreementsQ = supabase
      .from('collection_agreements')
      .select('id, status, debtor_id, collection_debtors!inner(company_id)')
      .eq('status', 'active')
    if (companyId) agreementsQ = agreementsQ.eq('collection_debtors.company_id', companyId)
    const { data: agreements } = await agreementsQ

    // Tasks
    let tasksQ = supabase
      .from('collection_tasks')
      .select('id, status, due_date, collection_debtors!inner(company_id)')
    if (companyId) tasksQ = tasksQ.eq('collection_debtors.company_id', companyId)
    const { data: tasks } = await tasksQ

    const today = new Date().toISOString().split('T')[0]
    const tasksHoy = tasks?.filter(t => t.due_date?.startsWith(today)).length ?? 0
    const tasksVencidas = tasks?.filter(t => t.status !== 'done' && t.due_date && t.due_date < today).length ?? 0

    const contacted = debtors?.filter(d => d.status !== 'pending').length ?? 0

    return {
      total, active, paid, inCollection, noContact,
      saldoVencido, saldo1_30, saldo31_60, saldo61_90, saldo91Plus, saldoNoVencido,
      mora91,
      acuerdosActivos: agreements?.length ?? 0,
      tasksHoy, tasksVencidas,
      contactabilidad: total > 0 ? Math.round((contacted / total) * 100) : 0,
      efectividad: contacted > 0 ? Math.round((paid / contacted) * 100) : 0,
    }
  }

  // ── Debtors ───────────────────────────────────────────────────────────────

  static async listDebtors(query: ListDebtorsQuery, companyId: string | null) {
    const { status, search, assigned, page, limit, contact, sort, dir } = query
    const from = (page - 1) * limit

    // Contacto y orden dependen de campos calculados (saldo, mora, antigüedad):
    // en esos casos se trae el conjunto filtrado completo y se pagina en memoria
    const postProcess = !!contact || !!sort

    let q = supabase
      .from('collection_debtors')
      .select('*, companies(name), collection_debts(outstanding_amount,overdue_1_30,overdue_31_60,overdue_61_90,overdue_91_plus,not_yet_due,total_balance,currency,due_date,siigo_document)', { count: 'exact' })
      .order('updated_at', { ascending: false })

    if (postProcess) q = q.limit(2000)
    else q = q.range(from, from + limit - 1)

    if (companyId) q = q.eq('company_id', companyId)

    if (status) {
      q = q.eq('status', status)
    }
    // sin filtro de status → devuelve todos (cartera activa = vista por defecto)
    if (assigned) q = q.eq('assigned_user_id', assigned)
    if (search) {
      q = q.or(`debtor_name.ilike.%${search}%,debtor_document.ilike.%${search}%`)
    }

    const { data, error, count } = await q
    if (error) throw error

    // Fetch advisor profiles in bulk
    const advisorIds = Array.from(new Set((data ?? []).map((d: any) => d.assigned_user_id).filter(Boolean)))
    let advisorsMap = new Map<string, string>()
    if (advisorIds.length > 0) {
      const { data: advisors } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', advisorIds)
      advisorsMap = new Map((advisors ?? []).map((a: any) => [a.id, a.full_name]))
    }

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    let mappedData = (data ?? []).map((d: any) => {
      const debts = d.collection_debts ?? []

      // days_overdue (mora) y fecha vencida más antigua (antigüedad)
      let maxDays = 0
      let oldestDue: string | null = null
      for (const debt of debts) {
        if ((debt.outstanding_amount ?? 0) > 0 && debt.due_date) {
          if (!oldestDue || debt.due_date < oldestDue) oldestDue = debt.due_date
          const dueDate = new Date(debt.due_date)
          dueDate.setHours(0, 0, 0, 0)
          if (dueDate < today) {
            const diffTime = today.getTime() - dueDate.getTime()
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
            if (diffDays > maxDays) {
              maxDays = diffDays
            }
          }
        }
      }

      const outstanding = debts.reduce((a: number, x: any) => a + (x.outstanding_amount ?? 0), 0)

      return {
        ...d,
        days_overdue: maxDays,
        outstanding_balance: outstanding,
        oldest_due_date: oldestDue,
        company: d.companies ? { name: (d.companies as any).name } : null,
        assigned_user: d.assigned_user_id ? { full_name: advisorsMap.get(d.assigned_user_id) ?? null } : null
      }
    })

    // Filtro por datos de contacto
    if (contact) {
      mappedData = mappedData.filter((d: any) => {
        const hasPhone = !!(d.phone || d.whatsapp)
        const hasEmail = !!d.email
        if (contact === 'phone') return hasPhone
        if (contact === 'email') return hasEmail
        return !hasPhone && !hasEmail // 'none' = sin contacto
      })
    }

    // Orden por campos calculados
    if (sort) {
      const ageOf = (d: any) => d.oldest_due_date ? today.getTime() - new Date(d.oldest_due_date).getTime() : -1
      mappedData.sort((a: any, b: any) => {
        let cmp = 0
        if (sort === 'saldo')      cmp = (a.outstanding_balance ?? 0) - (b.outstanding_balance ?? 0)
        else if (sort === 'mora')  cmp = (a.days_overdue ?? 0) - (b.days_overdue ?? 0)
        else                       cmp = ageOf(a) - ageOf(b)
        return dir === 'asc' ? cmp : -cmp
      })
    }

    if (postProcess) {
      const total = mappedData.length
      return { data: mappedData.slice(from, from + limit), total, page, limit }
    }

    return { data: mappedData, total: count ?? 0, page, limit }
  }

  static async getDebtor(id: string) {
    const { data, error } = await supabase
      .from('collection_debtors')
      .select('*, companies(name), collection_debts(*)')
      .eq('id', id)
      .single()

    if (error) throw error

    let advisorName = null
    if (data.assigned_user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', data.assigned_user_id)
        .maybeSingle()
      advisorName = profile?.full_name ?? null
    }

    const debts = data.collection_debts ?? []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    let maxDays = 0
    for (const debt of debts) {
      if ((debt.outstanding_amount ?? 0) > 0 && debt.due_date) {
        const dueDate = new Date(debt.due_date)
        dueDate.setHours(0, 0, 0, 0)
        if (dueDate < today) {
          const diffTime = today.getTime() - dueDate.getTime()
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
          if (diffDays > maxDays) {
            maxDays = diffDays
          }
        }
      }
    }

    return {
      ...data,
      days_overdue: maxDays,
      company: data.companies ? { name: (data.companies as any).name } : null,
      assigned_user: data.assigned_user_id ? { full_name: advisorName } : null
    }
  }

  static async updateDebtor(id: string, input: UpdateDebtorInput) {
    const { data, error } = await supabase
      .from('collection_debtors')
      .update(input)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  static async listActions(query: ListActionsQuery, companyId: string) {
    const { debtor_id, page, limit } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('collection_actions')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (debtor_id) q = q.eq('debtor_id', debtor_id)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async createAction(input: CreateActionInput, userId: string, companyId: string) {
    const { data, error } = await supabase
      .from('collection_actions')
      .insert({ ...input, user_id: userId, company_id: companyId })
      .select()
      .single()

    if (error) throw error
    return data
  }

  // ── Agreements ────────────────────────────────────────────────────────────

  static async createAgreement(input: CreateAgreementInput, companyId: string, createdBy: string) {
    const { data, error } = await supabase
      .from('collection_agreements')
      .insert({ ...input, company_id: companyId, created_by: createdBy })
      .select()
      .single()

    if (error) throw error

    // Notificar al deudor por WhatsApp y email si tiene los datos
    const debtor = await CollectionService.getDebtor(input.debtor_id)

    const notifData = {
      debtorName: debtor.debtor_name,
      amount: String(input.total_amount),
      installments: String(input.installment_count),
      nextDate: input.first_due_date ?? '',
    }

    if (debtor.whatsapp ?? debtor.phone) {
      void NotificationService.enqueue({
        channel: 'whatsapp',
        template: 'collection-agreement',
        to: toE164((debtor.whatsapp ?? debtor.phone)!),
        data: notifData,
        companyId,
      })
    }

    if (debtor.email) {
      void NotificationService.enqueue({
        channel: 'email',
        template: 'collection-agreement',
        to: debtor.email,
        data: notifData,
        companyId,
      })
    }

    return data
  }

  static async listAgreements(debtorId: string) {
    const { data, error } = await supabase
      .from('collection_agreements')
      .select('*')
      .eq('debtor_id', debtorId)
      .order('created_at', { ascending: false })

    if (error) throw error
    return data
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────

  static async listCampaigns(companyId: string | null, page = 1, limit = 10) {
    const from = (page - 1) * limit

    let q = supabase
      .from('collection_campaigns')
      .select('*, collection_templates(name,channel), companies(name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (companyId) q = q.eq('company_id', companyId)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async createCampaign(input: CreateCampaignInput, companyId: string, createdBy: string) {
    const { debtor_ids, message_template, ...rest } = input
    const { data, error } = await supabase
      .from('collection_campaigns')
      .insert({
        ...rest,
        company_id: companyId,
        created_by: createdBy,
        debtor_ids: debtor_ids ?? [],
        message_template: message_template ?? null,
      })
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async sendCampaign(campaignId: string): Promise<{ sent: number }> {
    const { data: campaign, error } = await supabase
      .from('collection_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single()

    if (error || !campaign) throw new Error('Campaña no encontrada')

    const debtorIds: string[] = campaign.debtor_ids ?? []
    const messageTemplate: string = campaign.message_template ?? ''
    const channel = (campaign.channel ?? 'whatsapp') as 'sms' | 'whatsapp' | 'email'

    if (!debtorIds.length) {
      await supabase.from('collection_campaigns')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', campaignId)
      return { sent: 0 }
    }

    const { data: debtors } = await supabase
      .from('collection_debtors')
      .select('id, debtor_name, debtor_document, phone, whatsapp, email, companies(name), assigned_user_id, collection_debts(outstanding_amount, due_date, currency, siigo_document, total_balance)')
      .in('id', debtorIds)

    const advisorIds = Array.from(new Set((debtors ?? []).map((d: any) => d.assigned_user_id).filter(Boolean)))
    let advisorsMap = new Map<string, string>()
    if (advisorIds.length > 0) {
      const { data: advisors } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', advisorIds)
      advisorsMap = new Map((advisors ?? []).map((a: any) => [a.id, a.full_name]))
    }

    const contacts = (debtors ?? [])
      .filter((d: any) => {
        if (channel === 'email') return !!d.email
        if (channel === 'whatsapp') return !!(d.whatsapp ?? d.phone)
        return !!(d.phone ?? d.whatsapp)
      })
      .map((d: any) => {
        const rawPhone = d.whatsapp ?? d.phone
        const to = channel === 'email'
          ? d.email
          : toE164(rawPhone)

        const saldo = (d.collection_debts ?? []).reduce((acc: number, x: any) => acc + (x.outstanding_amount ?? 0), 0)
        const dueDate = d.collection_debts?.[0]?.due_date ?? ''
        const currency = d.collection_debts?.[0]?.currency ?? 'COP'

        // Calculate max days of mora (dias_mora)
        let maxDays = 0
        const todayObj = new Date()
        todayObj.setHours(0, 0, 0, 0)
        for (const debt of d.collection_debts ?? []) {
          if ((debt.outstanding_amount ?? 0) > 0 && debt.due_date) {
            const dueDateObj = new Date(debt.due_date)
            dueDateObj.setHours(0, 0, 0, 0)
            if (dueDateObj < todayObj) {
              const diffTime = todayObj.getTime() - dueDateObj.getTime()
              const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
              if (diffDays > maxDays) {
                maxDays = diffDays
              }
            }
          }
        }

        const companyName = (d.companies as any)?.name ?? ''
        const advisorName = d.assigned_user_id ? (advisorsMap.get(d.assigned_user_id) ?? 'Finto') : 'Finto'

        const debtsList = (d.collection_debts ?? []).filter((x: any) => (x.outstanding_amount ?? 0) > 0)
        const debtsToUse = debtsList.length > 0 ? debtsList : (d.collection_debts ?? [])
        const facturasStr = debtsToUse.map((x: any) => {
          const copFormatted = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(x.outstanding_amount ?? 0).replace(/\s/g, '')

          let usdPart = ''
          if (x.currency === 'USD' && (x.total_balance ?? 0) > 0) {
            const usdFormatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(x.total_balance ?? 0).replace(/\s/g, '')
            usdPart = ` [USD ${usdFormatted}]`
          }

          const docNum = x.siigo_document
          const datePart = x.due_date ? ` (${x.due_date})` : ''

          return `- ${docNum}: ${copFormatted}${usdPart}${datePart}`
        }).join('\n')

        const text = messageTemplate
          .replace(/\{\{nombre\}\}/g, d.debtor_name ?? '')
          .replace(/\{\{saldo\}\}/g, new Intl.NumberFormat('es-CO', { style: 'currency', currency }).format(saldo))
          .replace(/\{\{dias_mora\}\}/g, String(maxDays))
          .replace(/\{\{empresa\}\}/g, companyName)
          .replace(/\{\{asesor\}\}/g, advisorName)
          .replace(/\{\{facturas\}\}/g, facturasStr)

        return {
          to, text, debtorId: d.id, dueDate, currency, saldo,
          // Variables para la plantilla de WhatsApp aprobada por Meta.
          // Se envían todas las conocidas: la plantilla usa las que declare.
          templateVariables: {
            nombre:    d.debtor_name ?? '',
            company:   companyName,
            empresa:   companyName,
            saldo:     new Intl.NumberFormat('es-CO', { style: 'currency', currency }).format(saldo),
            dias_mora: String(maxDays),
            asesor:    advisorName,
            facturas:  facturasStr,
          },
        }
      })

    if (!contacts.length) {
      await supabase.from('collection_campaigns')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', campaignId)
      return { sent: 0 }
    }

    // Enviar mensajes individuales con la cola de BullMQ (reintentos automáticos).
    // WhatsApp fuera de la ventana de 24h exige plantilla aprobada por Meta
    // (messageType 'template'); el texto libre rebota con el error 131047.
    // Plantilla elegida en la campaña; ZAVU_WA_TEMPLATE_ID queda como fallback global
    const waTemplateId = campaign.zavu_template_id ?? process.env.ZAVU_WA_TEMPLATE_ID
    const useTemplate  = channel === 'whatsapp' && !!waTemplateId

    if (channel === 'whatsapp' && !waTemplateId) {
      logger.warn(
        { campaignId },
        'Campaña de WhatsApp sin plantilla (ni zavu_template_id ni ZAVU_WA_TEMPLATE_ID) — saldrá como TEXTO y rebotará fuera de la ventana de 24h (error Meta 131047)',
      )
    }

    await Promise.allSettled(
      contacts.map(c =>
        NotificationService.enqueue({
          channel: channel as any,
          to: c.to,
          template: useTemplate ? 'wa-template' : 'raw-text',
          data: { text: c.text },
          companyId: campaign.company_id,
          metadata: { campaignId, debtorId: c.debtorId },
          ...(useTemplate && {
            templateId:        waTemplateId,
            templateVariables: c.templateVariables,
          }),
        }),
      ),
    )

    // Registrar acción de cobranza por cada deudor contactado
    const actionChannel = channel === 'email' ? 'email' : channel === 'sms' ? 'sms' : 'whatsapp'
    const actions = contacts.map(c => ({
      debtor_id: c.debtorId,
      channel: actionChannel,
      result: 'contacted' as const,
      notes: `Envío masivo: ${campaign.name}`,
      user_id: campaign.created_by,
      company_id: campaign.company_id,
    }))
    if (actions.length) {
      await supabase.from('collection_actions').insert(actions)
    }

    // Actualizar status de deudores a in_collection si están en pending
    await supabase.from('collection_debtors')
      .update({ status: 'in_collection' })
      .in('id', contacts.map(c => c.debtorId))
      .eq('status', 'pending')

    await supabase.from('collection_campaigns')
      .update({ status: 'sent', sent_at: new Date().toISOString(), recipient_count: contacts.length })
      .eq('id', campaignId)

    return { sent: contacts.length }
  }

  // ── Debtors (crear / importar) ────────────────────────────────────────────

  static async createDebtor(input: CreateDebtorInput, companyId: string) {
    const { data, error } = await supabase
      .from('collection_debtors')
      .upsert({ ...input, company_id: companyId }, { onConflict: 'company_id,debtor_document' })
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async createDebt(input: CreateDebtInput, companyId: string) {
    const { data, error } = await supabase
      .from('collection_debts')
      .upsert(
        { ...input, company_id: companyId, last_sync_at: new Date().toISOString() },
        { onConflict: 'debtor_id,siigo_document' },
      )
      .select()
      .single()

    if (error) throw error
    return data
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  static async listTemplates(companyId: string | null) {
    let q = supabase
      .from('collection_templates')
      .select('*, companies(name)')
      .eq('is_active', true)
      .order('name')

    // Con empresa: sus plantillas personalizadas + las globales.
    // Sin empresa (staff): todas, para el panel de administración.
    if (companyId) {
      q = q.or(`company_id.eq.${companyId},is_global.eq.true`)
    }

    const { data, error } = await q
    if (error) throw error
    return data
  }

  static async createTemplate(input: CreateTemplateInput, companyId: string | null) {
    const { data, error } = await supabase
      .from('collection_templates')
      .insert({
        ...input,
        company_id: companyId,
        // Una plantilla asignada a una empresa nunca es global
        is_global:  companyId ? false : true,
      })
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async updateTemplate(id: string, input: Partial<CreateTemplateInput>) {
    const patch: Record<string, unknown> = { ...input }
    // Mantener is_global consistente si se reasigna la empresa
    if (input.company_id !== undefined) patch.is_global = !input.company_id

    const { data, error } = await supabase
      .from('collection_templates')
      .update(patch)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async deleteTemplate(id: string) {
    const { data, error } = await supabase
      .from('collection_templates')
      .update({ is_active: false })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  // ── Collection Tasks ──────────────────────────────────────────────────────

  static async listCollectionTasks(companyId: string, query: { debtor_id?: string; page: number; limit: number }) {
    const { debtor_id, page, limit } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('collection_tasks')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('due_date', { ascending: true })
      .range(from, from + limit - 1)

    if (debtor_id) q = q.eq('debtor_id', debtor_id)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async createCollectionTask(input: CreateTaskInput, companyId: string) {
    const { data, error } = await supabase
      .from('collection_tasks')
      .insert({ ...input, company_id: companyId })
      .select()
      .single()

    if (error) throw error
    return data
  }

  static async updateCollectionTask(id: string, input: UpdateTaskInput) {
    const { data, error } = await supabase
      .from('collection_tasks')
      .update(input)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  // ── Inbound Messages ──────────────────────────────────────────────────────

  static async listMessages(query: ListMessagesQuery) {
    const { debtor_id, company_id, status, page, limit } = query
    const from = (page - 1) * limit

    let q = supabase
      .from('collection_inbound_messages')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1)

    if (debtor_id) q = q.eq('debtor_id', debtor_id)
    if (company_id) q = q.eq('company_id', company_id)
    if (status) q = q.eq('status', status)

    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page, limit }
  }

  static async markMessageRead(id: string) {
    const { data, error } = await supabase
      .from('collection_inbound_messages')
      .update({ status: 'read' })
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return data
  }

  // ── CSV Import ────────────────────────────────────────────────────────────

  static async importDebtors(
    rows: Array<Record<string, string>>,
    companyId: string,
    createdBy: string,
    onProgress?: (pct: number, msg: string) => void,
  ): Promise<{
    imported: number; skipped: number; newDebts: number; updatedDebts: number;
    paidDebts: number; paidDebtors: number;
    errors: Array<{ row: number; reason: string }>
  }> {
    let imported = 0
    let skipped = 0
    let newDebts = 0
    let updatedDebts = 0
    const errors: Array<{ row: number; reason: string }> = []
    const total = rows.length

    // Recopilar qué facturas vienen en este CSV por deudor
    const csvInvoicesByDebtor = new Map<string, Set<string>>()
    const touchedDebtorIds = new Set<string>()

    // ── Paso 1: Procesar filas ──────────────────────────────────────────────
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      const rowNum = i + 2

      if (onProgress && i % 5 === 0) {
        const pct = Math.round(((i + 1) / total) * 80)
        onProgress(pct, `Procesando ${i + 1} de ${total} registros...`)
      }

      const debtor_document = row['debtor_document']?.trim()
      const debtor_name = row['debtor_name']?.trim()

      if (!debtor_document || !debtor_name) {
        errors.push({ row: rowNum, reason: 'debtor_document y debtor_name son obligatorios' })
        skipped++
        continue
      }

      // Upsert debtor — NO sobreescribir status si ya existe
      const { data: existing } = await supabase
        .from('collection_debtors')
        .select('id, status')
        .eq('company_id', companyId)
        .eq('debtor_document', debtor_document)
        .maybeSingle()

      let debtorId: string

      if (existing) {
        debtorId = existing.id
        // Solo actualizar nombre, no tocar status/phone/email (esos vienen de contactos)
        await supabase.from('collection_debtors')
          .update({ debtor_name })
          .eq('id', debtorId)
      } else {
        const { data: newDebtor, error: debtorErr } = await supabase
          .from('collection_debtors')
          .insert({
            company_id: companyId,
            debtor_document,
            debtor_name,
            status: 'pending',
            preferred_channel: 'phone',
          })
          .select('id')
          .single()

        if (debtorErr || !newDebtor) {
          errors.push({ row: rowNum, reason: debtorErr?.message ?? 'Error al crear deudor' })
          skipped++
          continue
        }
        debtorId = newDebtor.id
      }

      touchedDebtorIds.add(debtorId)

      // Upsert factura
      const siigo_document = row['siigo_document']?.trim()
      if (siigo_document) {
        // Registrar esta factura como presente en el CSV
        if (!csvInvoicesByDebtor.has(debtorId)) csvInvoicesByDebtor.set(debtorId, new Set())
        csvInvoicesByDebtor.get(debtorId)!.add(siigo_document)

        // Verificar si la factura ya existía
        const { data: existingDebt } = await supabase
          .from('collection_debts')
          .select('id')
          .eq('debtor_id', debtorId)
          .eq('siigo_document', siigo_document)
          .maybeSingle()

        const totalBalance = parseFloat(row['total_balance'] ?? '0') || 0
        const outstandingAmount = parseFloat(row['outstanding_amount'] ?? '0') || 0

        const { error: debtErr } = await supabase
          .from('collection_debts')
          .upsert({
            debtor_id: debtorId,
            company_id: companyId,
            siigo_document,
            due_date: row['due_date']?.trim() || null,
            seller: row['seller']?.trim() || null,
            overdue_1_30: parseFloat(row['overdue_1_30'] ?? '0') || 0,
            overdue_31_60: parseFloat(row['overdue_31_60'] ?? '0') || 0,
            overdue_61_90: parseFloat(row['overdue_61_90'] ?? '0') || 0,
            overdue_91_plus: parseFloat(row['overdue_91_plus'] ?? '0') || 0,
            not_yet_due: parseFloat(row['not_yet_due'] ?? '0') || 0,
            total_balance: totalBalance,
            outstanding_amount: outstandingAmount,
            currency: row['currency']?.trim() || 'COP',
          }, { onConflict: 'debtor_id,siigo_document', ignoreDuplicates: false })

        if (debtErr) {
          errors.push({ row: rowNum, reason: `Error en factura: ${debtErr.message}` })
        } else {
          if (existingDebt) updatedDebts++
          else newDebts++
        }
      }

      imported++
    }

    // ── Paso 2: Marcar facturas pagadas ─────────────────────────────────────
    // El CSV es la foto completa de la cartera de la empresa: TODA factura
    // de la empresa que no venga en el CSV se considera pagada — incluyendo
    // las de deudores que ya no aparecen en la importación.
    onProgress?.(82, 'Detectando facturas pagadas...')

    // Se limpia por deudor (no por company_id de la factura) para cubrir
    // facturas viejas con company_id inconsistente colgadas de estos deudores.
    let paidDebts = 0
    const { data: allDebtors } = await supabase
      .from('collection_debtors')
      .select('id, status')
      .eq('company_id', companyId)

    const debtorIds = (allDebtors ?? []).map(d => d.id)

    const chunk = <T,>(arr: T[], size: number): T[][] => {
      const out: T[][] = []
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
      return out
    }

    const allCompanyDebts: Array<{ id: string; debtor_id: string; siigo_document: string; outstanding_amount: number | null }> = []
    for (const ids of chunk(debtorIds, 200)) {
      const { data } = await supabase
        .from('collection_debts')
        .select('id, debtor_id, siigo_document, outstanding_amount')
        .in('debtor_id', ids)
      allCompanyDebts.push(...(data ?? []))
    }

    const paidDebtIds: string[] = []
    for (const debt of allCompanyDebts) {
      const inCsv = csvInvoicesByDebtor.get(debt.debtor_id)?.has(debt.siigo_document) ?? false
      if (!inCsv && (debt.outstanding_amount ?? 0) > 0) {
        paidDebtIds.push(debt.id)
      }
    }

    for (const ids of chunk(paidDebtIds, 200)) {
      const { error: paidErr } = await supabase.from('collection_debts')
        .update({ outstanding_amount: 0, overdue_1_30: 0, overdue_31_60: 0, overdue_61_90: 0, overdue_91_plus: 0, not_yet_due: 0 })
        .in('id', ids)
      if (!paidErr) paidDebts += ids.length
    }

    // ── Paso 3: Recalcular tramo y status de TODOS los deudores de la empresa ─
    onProgress?.(90, 'Actualizando tramos y estados...')

    const debtsAfter: Array<{ debtor_id: string; outstanding_amount: number | null; overdue_1_30: number | null; overdue_31_60: number | null; overdue_61_90: number | null; overdue_91_plus: number | null }> = []
    for (const ids of chunk(debtorIds, 200)) {
      const { data } = await supabase
        .from('collection_debts')
        .select('debtor_id, outstanding_amount, overdue_1_30, overdue_31_60, overdue_61_90, overdue_91_plus')
        .in('debtor_id', ids)
      debtsAfter.push(...(data ?? []))
    }

    const debtsByDebtor = new Map<string, NonNullable<typeof debtsAfter>>()
    for (const d of debtsAfter ?? []) {
      const list = debtsByDebtor.get(d.debtor_id) ?? []
      list.push(d)
      debtsByDebtor.set(d.debtor_id, list)
    }

    let paidDebtors = 0
    for (const debtor of allDebtors ?? []) {
      const debts = debtsByDebtor.get(debtor.id)
      if (!debts?.length) continue // sin facturas registradas: no tocar

      const totalOutstanding = debts.reduce((s, d) => s + (d.outstanding_amount ?? 0), 0)

      // Calcular max tramo
      let maxTramo = 0
      if (debts.some(d => (d.overdue_91_plus ?? 0) > 0)) maxTramo = 91
      else if (debts.some(d => (d.overdue_61_90 ?? 0) > 0)) maxTramo = 61
      else if (debts.some(d => (d.overdue_31_60 ?? 0) > 0)) maxTramo = 31
      else if (debts.some(d => (d.overdue_1_30 ?? 0) > 0)) maxTramo = 1

      const update: Record<string, unknown> = { prev_max_tramo: maxTramo }

      if (totalOutstanding <= 0) {
        if (debtor.status !== 'paid') {
          update.status = 'paid'
          paidDebtors++
        }
      } else if (debtor.status === 'paid') {
        // Estaba pagado pero volvió a tener deuda → reactivar
        update.status = 'pending'
      }

      await supabase.from('collection_debtors').update(update).eq('id', debtor.id)
    }

    onProgress?.(100, '¡Importación completada!')

    return { imported, skipped, newDebts, updatedDebts, paidDebts, paidDebtors, errors }
  }
}
