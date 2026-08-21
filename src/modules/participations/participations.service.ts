import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import {
  calcParticipation, availableParticipation, deriveInvoiceStatus,
  formatPurchaseOrder, formatPaymentOrder, validateThirdPartyInvoice, money,
  normalizeInvoiceNumber,
  normalizeSiigoInvoice, nitMatch, parseSiigoDate,
  excelSerialToISO, extractInvoiceRef,
} from './participations.domain.js'
import type { z }   from 'zod'
import type {
  thirdPartySchema, updateThirdPartySchema,
  upsertParticipationSchema,
} from './participations.schema.js'

type ThirdPartyInput   = z.infer<typeof thirdPartySchema>
type ThirdPartyUpdate  = z.infer<typeof updateThirdPartySchema>
type ParticipationInput = z.infer<typeof upsertParticipationSchema>

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

/** Índice de la columna de OC. Estricto: "oc" es substring de "documento", así
 *  que se exige coincidencia exacta con "oc" o que contenga "orden". */
function ocIndex(header: string[]): number {
  return header.findIndex(h => {
    const s = stripAccents(String(h)).trim()
    return s === 'oc' || s.includes('orden')
  })
}

// Fecha de una celda: soporta "dd/mm/yyyy" y el serial numérico de Excel (46236)
function parseDateCell(v: any): { iso: string; year: number; month: number } | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/^\d{5}(\.\d+)?$/.test(s)) {           // serial de Excel (~40000-60000)
    const iso = excelSerialToISO(Number(s))
    if (!iso) return null
    const [y, m] = iso.split('-')
    return { iso, year: Number(y), month: Number(m) }
  }
  return parseSiigoDate(s)
}

/** Fila del encabezado real: el reporte de SIIGO suele traer título + empresa +
 *  NIT antes de la fila de columnas. Busca la primera fila que tenga todas. */
function findHeaderRow(rows: string[][], required: string[][]): number {
  return rows.findIndex(r => {
    const h = (r as any[]).map(String)
    return required.every(terms => colIndex(h, ...terms) >= 0)
  })
}

type SaleRow = { invoice: string; iso: string; year: number; month: number; nit: string; subtotal: number }

