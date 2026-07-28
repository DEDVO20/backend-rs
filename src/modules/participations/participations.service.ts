import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import {
  calcParticipation, formatPurchaseOrder, money,
  calcReceivable, calcPayable, deriveStatus, normalizeInvoiceNumber,
  normalizeSiigoInvoice, nitMatch, parseSiigoDate,
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

const fmtCOP = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n)

// ── Parseo de reportes de SIIGO ──────────────────────────────────────────────

const stripAccents = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Índice de columna cuyo encabezado contiene alguno de los términos */
function colIndex(header: string[], ...terms: string[]): number {
  return header.findIndex(h => terms.some(t => stripAccents(String(h)).includes(stripAccents(t))))
}

const toNum = (v: any) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

type SaleRow = { invoice: string; iso: string; year: number; month: number; nit: string; subtotal: number }

/** "Ventas por vendedor" → facturas de Finto con su valor antes de IVA (Subtotal) */
function parseSalesReport(rows: string[][]): SaleRow[] {
  if (!rows.length) return []
  const header = rows[0]!.map(String)
  const iComp = colIndex(header, 'comprobante')
  const iDate = colIndex(header, 'fecha')
  const iNit  = colIndex(header, 'identificacion', 'nit')
  const iSub  = colIndex(header, 'subtotal')
  if (iComp < 0 || iNit < 0 || iSub < 0) return []

  const out: SaleRow[] = []
  for (const r of rows.slice(1)) {
    const comp = String(r[iComp] ?? '').trim()
    if (!comp) continue
    const d = iDate >= 0 ? parseSiigoDate(String(r[iDate] ?? '')) : null
    out.push({
      invoice:  normalizeSiigoInvoice(comp),
      iso:      d?.iso ?? '',
      year:     d?.year ?? 0,
      month:    d?.month ?? 0,
      nit:      String(r[iNit] ?? ''),
      subtotal: toNum(r[iSub]),
    })
  }
  return out
}

type ReceiptRow = { receipt: string; iso: string; invoice: string; nit: string; value: number }

