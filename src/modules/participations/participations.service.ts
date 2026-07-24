import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import {
  calcParticipation, formatPurchaseOrder, money,
  calcReceivable, calcPayable, deriveStatus, normalizeInvoiceNumber,
} from './participations.domain.js'
import type { z }   from 'zod'
import type {
  thirdPartySchema, updateThirdPartySchema,
  upsertParticipationSchema, invoicingSchema,
} from './participations.schema.js'

type ThirdPartyInput   = z.infer<typeof thirdPartySchema>
type ThirdPartyUpdate  = z.infer<typeof updateThirdPartySchema>
type ParticipationInput = z.infer<typeof upsertParticipationSchema>
type InvoicingInput    = z.infer<typeof invoicingSchema>

const toDateStr = (d: Date) => d.toISOString().split('T')[0]!

export class ParticipationsService {

  // ── Terceros ───────────────────────────────────────────────────────────────

  static async listThirdParties() {
    const { data, error } = await supabase
      .from('third_parties')
      .select('*')
      .eq('active', true)
      .order('name')
    if (error) throw error
    return data
  }

  static async createThirdParty(input: ThirdPartyInput) {
    const { data, error } = await supabase
      .from('third_parties')
      .insert(input)
      .select()
      .single()
    if (error) throw error
    return data
  }

  static async updateThirdParty(id: string, input: ThirdPartyUpdate) {
    const { data, error } = await supabase
      .from('third_parties')
      .update(input)
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return data
  }

  // ── Configuración de participación por servicio (perfil del cliente) ─────────

  /** Servicios contratados de una empresa con su configuración de participación */
  static async listCompanyParticipations(companyId: string) {
    const { data, error } = await supabase
      .from('company_services')
      .select('id, service_value, active, services(id, name), service_participations(*, third_parties(id, name, identification))')
      .eq('company_id', companyId)
      .eq('active', true)
      .order('created_at')
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    return (data ?? []).map((cs: any) => {
      const part = one(cs.service_participations)
      return {
        company_service_id: cs.id,
        service:            one(cs.services),
        service_value:      cs.service_value,
        // "Tiene tercero" es independiente del estado activo/suspendido
        has_third_party:    !!part && part.has_third_party,
        participation:      part ?? null,
        third_party:        part ? one(part.third_parties) : null,
      }
    })
  }

  /** Guarda el valor del servicio y la participación (crea/actualiza/desactiva) */
  static async upsertParticipation(input: ParticipationInput) {
    // 1) Valor del servicio → company_services
    const { error: csErr } = await supabase
      .from('company_services')
      .update({ service_value: input.service_value })
      .eq('id', input.company_service_id)
    if (csErr) throw csErr

    // 2) Participación. Sin tercero: marcar has_third_party=false sin borrar la
    // fila (conserva el histórico); no se crea fila si nunca hubo tercero.
    if (!input.has_third_party) {
      const { data, error } = await supabase
        .from('service_participations')
        .update({ has_third_party: false, updated_at: new Date().toISOString() })
        .eq('company_service_id', input.company_service_id)
        .select()
        .maybeSingle()
      if (error) throw error
      return { service_value: input.service_value, participation: data ?? null }
    }

    const { data, error } = await supabase
      .from('service_participations')
      .upsert({
        company_service_id: input.company_service_id,
        third_party_id:     input.third_party_id!,
        percentage:         input.percentage!,
        start_date:         input.start_date!,
        has_third_party:    true,
        active:             input.active,
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'company_service_id' })
      .select('*, third_parties(id, name, identification)')
      .single()
    if (error) throw error
    return { service_value: input.service_value, participation: data }
  }

  // ── Proceso automático: participación mensual (sección 2 y 3) ────────────────

  /** Genera las participaciones mensuales y sus órdenes de compra */
  static async generateMonthly(params: { year?: number; month?: number } = {}) {
    const now   = new Date()
    const year  = params.year  ?? now.getFullYear()
    const month = params.month ?? (now.getMonth() + 1)
    // Fecha del proceso = último día del mes procesado
    const processDate = toDateStr(new Date(year, month, 0))

    // Solo participaciones activas, con tercero activo y % > 0 (sección reglas)
    const { data: parts, error } = await supabase
      .from('service_participations')
      .select('id, percentage, start_date, active, has_third_party, company_service:company_services(service_value), third_party:third_parties(active)')
      .eq('has_third_party', true)
      .eq('active', true)
      .gt('percentage', 0)
      .lte('start_date', processDate)
    if (error) throw error

    // PostgREST puede tipar las relaciones to-one como array; normalizar
    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const normalized = (parts ?? []).map((p: any) => ({
      id:            p.id as string,
      percentage:    Number(p.percentage),
      service_value: Number(one(p.company_service)?.service_value ?? 0),
      third_active:  !!one(p.third_party)?.active,
    }))

    const eligible = normalized.filter(p => p.third_active && p.service_value > 0)

    if (!eligible.length) return { generated: 0, skipped: 0, year, month }

    // Secuencia de OC continua dentro del periodo (evita duplicados por unique)
    const { data: existing } = await supabase
      .from('monthly_participations')
      .select('participation_id')
      .eq('year', year)
      .eq('month', month)
    const existingIds = new Set((existing ?? []).map((r: any) => r.participation_id))
    let seq = existing?.length ?? 0

    let generated = 0
    for (const p of eligible) {
      if (existingIds.has(p.id)) continue // idempotente: ya existe para este mes/año

      const serviceValue = p.service_value
      const percentage   = p.percentage
      const value        = calcParticipation(serviceValue, percentage)
      seq += 1
      const oc = formatPurchaseOrder(year, month, seq)

      const { data: created, error: insErr } = await supabase
        .from('monthly_participations')
        .insert({
          participation_id:    p.id,
          month, year,
          service_value:       serviceValue,
          percentage,
          participation_value: value,
          purchase_order:      oc,
          status:              'pending',
        })
        .select('id')
        .single()

      if (insErr) {
        // Colisión por ejecución concurrente → saltar sin romper el lote
        if ((insErr as any).code === '23505') { seq -= 1; continue }
        throw insErr
      }

      // Registro de facturación vacío para captura manual
      await supabase.from('participation_invoicing').insert({ monthly_participation_id: created.id })
      generated += 1
    }

    logger.info({ generated, year, month }, 'Cron: participaciones mensuales generadas')
    return { generated, skipped: normalized.length - eligible.length, year, month }
  }