/** "Ventas por vendedor" → facturas de Finto con su valor antes de IVA (Subtotal) */
function parseSalesReport(rows: string[][]): SaleRow[] {
  if (!rows.length) return []
  const hIdx = findHeaderRow(rows, [['comprobante'], ['subtotal'], ['identificacion', 'nit']])
  if (hIdx < 0) return []
  const header = rows[hIdx]!.map(String)
  const iComp = colIndex(header, 'comprobante')
  const iDate = colIndex(header, 'fecha')
  const iNit  = colIndex(header, 'identificacion', 'nit')
  const iSub  = colIndex(header, 'subtotal')

  const out: SaleRow[] = []
  for (const r of rows.slice(hIdx + 1)) {
    const comp = String(r[iComp] ?? '').trim()
    if (!comp) continue
    const d = iDate >= 0 ? parseDateCell(r[iDate]) : null
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
  const hIdx = findHeaderRow(rows, [['comprobante'], ['vencimiento'], ['valor']])
  if (hIdx < 0) return []
  const header = rows[hIdx]!.map(String)
  const iComp = colIndex(header, 'comprobante')
  const iDate = colIndex(header, 'fecha')
  const iInv  = colIndex(header, 'vencimiento')   // ← factura a la que se aplica
  const iNit  = colIndex(header, 'identificacion', 'nit')
  const iVal  = colIndex(header, 'valor')

  const out: ReceiptRow[] = []
  for (const r of rows.slice(hIdx + 1)) {
    const comp = String(r[iComp] ?? '').trim()
    if (!comp) continue
    const d = iDate >= 0 ? parseDateCell(r[iDate]) : null
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

type PurchaseRow = { document: string; value: number; oc: string }

/** "Facturas de compra" (del tercero) → documento + valor + la OC a la que aplica.
 *  El encabezado puede no estar en la primera fila (a veces hay un título). */
function parsePurchasesReport(rows: string[][]): PurchaseRow[] {
  if (!rows.length) return []
  const headerIdx = rows.findIndex(r => {
    const h = (r as any[]).map(String)
    return ocIndex(h) >= 0
      && colIndex(h, 'documento', 'comprobante', 'factura') >= 0
      && colIndex(h, 'valor', 'total') >= 0
  })
  if (headerIdx < 0) return []
  const header = (rows[headerIdx] as any[]).map(String)
  const iDoc = colIndex(header, 'documento', 'comprobante', 'factura')
  const iVal = colIndex(header, 'valor', 'total')
  const iOc  = ocIndex(header)

  const out: PurchaseRow[] = []
  for (const r of rows.slice(headerIdx + 1)) {
    const doc = String(r[iDoc] ?? '').trim()
    const oc  = String(r[iOc] ?? '').trim().toUpperCase()
    if (!doc && !oc) continue
    out.push({ document: doc, value: toNum(r[iVal]), oc })
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
        participation_type: input.participation_type,
        percentage:         input.participation_type === 'fixed' ? 0 : input.percentage!,
        fixed_value:        input.participation_type === 'fixed' ? input.fixed_value! : null,
        start_date:         input.start_date!,
        end_date:           input.end_date ?? null,
        has_third_party:    true,
        active:             input.active,
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'company_service_id' })
      .select('*, third_parties(id, name, identification)')
      .single()
    if (error) throw error
    return { service_value: input.service_value, participation: data }
  }

  // ── Fase 2: modelo por factura (ventas + recaudo proporcional) ───────────────

  /**
   * Procesa los reportes de SIIGO en el modelo "por factura":
   *  - Ventas  → crea una participación por cada FV que cruza con una config.
   *  - Recibos → suma el recaudo por factura y calcula el disponible (proporcional).
   * Idempotente por número de factura. apply=false devuelve solo el reporte.
   */
  static async processSiigo(opts: {
    salesRows: string[][]; receiptRows: string[][]; apply: boolean
  }) {
    const { salesRows, receiptRows, apply } = opts
    const sales    = parseSalesReport(salesRows)
    const receipts = parseReceiptsReport(receiptRows)

    // Recaudo total por factura (suma de recibos), ignorando recibos duplicados
    const collectedByInvoice = new Map<string, { total: number; receipts: string[] }>()
    const seenReceipts = new Set<string>()
    let dupReceipts = 0
    for (const r of receipts) {
      if (!r.invoice) continue
      const rk = normalizeInvoiceNumber(r.receipt)
      if (rk && seenReceipts.has(rk)) { dupReceipts++; continue }  // recibo duplicado
      if (rk) seenReceipts.add(rk)
      const acc = collectedByInvoice.get(r.invoice) ?? { total: 0, receipts: [] }
      acc.total += r.value
      acc.receipts.push(r.receipt)
      collectedByInvoice.set(r.invoice, acc)
    }

    // Configuraciones activas con NIT de la empresa y valor del servicio
    const { data: configs, error } = await supabase
      .from('service_participations')
      .select('id, participation_type, percentage, fixed_value, start_date, end_date, active, has_third_party, company_service:company_services(service_value, companies(id, name, nit))')
      .eq('has_third_party', true)
      .eq('active', true)
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const cfgList = (configs ?? []).map((c: any) => {
      const cs = one(c.company_service)
      const co = one(cs?.companies)
      return {
        id:           c.id as string,
        type:         (c.participation_type ?? 'percentage') as 'percentage' | 'fixed',
        percentage:   Number(c.percentage),
        fixed_value:  c.fixed_value != null ? Number(c.fixed_value) : null,
        start_date:   c.start_date as string,
        end_date:     c.end_date as string | null,
        service_value: Number(cs?.service_value ?? 0),
        company_id:   co?.id ?? null,
        company_name: co?.name ?? '—',
        nit:          co?.nit ?? '',
      }
    })

    type ResultRow = {
      finto_invoice: string; company: string
      outcome: 'created' | 'updated' | 'value_mismatch' | 'ambiguous' | 'no_config'
      participation_value?: number; collected?: number; available?: number
      status?: string; note?: string
    }
    const results: ResultRow[] = []
    const toWrite: any[] = []
    const seenInvoices = new Set<string>()
    let invalidSales = 0

    for (const s of sales) {
      // Validaciones de venta: fecha inválida, valor no positivo (anulada/
      // negativa) y factura repetida dentro del archivo → se ignoran
      if (!s.iso || s.subtotal <= 0) { invalidSales++; continue }
      const ik = normalizeInvoiceNumber(s.invoice)
      if (ik && seenInvoices.has(ik)) { invalidSales++; continue }
      if (ik) seenInvoices.add(ik)

      const inWindow = (cfg: typeof cfgList[number]) =>
        (!cfg.start_date || cfg.start_date <= s.iso) &&
        (!cfg.end_date || cfg.end_date >= s.iso)
      const candidates = cfgList.filter(c => nitMatch(c.nit, s.nit) && inWindow(c))
      const exact = candidates.filter(c => Math.abs(c.service_value - s.subtotal) < 1)

      let cfg: typeof cfgList[number] | null = null
      let outcome: ResultRow['outcome'] = 'no_config'
      let note: string | undefined

      if (exact.length === 1)          { cfg = exact[0]!; outcome = 'created' }
      else if (exact.length > 1)       { outcome = 'ambiguous'; note = 'varias configuraciones con el mismo valor' }
      else if (candidates.length === 1){ cfg = candidates[0]!; outcome = 'value_mismatch'; note = `factura ${fmtCOP(s.subtotal)} vs. servicio ${fmtCOP(cfg.service_value)}` }
      else if (candidates.length > 1)  { outcome = 'ambiguous'; note = `${candidates.length} configuraciones del cliente` }

      const row: ResultRow = { finto_invoice: s.invoice, company: cfg?.company_name ?? '—', outcome, note }

      if (cfg) {
        const partValue = calcParticipation(cfg.service_value, cfg.percentage, { type: cfg.type, fixedValue: cfg.fixed_value })
        const rec = collectedByInvoice.get(s.invoice)
        const collected = rec?.total ?? 0
        const available = availableParticipation({ type: cfg.type, participationValue: partValue, invoiceValue: s.subtotal, collected })
        const status = deriveInvoiceStatus({ finto_invoice_value: s.subtotal, collected, available_for_payment: available })

        row.participation_value = partValue
        row.collected = collected
        row.available = available
        row.status = status
        // Validación de recaudo: no puede superar el valor de la factura
        if (collected > s.subtotal + 0.01) row.note = `${row.note ? row.note + ' · ' : ''}recaudo mayor a la factura`

        toWrite.push({
          participation_id:    cfg.id,
          company_id:          cfg.company_id,
          finto_invoice:       s.invoice,
          finto_invoice_date:  s.iso || null,
          finto_invoice_value: s.subtotal,
          participation_type:  cfg.type,
          percentage:          cfg.type === 'fixed' ? 0 : cfg.percentage,
          fixed_value:         cfg.type === 'fixed' ? cfg.fixed_value : null,
          participation_value: partValue,
          collected,
          cash_receipts:       rec?.receipts.join(', ') ?? null,
          available_for_payment: available,
          status,
          _period:             s.iso ? s.iso.slice(0, 7) : null,   // yyyy-mm para la OC
        })
      }

      results.push(row)
    }

    let created = 0, updated = 0, attached = 0
    if (apply && toWrite.length) {
      // Secuencia de OC por periodo (solo para las que no reusan una OC existente)
      const seqByPeriod = new Map<string, number>()
      const nextOc = async (period: string | null): Promise<string> => {
        const compact = (period ?? '000000').replace('-', '')
        if (!seqByPeriod.has(compact)) {
          const { count } = await supabase
            .from('invoice_participations')
            .select('id', { count: 'exact', head: true })
            .ilike('purchase_order', `OC-${compact}-%`)
          seqByPeriod.set(compact, count ?? 0)
        }
        const seq = seqByPeriod.get(compact)! + 1
        seqByPeriod.set(compact, seq)
        const [y, m] = (period ?? '2026-01').split('-')
        return formatPurchaseOrder(Number(y), Number(m), seq)
      }

      for (const w of toWrite) {
        const period = (w._period ?? null) as string | null
        delete w._period
        w.period = period
        w.updated_at = new Date().toISOString()

        // 1. La FV ya existe → actualiza y conserva su OC
        const { data: byFv } = await supabase
          .from('invoice_participations')
          .select('id')
          .eq('finto_invoice', w.finto_invoice)
          .maybeSingle()
        if (byFv) {
          const { error } = await supabase.from('invoice_participations').update(w).eq('id', byFv.id)
          if (error) throw error
          updated++
          continue
        }

        // 2. Hay una OC mensual pendiente (sin FV) del mismo cliente y mes → la asocia
        let placeholder: { id: string; purchase_order: string } | null = null
        if (period) {
          const { data } = await supabase
            .from('invoice_participations')
            .select('id, purchase_order')
            .eq('participation_id', w.participation_id)
            .eq('period', period)
            .is('finto_invoice', null)
            .limit(1)
            .maybeSingle()
          placeholder = data as any
        }
        if (placeholder) {
          w.purchase_order = placeholder.purchase_order
          const { error } = await supabase.from('invoice_participations').update(w).eq('id', placeholder.id)
          if (error) throw error
          attached++
          continue
        }

        // 3. Sin OC previa → nueva OC para la FV
        w.purchase_order = await nextOc(period)
        const { error } = await supabase.from('invoice_participations').insert(w)
        if (error) throw error
        created++
      }
    } else {
      for (const w of toWrite) delete w._period
    }

    const summary = {
      sales_rows:     sales.length,
      receipt_rows:   receipts.length,
      matched:        results.filter(r => r.outcome === 'created').length,
      value_mismatch: results.filter(r => r.outcome === 'value_mismatch').length,
      ambiguous:      results.filter(r => r.outcome === 'ambiguous').length,
      no_config:      results.filter(r => r.outcome === 'no_config').length,
      invalid_sales:  invalidSales,   // fecha inválida, valor no positivo, repetidas
      dup_receipts:   dupReceipts,    // recibos duplicados ignorados
      created, updated, attached,     // attached: FV pegada a una OC mensual pendiente
    }
    return { summary, results, applied: apply }
  }

  /**
   * Genera la OC del mes para cada participación activa con tercero (servicio
   * contratado). Crea una fila "pendiente de factura" (sin FV) por servicio y
   * periodo; la FV se asocia luego al importar las ventas. Idempotente: no
   * duplica si ya existe una OC (con o sin FV) para ese servicio y mes.
   */
  static async generateMonthlyOCs(period?: string) {
    const p = period ?? new Date().toISOString().slice(0, 7)   // 'YYYY-MM'
    if (!/^\d{4}-\d{2}$/.test(p)) throw new Error('Periodo inválido (se espera YYYY-MM)')
    const [y, m] = p.split('-').map(Number) as [number, number]
    const firstDay = `${p}-01`
    const lastDay  = `${p}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`

    const { data: configs, error } = await supabase
      .from('service_participations')
      .select('id, participation_type, percentage, fixed_value, start_date, end_date, active, has_third_party, company_service:company_services(service_value, companies(id, name, nit))')
      .eq('has_third_party', true)
      .eq('active', true)
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const cfgList = (configs ?? []).map((c: any) => {
      const cs = one(c.company_service)
      const co = one(cs?.companies)
      return {
        id:            c.id as string,
        type:          (c.participation_type ?? 'percentage') as 'percentage' | 'fixed',
        percentage:    Number(c.percentage),
        fixed_value:   c.fixed_value != null ? Number(c.fixed_value) : null,
        start_date:    c.start_date as string | null,
        end_date:      c.end_date as string | null,
        service_value: Number(cs?.service_value ?? 0),
        company_id:    co?.id ?? null,
        company_name:  co?.name ?? '—',
      }
    }).filter(c =>
      (!c.start_date || c.start_date <= lastDay) &&
      (!c.end_date   || c.end_date   >= firstDay))

    if (!cfgList.length) return { period: p, created: 0, skipped: 0, results: [] as any[] }

    // Servicios que ya tienen OC (con o sin FV) en el periodo → no duplicar
    const { data: existing } = await supabase
      .from('invoice_participations')
      .select('participation_id')
      .eq('period', p)
      .in('participation_id', cfgList.map(c => c.id))
    const already = new Set((existing ?? []).map((e: any) => e.participation_id))

    // Secuencia de OC del periodo
    const compact = p.replace('-', '')
    const { count } = await supabase
      .from('invoice_participations')
      .select('id', { count: 'exact', head: true })
      .ilike('purchase_order', `OC-${compact}-%`)
    let seq = count ?? 0

    const rows: any[] = []
    const results: { company: string; purchase_order: string; participation_value: number }[] = []
    for (const c of cfgList) {
      if (already.has(c.id)) continue
      const partValue = calcParticipation(c.service_value, c.percentage, { type: c.type, fixedValue: c.fixed_value })
      const oc = formatPurchaseOrder(y, m, ++seq)
      rows.push({
        participation_id:      c.id,
        company_id:            c.company_id,
        finto_invoice:         null,
        finto_invoice_date:    null,
        finto_invoice_value:   c.service_value,
        participation_type:    c.type,
        percentage:            c.type === 'fixed' ? 0 : c.percentage,
        fixed_value:           c.type === 'fixed' ? c.fixed_value : null,
        participation_value:   partValue,
        purchase_order:        oc,
        period:                p,
        collected:             0,
        available_for_payment: 0,
        status:                'pending_invoice',
      })
      results.push({ company: c.company_name, purchase_order: oc, participation_value: partValue })
    }

    if (rows.length) {
      const { error: insErr } = await supabase.from('invoice_participations').insert(rows)
      if (insErr) throw insErr
    }

    return { period: p, created: rows.length, skipped: cfgList.length - rows.length, results }
  }

  /** Listado de participaciones por factura (paginado, con filtros) */
  static async listInvoiceParticipations(f: { status?: string; company_id?: string; period?: string; year?: string; from?: string; to?: string; page: number; limit: number }) {
    const offset = (f.page - 1) * f.limit
    let q = supabase
      .from('invoice_participations')
      .select('*, participation:service_participations(third_party:third_parties(name), company_service:company_services(services(name))), companies(name)', { count: 'exact' })
      .order('finto_invoice_date', { ascending: false })
      .range(offset, offset + f.limit - 1)
    if (f.status)               q = q.eq('status', f.status)
    if (f.company_id)           q = q.eq('company_id', f.company_id)
    if (f.period)               q = q.eq('period', f.period)
    else if (f.year)            q = q.like('period', `${f.year}-%`)
    if (f.from)                 q = q.gte('finto_invoice_date', f.from)
    if (f.to)                   q = q.lte('finto_invoice_date', f.to)
    const { data, error, count } = await q
    if (error) throw error
    return { data, total: count ?? 0, page: f.page, limit: f.limit }
  }

  // ── Fase 3: factura del tercero → Orden de Pago → egreso ─────────────────────

  /**
   * Registra la factura del tercero y concilia contra lo causado.
   * Si coincide, genera la Orden de Pago (OP). Nunca bloquea: si no coincide,
   * queda pendiente de revisión sin OP.
   */
  static async registerThirdPartyInvoice(id: string, input: {
    third_party_invoice: string; third_party_invoice_date?: string | null; third_party_invoice_value: number
  }) {
    const { data: ip, error } = await supabase
      .from('invoice_participations')
      .select('id, participation_value, available_for_payment, finto_invoice_date, payment_order')
      .eq('id', id)
      .single()
    if (error) throw error

    const check = validateThirdPartyInvoice(Number(ip.participation_value), {
      number: input.third_party_invoice, value: input.third_party_invoice_value,
    })

    // Validación: factura del tercero ya registrada en otra participación
    const warnings: string[] = []
    const dupTarget = normalizeInvoiceNumber(input.third_party_invoice)
    const { data: others } = await supabase
      .from('invoice_participations')
      .select('third_party_invoice, purchase_order')
      .not('third_party_invoice', 'is', null)
      .neq('id', id)
      .limit(1000)
    const dup = (others ?? []).find((o: any) => normalizeInvoiceNumber(String(o.third_party_invoice ?? '')) === dupTarget)
    if (dup) warnings.push(`La factura del tercero "${input.third_party_invoice}" ya está registrada en ${dup.purchase_order}`)

    let paymentOrder: string | null = ip.payment_order ?? null
    // Genera OP solo si concilia y aún no tiene
    if (check.ok && !paymentOrder) {
      const period = (ip.finto_invoice_date ?? new Date().toISOString()).slice(0, 7)
      const [y, m] = period.split('-')
      const { count } = await supabase
        .from('invoice_participations')
        .select('id', { count: 'exact', head: true })
        .ilike('payment_order', `OP-${y}${m}-%`)
      paymentOrder = formatPaymentOrder(Number(y), Number(m), (count ?? 0) + 1)
    }

    const { error: upErr } = await supabase
      .from('invoice_participations')
      .update({
        third_party_invoice:       input.third_party_invoice,
        third_party_invoice_date:  input.third_party_invoice_date ?? null,
        third_party_invoice_value: input.third_party_invoice_value,
        payment_order:             paymentOrder,
        updated_at:                new Date().toISOString(),
      })
      .eq('id', id)
    if (upErr) throw upErr

    // El estado se deriva de los datos completos
    const updated = await ParticipationsService.recomputeStatus(id)
    return { invoice: updated, ok: check.ok, reasons: check.reasons, payment_order: paymentOrder, warnings }
  }

  /** Registra el Comprobante de Egreso (pago al tercero) */
  static async registerEgress(id: string, input: {
    egress_voucher: string; egress_voucher_date?: string | null; egress_voucher_value: number
  }) {
    const { data: ip, error } = await supabase
      .from('invoice_participations')
      .select('available_for_payment, egress_voucher')
      .eq('id', id)
      .single()
    if (error) throw error

    const available = Number(ip.available_for_payment ?? 0)
    const warnings: string[] = []
    if (input.egress_voucher_value > available + 0.01)
      warnings.push(`El pago (${fmtCOP(input.egress_voucher_value)}) supera lo disponible (${fmtCOP(available)})`)
    if (ip.egress_voucher)
      warnings.push('Esta participación ya tenía un egreso registrado — se reemplaza')

    // Comprobante de egreso ya usado en otra participación
    const dupCe = normalizeInvoiceNumber(input.egress_voucher)
    const { data: otherCe } = await supabase
      .from('invoice_participations')
      .select('egress_voucher, purchase_order')
      .not('egress_voucher', 'is', null)
      .neq('id', id)
      .limit(1000)
    const hitCe = (otherCe ?? []).find((o: any) => normalizeInvoiceNumber(String(o.egress_voucher ?? '')) === dupCe)
    if (hitCe) warnings.push(`El comprobante de egreso "${input.egress_voucher}" ya está registrado en ${hitCe.purchase_order}`)

    const { error: upErr } = await supabase
      .from('invoice_participations')
      .update({
        egress_voucher:       input.egress_voucher,
        egress_voucher_date:  input.egress_voucher_date ?? null,
        egress_voucher_value: input.egress_voucher_value,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', id)
    if (upErr) throw upErr

    const updated = await ParticipationsService.recomputeStatus(id)
    return { invoice: updated, warnings }
  }

  /**
   * Importa los egresos (RP) desde el reporte "Movimiento por cuenta contable".
   * Enlaza cada línea con la participación por el FV de la Descripción y registra
   * el pago (comprobante + valor). Idempotente por (RP + factura).
   */
  /**
   * Importa el reporte de facturas de compra (del tercero) y las concilia por
   * número de OC: a cada OC le pega su factura de compra y, si el valor cuadra
   * con la participación causada, genera la Orden de Pago (reusa la lógica de
   * registerThirdPartyInvoice). Con apply=false solo previsualiza.
   */
  static async importPurchases(rows: string[][], apply: boolean) {
    const purchases = parsePurchasesReport(rows)
    if (!purchases.length)
      throw Object.assign(new Error('El reporte no tiene las columnas esperadas (Documento, Valor, OC)'), { statusCode: 400 })

    type Res = {
      oc: string; document: string; value: number
      outcome: 'matched' | 'value_mismatch' | 'not_found' | 'no_oc'
      participation_value?: number; payment_order?: string | null
      reasons?: string[]; warnings?: string[]
    }
    const results: Res[] = []
    let matched = 0, mismatch = 0, notFound = 0, applied = 0

    for (const pu of purchases) {
      if (!pu.oc) { results.push({ oc: '', document: pu.document, value: pu.value, outcome: 'no_oc' }); continue }

      const { data: ip } = await supabase
        .from('invoice_participations')
        .select('id, participation_value, payment_order')
        .eq('purchase_order', pu.oc)
        .limit(1)
        .maybeSingle()

      if (!ip) { notFound++; results.push({ oc: pu.oc, document: pu.document, value: pu.value, outcome: 'not_found' }); continue }

      const check = validateThirdPartyInvoice(Number(ip.participation_value), { number: pu.document, value: pu.value })
      const res: Res = {
        oc: pu.oc, document: pu.document, value: pu.value,
        participation_value: Number(ip.participation_value),
        outcome: check.ok ? 'matched' : 'value_mismatch',
        reasons: check.reasons.length ? check.reasons : undefined,
      }
      if (check.ok) matched++; else mismatch++

      if (apply) {
        const r = await ParticipationsService.registerThirdPartyInvoice(ip.id, {
          third_party_invoice: pu.document,
          third_party_invoice_value: pu.value,
          third_party_invoice_date: null,
        })
        res.payment_order = r.payment_order
        if (r.warnings?.length) res.warnings = r.warnings
        applied++
      }
      results.push(res)
    }

    return {
      summary: { rows: purchases.length, matched, value_mismatch: mismatch, not_found: notFound, applied },
      results,
      applied: apply,
    }
  }

  static async importEgresos(rows: string[][], apply: boolean) {
    if (!rows.length) return { summary: { rows: 0, matched: 0, not_found: 0, applied: 0 }, results: [] as any[], applied: apply }
    const stripA = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    const findCol = (hdr: string[], ...t: string[]) => hdr.findIndex(h => t.some(x => stripA(String(h)).includes(stripA(x))))
    // El reporte "Movimiento por cuenta contable" trae varias filas de título
    // antes del encabezado real → se detecta la fila que tiene las columnas.
    const headerIdx = rows.findIndex(r => {
      const h = (r as any[]).map(String)
      return findCol(h, 'comprobante') >= 0 && findCol(h, 'descripcion') >= 0
        && findCol(h, 'valor', 'credito', 'debito') >= 0
    })
    if (headerIdx < 0)
      throw Object.assign(new Error('El reporte no tiene las columnas esperadas (Comprobante, Descripción, Valor/Crédito)'), { statusCode: 400 })
    const header = (rows[headerIdx] as any[]).map(String)
    const iComp = findCol(header, 'comprobante')
    const iNit  = findCol(header, 'identificacion')
    const iDate = findCol(header, 'fecha')
    const iDesc = findCol(header, 'descripcion')
    const iVal  = findCol(header, 'valor', 'credito', 'debito')

    const toNum = (v: any) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0 }

    // Parsear líneas y deduplicar por (RP + factura) para evitar el doble conteo
    // que produce el reporte por cuenta contable (una línea por cuenta)
    const seen = new Set<string>()
    type Line = { rp: string; nit: string; iso: string | null; invoice: string; value: number }
    const lines: Line[] = []
    for (const r of rows.slice(headerIdx + 1)) {
      const rp    = String(r[iComp] ?? '').trim()
      const desc  = String(r[iDesc] ?? '')
      const ref   = extractInvoiceRef(desc)
      const value = toNum(r[iVal])
      if (!rp || !ref || value <= 0) continue
      const key = `${rp}::${normalizeInvoiceNumber(ref)}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push({
        rp, nit: iNit >= 0 ? String(r[iNit] ?? '') : '',
        iso: iDate >= 0 ? excelSerialToISO(toNum(r[iDate])) : null,
        invoice: ref, value,
      })
    }

    // Participaciones aún sin pago, con el NIT de su tercero (para cruzar el RP)
    const { data: parts } = await supabase
      .from('invoice_participations')
      .select('id, participation_value, available_for_payment, purchase_order, payment_order, egress_voucher, finto_invoice_date, participation:service_participations(third_party:third_parties(identification, name))')
    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const openParts = (parts ?? []).map((p: any) => {
      const tp = one(one(p.participation)?.third_party)
      return { ...p, tercero_nit: String(tp?.identification ?? ''), tercero_name: tp?.name ?? '' }
    // Solo participaciones disponibles para pago (recaudadas) y sin egreso aún
    }).filter((p: any) => !p.egress_voucher && Number(p.available_for_payment) > 0)

    type Res = {
      rp: string; invoice: string; value: number; nit: string
      outcome: 'matched' | 'value_mismatch' | 'ambiguous' | 'not_found'
      tercero?: string; purchase_order?: string; payment_order?: string; note?: string
    }
    const results: Res[] = []
    const usedIds = new Set<string>()
    let applied = 0

    for (const l of lines) {
      // Candidatas del mismo tercero (NIT), no reclamadas por otra línea del archivo
      const sameNit = openParts.filter((p: any) => !usedIds.has(p.id) && nitMatch(p.tercero_nit, l.nit))
      const exact = sameNit.filter((p: any) => Math.abs(Number(p.participation_value) - l.value) < 1)

      let match: any = null
      let outcome: Res['outcome'] = 'not_found'
      let note: string | undefined
      if (exact.length === 1)      { match = exact[0]; outcome = 'matched' }
      else if (exact.length > 1)   { outcome = 'ambiguous'; note = `${exact.length} participaciones del tercero con igual valor` }
      else if (sameNit.length > 0) { outcome = 'value_mismatch'; note = `pago ${fmtCOP(l.value)} sin participación de igual valor para el tercero` }

      const res: Res = {
        rp: l.rp, invoice: l.invoice, value: l.value, nit: l.nit, outcome,
        tercero: match?.tercero_name, purchase_order: match?.purchase_order, note,
      }

      if (match) {
        usedIds.add(match.id)
        if (apply) {
          // 1) Factura de compra (de la descripción) → concilia y genera la OP
          const tp = await ParticipationsService.registerThirdPartyInvoice(match.id, {
            third_party_invoice:       l.invoice,
            third_party_invoice_value: l.value,
            third_party_invoice_date:  l.iso,
          })
          res.payment_order = tp.payment_order ?? undefined
          // 2) Egreso (pago al tercero) → cierra el ciclo
          await ParticipationsService.registerEgress(match.id, {
            egress_voucher:       l.rp,
            egress_voucher_date:  l.iso,
            egress_voucher_value: l.value,
          })
          applied++
        }
      }
      results.push(res)
    }

    return {
      summary: {
        rows:           lines.length,
        matched:        results.filter(r => r.outcome === 'matched').length,
        value_mismatch: results.filter(r => r.outcome === 'value_mismatch').length,
        ambiguous:      results.filter(r => r.outcome === 'ambiguous').length,
        not_found:      results.filter(r => r.outcome === 'not_found').length,
        applied,
      },
      results,
      applied: apply,
    }
  }

  /** Recalcula el estado de una participación por factura desde sus datos */
  static async recomputeStatus(id: string) {
    const { data: ip, error } = await supabase
      .from('invoice_participations')
      .select('finto_invoice_value, collected, available_for_payment, participation_value, payment_order, egress_voucher, egress_voucher_value')
      .eq('id', id)
      .single()
    if (error) throw error

    const status = deriveInvoiceStatus(ip as any)
    const { data, error: upErr } = await supabase
      .from('invoice_participations')
      .update({ status })
      .eq('id', id)
      .select()
      .single()
    if (upErr) throw upErr
    return data
  }

  static async invoiceStats(f: { company_id?: string; period?: string; year?: string; from?: string; to?: string } = {}) {
    let q = supabase.from('invoice_participations')
      .select('status, participation_value, collected, available_for_payment')
    if (f.company_id) q = q.eq('company_id', f.company_id)
    if (f.period)     q = q.eq('period', f.period)
    else if (f.year)  q = q.like('period', `${f.year}-%`)
    if (f.from)       q = q.gte('finto_invoice_date', f.from)
    if (f.to)         q = q.lte('finto_invoice_date', f.to)
    const { data, error } = await q
    if (error) throw error
    const rows = data ?? []
    const sum = (fn: (r: any) => number) => money(rows.reduce((a: number, r: any) => a + fn(r), 0))
    return {
      total:              rows.length,
      pending_invoice:    rows.filter((r: any) => r.status === 'pending_invoice').length,
      invoiced:           rows.filter((r: any) => r.status === 'invoiced').length,
      partial_collection: rows.filter((r: any) => r.status === 'partial_collection').length,
      available:          rows.filter((r: any) => r.status === 'available').length,
      paid:               rows.filter((r: any) => ['paid', 'closed'].includes(r.status)).length,
      participation_total: sum(r => Number(r.participation_value ?? 0)),
      available_total:     sum(r => Number(r.available_for_payment ?? 0)),
    }
  }

  /**
   * Vista maestra de conciliación (hoja "Conciliación" del spec): una fila por
   * OC con las 5 etapas — generación (FINTO), venta, compra del tercero, pago
   * (RP) y recaudo (RC). Aplana los joins a cliente y tercero.
   */
  static async conciliation(filters: { period?: string; company_id?: string; year?: string; from?: string; to?: string }) {
    let q = supabase
      .from('invoice_participations')
      .select('period, finto_invoice, finto_invoice_date, finto_invoice_value, purchase_order, participation_value, third_party_invoice, third_party_invoice_value, egress_voucher, egress_voucher_value, collected, cash_receipts, status, companies(name, nit), participation:service_participations(third_party:third_parties(name, identification))')
      .order('period', { ascending: true })
      .order('purchase_order', { ascending: true })
    if (filters.period)     q = q.eq('period', filters.period)
    else if (filters.year)  q = q.like('period', `${filters.year}-%`)
    if (filters.company_id) q = q.eq('company_id', filters.company_id)
    if (filters.from)       q = q.gte('finto_invoice_date', filters.from)
    if (filters.to)         q = q.lte('finto_invoice_date', filters.to)
    const { data, error } = await q
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    return (data ?? []).map((r: any) => {
      const co = one(r.companies)
      const tp = one(one(r.participation)?.third_party)
      return {
        // FINTO — generación
        mes:           r.period,
        cliente:       co?.name ?? '—',
        nit_cliente:   co?.nit ?? '',
        venta:         Number(r.finto_invoice_value ?? 0),
        oc:            r.purchase_order,
        tercero:       tp?.name ?? '—',
        nit_tercero:   tp?.identification ?? '',
        participacion: Number(r.participation_value ?? 0),
        // Conciliación RC — recaudo del cliente
        f_venta:       r.finto_invoice ?? null,
        f_venta_valor: Number(r.finto_invoice_value ?? 0),
        rc:            r.cash_receipts ?? null,
        recaudo:       Number(r.collected ?? 0),
        // Conciliación RP — pago al tercero
        f_compra:       r.third_party_invoice ?? null,
        f_compra_valor: r.third_party_invoice_value != null ? Number(r.third_party_invoice_value) : null,
        rp:             r.egress_voucher ?? null,
        pago:           r.egress_voucher_value != null ? Number(r.egress_voucher_value) : null,
        estado:         r.status,
      }
    })
  }

  /**
   * Panel de saldos: lo que nos deben los clientes (CxC = facturado − recaudado)
   * y lo que le debemos a cada tercero (CxP = disponible para pago − pagado).
   */
  static async balances(filters: { period?: string; company_id?: string; year?: string; from?: string; to?: string }) {
    let q = supabase
      .from('invoice_participations')
      .select('finto_invoice, finto_invoice_value, collected, participation_value, available_for_payment, egress_voucher, egress_voucher_value, company_id, companies(name), participation:service_participations(third_party:third_parties(name, identification))')
    if (filters.period)     q = q.eq('period', filters.period)
    else if (filters.year)  q = q.like('period', `${filters.year}-%`)
    if (filters.company_id) q = q.eq('company_id', filters.company_id)
    if (filters.from)       q = q.gte('finto_invoice_date', filters.from)
    if (filters.to)         q = q.lte('finto_invoice_date', filters.to)
    const { data, error } = await q
    if (error) throw error
    const one = (v: any) => Array.isArray(v) ? v[0] : v

    const cxc = new Map<string, { client: string; invoiced: number; collected: number; outstanding: number; count: number }>()
    const cxp = new Map<string, { third_party: string; nit: string; owed: number; paid: number; count: number }>()
    let receivable = 0, payable = 0, participationTotal = 0, availableTotal = 0, paidTotal = 0

    for (const r of data ?? []) {
      const inv       = Number((r as any).finto_invoice_value ?? 0)
      const collected = Number((r as any).collected ?? 0)
      const part      = Number((r as any).participation_value ?? 0)
      const avail     = Number((r as any).available_for_payment ?? 0)
      const paid      = Number((r as any).egress_voucher_value ?? 0)
      participationTotal += part
      availableTotal     += avail
      paidTotal          += paid

      // CxC Clientes — solo cuentas con factura de venta emitida
      if ((r as any).finto_invoice) {
        const outstanding = Math.max(0, inv - collected)
        receivable += outstanding
        const co = one((r as any).companies)
        const key = String((r as any).company_id ?? co?.name ?? '—')
        const e = cxc.get(key) ?? { client: co?.name ?? '—', invoiced: 0, collected: 0, outstanding: 0, count: 0 }
        e.invoiced += inv; e.collected += collected; e.outstanding += outstanding; e.count++
        cxc.set(key, e)
      }

      // CxP Terceros — lo que aún debemos = disponible − pagado
      const owed = Math.max(0, avail - paid)
      payable += owed
      const tp = one(one((r as any).participation)?.third_party)
      const tkey = String(tp?.identification || tp?.name || '—')
      const te = cxp.get(tkey) ?? { third_party: tp?.name ?? '—', nit: tp?.identification ?? '', owed: 0, paid: 0, count: 0 }
      te.owed += owed; te.paid += paid; te.count++
      cxp.set(tkey, te)
    }

    const r2 = (n: number) => money(n)
    return {
      summary: {
        participation_total: r2(participationTotal),
        available_total:     r2(availableTotal),
        paid_total:          r2(paidTotal),
        receivable_total:    r2(receivable),   // lo que nos deben (clientes)
        payable_total:       r2(payable),      // lo que debemos (terceros)
      },
      receivable: [...cxc.values()]
        .map(e => ({ ...e, invoiced: r2(e.invoiced), collected: r2(e.collected), outstanding: r2(e.outstanding) }))
        .filter(e => e.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding),
      payable: [...cxp.values()]
        .map(e => ({ ...e, owed: r2(e.owed), paid: r2(e.paid) }))
        .filter(e => e.owed > 0)
        .sort((a, b) => b.owed - a.owed),
    }
  }

}