/** "Recibos de caja detallado por facturas" → recaudos ligados a cada factura */
function parseReceiptsReport(rows: string[][]): ReceiptRow[] {
  if (!rows.length) return []
  const header = rows[0]!.map(String)
  const iComp = colIndex(header, 'comprobante')
  const iDate = colIndex(header, 'fecha')
  const iInv  = colIndex(header, 'vencimiento')   // ← factura a la que se aplica
  const iNit  = colIndex(header, 'identificacion', 'nit')
  const iVal  = colIndex(header, 'valor')
  if (iComp < 0 || iInv < 0 || iVal < 0) return []

  const out: ReceiptRow[] = []
  for (const r of rows.slice(1)) {
    const comp = String(r[iComp] ?? '').trim()
    if (!comp) continue
    const d = iDate >= 0 ? parseSiigoDate(String(r[iDate] ?? '')) : null
    out.push({
      receipt: comp,
      iso:     d?.iso ?? '',
      invoice: normalizeSiigoInvoice(String(r[iInv] ?? '')),
      nit:     iNit >= 0 ? String(r[iNit] ?? '') : '',
      value:   toNum(r[iVal]),
    })
  }
  return out
}

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

  // ── Conciliación con reportes de SIIGO (lado CxC Clientes) ───────────────────

  /**
   * Empareja las participaciones del mes con dos reportes de SIIGO:
   *  - Ventas por vendedor  → factura de Finto (finto_invoice + valor antes de IVA)
   *  - Recibos de caja      → recaudo del cliente (cash_receipt + valor)
   * Reutiliza los mismos campos del registro manual: no cambia la lógica de negocio.
   * Con apply=false devuelve solo el reporte; con apply=true además escribe.
   */
  static async reconcileSiigo(opts: {
    year: number; month: number
    salesRows: string[][]; receiptRows: string[][]
    apply: boolean; userId: string
  }) {
    const { year, month, salesRows, receiptRows, apply, userId } = opts

    const sales    = parseSalesReport(salesRows).filter(s => s.year === year && s.month === month)
    const receipts = parseReceiptsReport(receiptRows)

    // Recibos agrupados por factura (puede haber pagos parciales de una misma factura)
    const receiptsByInvoice = new Map<string, typeof receipts>()
    for (const r of receipts) {
      if (!r.invoice) continue
      const list = receiptsByInvoice.get(r.invoice) ?? []
      list.push(r); receiptsByInvoice.set(r.invoice, list)
    }

    // Participaciones del mes con NIT de la empresa y facturación actual
    const { data: monthly, error } = await supabase
      .from('monthly_participations')
      .select(`
        id, purchase_order, service_value, participation_value,
        participation:service_participations(company_service:company_services(companies(name, nit))),
        participation_invoicing(*)
      `)
      .eq('year', year)
      .eq('month', month)
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    type ResultRow = {
      monthly_id: string; purchase_order: string; company: string
      outcome: 'matched' | 'value_mismatch' | 'ambiguous' | 'not_found'
      finto_invoice?: string; finto_value?: number
      cash_receipt?: string;  cash_value?: number
      note?: string
    }
    const results: ResultRow[] = []
    const toApply: { id: string; existing: any; patch: Record<string, unknown> }[] = []

    for (const mp of monthly ?? []) {
      const company = one(one(one((mp as any).participation)?.company_service)?.companies)
      const name = company?.name ?? '—'
      const nit  = company?.nit ?? ''
      const serviceValue = Number((mp as any).service_value)

      const candidates = sales.filter(s => nitMatch(s.nit, nit))
      const exact = candidates.filter(s => Math.abs(s.subtotal - serviceValue) < 1)

      let chosen: (typeof sales)[number] | null = null
      let outcome: ResultRow['outcome'] = 'not_found'
      let note: string | undefined

      if (exact.length === 1)      { chosen = exact[0]!; outcome = 'matched' }
      else if (exact.length > 1)   { outcome = 'ambiguous'; note = `${exact.length} facturas con el mismo valor` }
      else if (candidates.length === 1) { chosen = candidates[0]!; outcome = 'value_mismatch'; note = `Factura por ${fmtCOP(chosen.subtotal)} vs. servicio ${fmtCOP(serviceValue)}` }
      else if (candidates.length > 1)   { outcome = 'ambiguous'; note = `${candidates.length} facturas del cliente en el mes` }

      const row: ResultRow = { monthly_id: (mp as any).id, purchase_order: (mp as any).purchase_order, company: name, outcome }

      if (chosen) {
        row.finto_invoice = chosen.invoice
        row.finto_value   = chosen.subtotal
        const recs = receiptsByInvoice.get(chosen.invoice) ?? []
        if (recs.length) {
          const totalPaid = money(recs.reduce((a, r) => a + r.value, 0))
          const latest = recs.reduce((a, r) => (r.iso > a.iso ? r : a), recs[0]!)
          row.cash_receipt = recs.length === 1 ? recs[0]!.receipt : `${recs[0]!.receipt} (+${recs.length - 1})`
          row.cash_value   = totalPaid
          ;(row as any).cash_date = latest.iso
          ;(row as any).finto_date = chosen.iso
        }
        if (note) row.note = note

        toApply.push({
          id: (mp as any).id,
          existing: one((mp as any).participation_invoicing) ?? {},
          patch: {
            finto_invoice:      chosen.invoice,
            finto_invoice_date: chosen.iso,
            finto_invoice_value: chosen.subtotal,
            ...(recs.length ? {
              cash_receipt:       row.cash_receipt,
              cash_receipt_date:  (row as any).cash_date,
              cash_receipt_value: row.cash_value,
            } : {}),
          },
        })
      }

      results.push(row)
    }

    // Aplicar (opcional): mezcla con la facturación existente para no pisar el lado CxP
    let applied = 0
    if (apply && toApply.length) {
      for (const item of toApply) {
        const merged = {
          ...item.existing,
          ...item.patch,
          monthly_participation_id: item.id,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        }
        delete (merged as any).id
        const { data: inv, error: upErr } = await supabase
          .from('participation_invoicing')
          .upsert(merged, { onConflict: 'monthly_participation_id' })
          .select()
          .single()
        if (upErr) throw upErr

        const mp = (monthly ?? []).find((m: any) => m.id === item.id) as any
        const { status } = deriveStatus(
          { service_value: Number(mp.service_value), participation_value: Number(mp.participation_value ?? 0) },
          inv,
        )
        await supabase.from('monthly_participations').update({ status }).eq('id', item.id)
        applied += 1
      }
    }

    const summary = {
      total:          results.length,
      matched:        results.filter(r => r.outcome === 'matched').length,
      value_mismatch: results.filter(r => r.outcome === 'value_mismatch').length,
      ambiguous:      results.filter(r => r.outcome === 'ambiguous').length,
      not_found:      results.filter(r => r.outcome === 'not_found').length,
      sales_rows:     sales.length,
      receipt_rows:   receipts.length,
      applied,
    }
    return { summary, results, applied: apply }
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