  // ── Consulta de participaciones mensuales ────────────────────────────────────

  static async listMonthly(filters: { year?: number; month?: number; status?: string; page: number; limit: number }) {
    const { year, month, status, page, limit } = filters
    const from = (page - 1) * limit

    let q = supabase
      .from('monthly_participations')
      .select(`
        *,
        participation:service_participations(
          third_party:third_parties(name, identification),
          company_service:company_services(services(name), companies(name))
        ),
        participation_invoicing(*)
      `, { count: 'exact' })
      .order('generated_at', { ascending: false })
      .range(from, from + limit - 1)

    if (year)   q = q.eq('year', year)
    if (month)  q = q.eq('month', month)
    if (status) q = q.eq('status', status)

    const { data, error, count } = await q
    if (error) throw error

    // CxC Clientes y CxP Terceros se calculan al vuelo (no se almacenan)
    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const rows = (data ?? []).map((r: any) => {
      const inv = one(r.participation_invoicing) ?? null
      return { ...r, receivable: calcReceivable(inv), payable: calcPayable(inv) }
    })

    return { data: rows, total: count ?? 0, page, limit }
  }

  // ── Registro manual de facturación + conciliación (secciones 4 y 5) ──────────

  /**
   * Busca la misma factura registrada en otra participación.
   * Es solo una alerta: nunca impide guardar.
   */
  static async findDuplicateInvoice(
    field: 'finto_invoice' | 'third_party_invoice',
    number: string,
    excludeMonthlyId?: string,
  ) {
    const target = normalizeInvoiceNumber(number)
    if (!target) return null

    const { data, error } = await supabase
      .from('participation_invoicing')
      .select(`${field}, monthly_participation_id, monthly_participations(purchase_order, month, year)`)
      .not(field, 'is', null)
      .limit(500)
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const hit = (data ?? []).find((r: any) =>
      r.monthly_participation_id !== excludeMonthlyId &&
      normalizeInvoiceNumber(String(r[field] ?? '')) === target)

    if (!hit) return null
    const mp = one((hit as any).monthly_participations)
    return {
      purchase_order: mp?.purchase_order ?? null,
      month:          mp?.month ?? null,
      year:           mp?.year ?? null,
    }
  }

  static async upsertInvoicing(monthlyId: string, input: InvoicingInput, userId: string) {
    const { data: monthly, error: mErr } = await supabase
      .from('monthly_participations')
      .select('id, service_value, participation_value')
      .eq('id', monthlyId)
      .single()
    if (mErr) throw mErr

    const { data: inv, error } = await supabase
      .from('participation_invoicing')
      .upsert({
        monthly_participation_id: monthlyId,
        ...input,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'monthly_participation_id' })
      .select()
      .single()
    if (error) throw error

    // Conciliar: estado del ciclo completo + saldos CxC/CxP
    const { status, reasons, receivable, payable } = deriveStatus(monthly, inv)
    await supabase
      .from('monthly_participations')
      .update({ status })
      .eq('id', monthlyId)

    // Alertas de factura ya registrada en otra participación (no bloquean)
    const warnings: string[] = []
    for (const [field, label] of [
      ['finto_invoice', 'de Finto'],
      ['third_party_invoice', 'del tercero'],
    ] as const) {
      const num = (input as any)[field]
      if (!num) continue
      const dup = await ParticipationsService.findDuplicateInvoice(field, num, monthlyId)
      if (dup) warnings.push(`La factura ${label} "${num}" ya está registrada en ${dup.purchase_order}`)
    }

    return { invoicing: inv, status, reasons, receivable, payable, warnings }
  }

  // ── Estadísticas del panel ───────────────────────────────────────────────────

  static async stats(year?: number, month?: number) {
    let q = supabase
      .from('monthly_participations')
      .select('status, participation_value, participation_invoicing(finto_invoice_value, cash_receipt_value, third_party_invoice_value, egress_voucher_value)')
    if (year)  q = q.eq('year', year)
    if (month) q = q.eq('month', month)
    const { data, error } = await q
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const rows = data ?? []
    const sum = (fn: (r: any) => number) => money(rows.reduce((a: number, r: any) => a + fn(r), 0))

    return {
      total:     rows.length,
      pending:   rows.filter((r: any) => r.status === 'pending').length,
      review:    rows.filter((r: any) => r.status === 'review').length,
      validated: rows.filter((r: any) => r.status === 'validated').length,
      closed:    rows.filter((r: any) => r.status === 'closed').length,
      total_value: sum(r => Number(r.participation_value ?? 0)),
      // Saldos derivados
      receivable:  sum(r => calcReceivable(one(r.participation_invoicing) ?? null)),
      payable:     sum(r => calcPayable(one(r.participation_invoicing) ?? null)),
    }
  }
}
