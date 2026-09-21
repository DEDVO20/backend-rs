import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import {
  calcParticipation, availableParticipation, deriveInvoiceStatus,
  formatPurchaseOrder, formatPaymentOrder, validateThirdPartyInvoice, money,
  normalizeInvoiceNumber,
  normalizeSiigoInvoice, nitMatch, normalizeNit,
  parseAccountingMovement, PARTICIPATION_ACCOUNTS, billedPeriods,
} from './participations.domain.js'
import type { ParticipationAccounts, MovCollection } from './participations.domain.js'
import { computeOperation, partitionInvoice } from '../tax/tax.domain.js'
import { rowToProfile, rowToSettings, type TaxProfileRow, type SettingsRow } from '../tax/tax.service.js'
import type { z }   from 'zod'
import type {
  thirdPartySchema, updateThirdPartySchema,
  upsertParticipationSchema,
} from './participations.schema.js'

type ThirdPartyInput   = z.infer<typeof thirdPartySchema>
type ThirdPartyUpdate  = z.infer<typeof updateThirdPartySchema>
type ParticipationInput = z.infer<typeof upsertParticipationSchema>

const toDateStr = (d: Date) => d.toISOString().split('T')[0]!

// ── Parseo de reportes de SIIGO ──────────────────────────────────────────────

const stripAccents = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')


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
      .select('id, start_date, end_date, service_value, active, services(id, name), service_participations(*, third_parties(id, name, identification))')
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
        start_date:         cs.start_date,
        end_date:           cs.end_date,
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

    const isMandate = input.contract_type === 'mandato'
    const { data, error } = await supabase
      .from('service_participations')
      .upsert({
        company_service_id: input.company_service_id,
        third_party_id:     input.third_party_id!,
        contract_type:      input.contract_type,
        participation_type: input.participation_type,
        // En mandato el % es la comisión (informativa); acepta undefined → 0.
        percentage:         input.participation_type === 'fixed' ? 0 : (input.percentage ?? 0),
        fixed_value:        input.participation_type === 'fixed' && !isMandate ? input.fixed_value! : null,
        start_date:         input.start_date!,
        end_date:           input.end_date ?? null,
        billing_day:        input.billing_day,
        billing_mode:       input.billing_mode,
        has_third_party:    true,
        active:             input.active,
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'company_service_id' })
      .select('*, third_parties(id, name, identification)')
      .single()
    if (error) throw error

    // Backfill: al configurar el servicio se generan las OC de los meses que
    // falten desde la fecha de inicio (aunque sea de varios meses atrás).
    let backfill: Awaited<ReturnType<typeof ParticipationsService.generateMonthlyOCs>> | null = null
    if (input.active && data?.id) {
      try { backfill = await ParticipationsService.generateMonthlyOCs({ participationId: data.id }) }
      catch (e) { logger.error({ e }, 'backfill OC tras upsertParticipation falló') }
    }
    return { service_value: input.service_value, participation: data, oc_backfill: backfill }
  }

  // ── Cuentas contables del import (configurables) ─────────────────────────────

  /** Fila única de cuentas; si no existe, devuelve los prefijos por defecto. */
  static async getAccountSettings() {
    const { data } = await supabase
      .from('participation_account_settings')
      .select('income_account, mandate_account, receivable_account, third_invoice_account, payment_account')
      .eq('id', 1)
      .maybeSingle()
    return {
      income_account:        data?.income_account        ?? PARTICIPATION_ACCOUNTS.income,
      mandate_account:       data?.mandate_account       ?? PARTICIPATION_ACCOUNTS.mandate,
      receivable_account:    data?.receivable_account    ?? PARTICIPATION_ACCOUNTS.receivable,
      third_invoice_account: data?.third_invoice_account ?? PARTICIPATION_ACCOUNTS.thirdInvoice,
      payment_account:       data?.payment_account       ?? PARTICIPATION_ACCOUNTS.payment,
    }
  }

  static async updateAccountSettings(input: {
    income_account: string; mandate_account: string; receivable_account: string
    third_invoice_account: string; payment_account: string
  }) {
    const { data, error } = await supabase
      .from('participation_account_settings')
      .upsert({ id: 1, ...input, updated_at: new Date().toISOString() }, { onConflict: 'id' })
      .select('income_account, mandate_account, receivable_account, third_invoice_account, payment_account')
      .single()
    if (error) throw error
    return data
  }

  /** Mapea la fila de settings al shape que consume parseAccountingMovement */
  private static async loadAccounts(): Promise<ParticipationAccounts> {
    const s = await ParticipationsService.getAccountSettings()
    return {
      income:       s.income_account,
      mandate:      s.mandate_account,
      receivable:   s.receivable_account,
      thirdInvoice: s.third_invoice_account,
      payment:      s.payment_account,
    }
  }


  /**
   * Genera las OC que falten (backfill) para cada participación activa con tercero
   * — servicio Y mandato. Desde la fecha de inicio del tercero hasta el último
   * periodo facturable (mes actual si es anticipado, mes anterior si es vencido).
   * El primer mes se prorratea (día 1 → 100%, día 15 → 50%). El mandato sale como
   * placeholder ($0) y el import le pega la porción real. Idempotente por
   * (participación, periodo): no reexpide OC de meses ya expedidos aunque cambie
   * el % o el tipo. `participationId` limita a una sola participación (backfill al
   * configurar el servicio).
   */
  static async generateMonthlyOCs(opts?: { period?: string; participationId?: string }) {
    const target = opts?.period ?? new Date().toISOString().slice(0, 7)   // 'YYYY-MM'
    if (!/^\d{4}-\d{2}$/.test(target)) throw new Error('Periodo inválido (se espera YYYY-MM)')

    let q = supabase
      .from('service_participations')
      .select('id, contract_type, participation_type, percentage, fixed_value, start_date, end_date, billing_day, billing_mode, active, has_third_party, company_service:company_services(start_date, end_date, service_value, companies(id, name, nit))')
      .eq('has_third_party', true)
      .eq('active', true)
    if (opts?.participationId) q = q.eq('id', opts.participationId)
    const { data: configs, error } = await q
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const cfgList = (configs ?? []).map((c: any) => {
      const cs = one(c.company_service)
      const co = one(cs?.companies)
      return {
        id:            c.id as string,
        contract_type: (c.contract_type ?? 'servicio') as 'servicio' | 'mandato',
        type:          (c.participation_type ?? 'percentage') as 'percentage' | 'fixed',
        percentage:    Number(c.percentage),
        fixed_value:   c.fixed_value != null ? Number(c.fixed_value) : null,
        start_date:    (c.start_date || cs?.start_date) as string | null,
        end_date:      (c.end_date || cs?.end_date) as string | null,
        billing_day:   Number(c.billing_day ?? 1),
        billing_mode:  (c.billing_mode ?? 'vencido') as 'vencido' | 'anticipado',
        service_value: Number(cs?.service_value ?? 0),
        company_id:    co?.id ?? null,
        company_name:  co?.name ?? '—',
      }
    })

    // Plan de (config × periodo) facturable, con su prorrateo
    type Plan = { cfg: typeof cfgList[number]; period: string; proration: number }
    const plans: Plan[] = []
    for (const c of cfgList) {
      if (!c.start_date) continue
      for (const bp of billedPeriods({ startDate: c.start_date, billingDay: c.billing_day, billingMode: c.billing_mode, targetMonth: target, endDate: c.end_date }))
        plans.push({ cfg: c, period: bp.period, proration: bp.proration })
    }
    if (!plans.length) return { target, created: 0, skipped: 0, results: [] as any[] }

    // (participación, periodo) que ya tienen OC → no reexpedir
    const partIds = [...new Set(plans.map(p => p.cfg.id))]
    const { data: existing } = await supabase
      .from('invoice_participations')
      .select('participation_id, period')
      .in('participation_id', partIds)
    const has = new Set((existing ?? []).map((e: any) => `${e.participation_id}::${e.period}`))

    // Secuencia de OC por periodo
    const seqByPeriod = new Map<string, number>()
    const nextOc = async (period: string): Promise<string> => {
      const compact = period.replace('-', '')
      if (!seqByPeriod.has(compact)) {
        const { count } = await supabase
          .from('invoice_participations')
          .select('id', { count: 'exact', head: true })
          .ilike('purchase_order', `OC-${compact}-%`)
        seqByPeriod.set(compact, count ?? 0)
      }
      const seq = seqByPeriod.get(compact)! + 1
      seqByPeriod.set(compact, seq)
      const [yy, mm] = period.split('-').map(Number) as [number, number]
      return formatPurchaseOrder(yy, mm, seq)
    }

    const rows: any[] = []
    const results: any[] = []
    let skipped = 0
    plans.sort((a, b) => a.period.localeCompare(b.period))   // numeración coherente
    for (const pl of plans) {
      const key = `${pl.cfg.id}::${pl.period}`
      if (has.has(key)) { skipped++; continue }
      has.add(key)
      const c = pl.cfg
      const isMandate = c.contract_type === 'mandato'
      const base = money(c.service_value * pl.proration)
      const partValue = isMandate ? 0 : money(calcParticipation(c.service_value, c.percentage, { type: c.type, fixedValue: c.fixed_value }) * pl.proration)
      const oc = await nextOc(pl.period)
      rows.push({
        participation_id:      c.id,
        company_id:            c.company_id,
        finto_invoice:         null,
        finto_invoice_date:    null,
        finto_invoice_value:   isMandate ? 0 : base,
        contract_type:         c.contract_type,
        participation_type:    c.type,
        percentage:            c.type === 'fixed' ? 0 : c.percentage,
        fixed_value:           c.type === 'fixed' && !isMandate ? c.fixed_value : null,
        participation_value:   partValue,
        proration:             pl.proration,
        purchase_order:        oc,
        period:                pl.period,
        collected:             0,
        available_for_payment: 0,
        status:                'pending_invoice',
      })
      results.push({ company: c.company_name, contract: c.contract_type, period: pl.period, purchase_order: oc, participation_value: partValue, proration: pl.proration })
    }

    if (rows.length) {
      const { error: insErr } = await supabase.from('invoice_participations').insert(rows)
      if (insErr) throw insErr
    }

    return { target, created: rows.length, skipped, results }
  }

  /** Listado de participaciones por factura (paginado, con filtros) */
  static async listInvoiceParticipations(f: { status?: string; company_id?: string; period?: string; year?: string; from?: string; to?: string; page: number; limit: number }) {
    const offset = (f.page - 1) * f.limit
    let q = supabase
      .from('invoice_participations')
      .select(
        '*, participation:service_participations(third_party:third_parties(name, identification, tax_profile:tax_profiles(*)), company_service:company_services(services(name))), companies(name, nit)',
        { count: 'exact' },
      )
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
    const rows = data ?? []
    const fvs = rows.map((r: any) => r.finto_invoice).filter(Boolean)
    const rcDates = new Map<string, string>()
    const rpDates = new Map<string, string>()

    if (fvs.length) {
      try {
        const { data: siigoDocs } = await supabase
          .from('siigo_documents')
          .select('doc_type, comprobante, fv_ref, doc_date')
          .in('doc_type', ['RC', 'RP'])
          .in('fv_ref', fvs)

        for (const d of siigoDocs ?? []) {
          const fvKey = normalizeInvoiceNumber(d.fv_ref)
          if (fvKey) {
            if (d.doc_type === 'RC' && d.doc_date && !rcDates.has(fvKey)) {
              rcDates.set(fvKey, d.doc_date)
            }
            if (d.doc_type === 'RP' && d.doc_date && !rpDates.has(fvKey)) {
              rpDates.set(fvKey, d.doc_date)
            }
          }
        }
      } catch (e) {
        logger.warn({ err: (e as any)?.message }, 'Error al consultar siigo_documents para fechas de RC/RP')
      }
    }

    // Partición tributaria por factura: pagar al tercero / nos deben / queda en Finto.
    const settings = await ParticipationsService.loadTaxSettings()
    const withPartition = rows.map((row: any) => {
      const profileRow = row?.participation?.third_party?.tax_profile as TaxProfileRow | null | undefined
      const partition = ParticipationsService.computePartition(row, profileRow ?? null, settings)
      const fvKey = row.finto_invoice ? normalizeInvoiceNumber(row.finto_invoice) : ''
      return {
        ...row,
        cash_receipt_date: fvKey ? (rcDates.get(fvKey) ?? null) : null,
        egress_voucher_date: row.egress_voucher_date ?? (fvKey ? (rpDates.get(fvKey) ?? null) : null),
        tax_partition: partition,
      }
    })

    return { data: withPartition, total: count ?? 0, page: f.page, limit: f.limit }
  }

  /** Parámetros de la operación tributaria (singleton). Fallbacks si no existe la fila. */
  static async loadTaxSettings(): Promise<SettingsRow> {
    const { data } = await supabase.from('tax_operation_settings').select('*').eq('id', 1).single()
    return (data as SettingsRow) ?? {
      id: 1, iva_rate: 0.19, income_withholding_rate: 0.11, ica_withholding_rate: 0.00866,
      iva_withholding_rate: 0.15, commission_rate: 0.20, commission_iva_rate: 0.19, default_invoice_value: 0,
    }
  }

  /**
   * Calcula la partición de una factura con el motor tributario, usando el perfil
   * del tercero como base = participación causada. Sin perfil asignado, se asume
   * neutro (sin IVA ni retenciones) pero igual se aplica la comisión de la firma.
   */
  static computePartition(
    row: { participation_value?: number | null; finto_invoice_value?: number | null; collected?: number | null },
    profileRow: TaxProfileRow | null,
    settings: SettingsRow,
  ) {
    const participation = Number(row.participation_value ?? 0)
    const emitter = profileRow ? rowToProfile(profileRow) : {
      personType: 'JURIDICA' as const, taxRegime: 'ORDINARY' as const,
      ivaResponsible: false, grandTaxpayer: false,
      incomeWithholding: { subject: false }, icaWithholding: { subject: false }, ivaWithholding: { subject: false },
      agentIncomeWithholding: false, agentIcaWithholding: false,
    }
    // El receptor (Finto) actúa como agente de todas las retenciones.
    const result = computeOperation({
      invoiceValue: participation,
      emitter,
      receiver: { incomeWithholdingAgent: true, icaWithholdingAgent: true, ivaWithholdingAgent: true },
      settings: rowToSettings(settings),
    })
    const partition = partitionInvoice({
      result,
      saleValue: Number(row.finto_invoice_value ?? 0),
      collected: Number(row.collected ?? 0),
    })
    return { has_profile: !!profileRow, ...partition, breakdown: result }
  }

  // ── Fase 3: factura del tercero → Orden de Pago → egreso ─────────────────────

  /**
   * Importa el reporte "Movimiento por cuenta contable" — la fuente única del
   * ciclo de participaciones. Clasifica cada fila por cuenta + comprobante
   * (parseAccountingMovement) y arma, según la configuración del cliente:
   *   · servicio → participación = venta (cuenta 41) × % (o valor fijo)
   *   · mandato  → participación = porción del mandante (cuenta 28150601, leída)
   * Aplica además: recaudo (RC/13050501) que libera el disponible proporcional,
   * factura del tercero (FC/2335) que concilia y genera la Orden de Pago, y pago
   * al tercero (RP/banco) que registra el egreso. Idempotente por FV/RC/FC/RP;
   * con apply=false solo previsualiza.
   */
  static async importMovimiento(rows: string[][], apply: boolean, accounts?: ParticipationAccounts) {
    const acc = accounts ?? await ParticipationsService.loadAccounts()
    const mov = parseAccountingMovement(rows, acc)
    if (!mov.sales.length && !mov.collections.length && !mov.thirdInvoices.length && !mov.payments.length)
      throw Object.assign(
        new Error('El reporte no tiene movimientos de participaciones (ventas 41, recaudo 13050501, factura tercero 2335, pagos 1120/1110) con las columnas esperadas'),
        { statusCode: 400 },
      )
    const collByFv = new Map(mov.collections.map(c => [normalizeInvoiceNumber(c.fv), c]))
    // NC/ND ajustan el neto: solo las que referencian la FV en su descripción.
    const sumByFv = (list: { amount: number; fvRef: string | null }[]) => {
      const m = new Map<string, number>()
      for (const n of list) if (n.fvRef) m.set(normalizeInvoiceNumber(n.fvRef), money((m.get(normalizeInvoiceNumber(n.fvRef)) ?? 0) + n.amount))
      return m
    }
    const ncByFv = sumByFv(mov.creditNotes)
    const ndByFv = sumByFv(mov.debitNotes)

    // Configuraciones activas con tercero (servicio y mandato)
    const { data: configs, error } = await supabase
      .from('service_participations')
      .select('id, participation_type, percentage, fixed_value, start_date, end_date, active, has_third_party, contract_type, company_service:company_services(companies(id, name, nit)), third_party:third_parties(identification, name)')
      .eq('has_third_party', true)
      .eq('active', true)
    if (error) throw error

    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const cfgList = (configs ?? []).map((cf: any) => {
      const cs = one(cf.company_service); const co = one(cs?.companies); const tp = one(cf.third_party)
      return {
        id:            cf.id as string,
        contract_type: (cf.contract_type ?? 'servicio') as 'servicio' | 'mandato',
        type:          (cf.participation_type ?? 'percentage') as 'percentage' | 'fixed',
        percentage:    Number(cf.percentage),
        fixed_value:   cf.fixed_value != null ? Number(cf.fixed_value) : null,
        start_date:    cf.start_date as string | null,
        end_date:      cf.end_date as string | null,
        company_id:    co?.id ?? null,
        company_name:  co?.name ?? '—',
        nit:           co?.nit ?? '',
        tercero_name:  stripAccents(String(tp?.name ?? '')),
      }
    })

    type Res = {
      fv: string; client: string; tercero?: string; contract?: string
      outcome: 'matched' | 'no_config' | 'ambiguous' | 'no_amount'
      base?: number; credit_note?: number; debit_note?: number; net?: number
      participation_value?: number; collected?: number; available?: number
      status?: string; note?: string
    }
    const results: Res[] = []
    const toWrite: any[] = []
    const causadasFv = new Set<string>()   // FV creadas/actualizadas en este informe

    for (const s of mov.sales) {
      const inWindow = (cf: typeof cfgList[number]) =>
        (!cf.start_date || !s.iso || cf.start_date <= s.iso) &&
        (!cf.end_date   || !s.iso || cf.end_date   >= s.iso)
      let candidates = cfgList.filter(cf => nitMatch(cf.nit, s.clientNit) && inWindow(cf))
      // Varias configs del mismo cliente → desempata por el nombre del tercero
      if (candidates.length > 1) {
        const desc = stripAccents(s.descripcion)
        const byName = candidates.filter(cf => cf.tercero_name && desc.includes(cf.tercero_name))
        if (byName.length === 1) candidates = byName
      }

      let cfg: typeof cfgList[number] | null = null
      let outcome: Res['outcome'] = 'no_config'
      let note: string | undefined
      if (candidates.length === 1)    { cfg = candidates[0]!; outcome = 'matched' }
      else if (candidates.length > 1) { outcome = 'ambiguous'; note = `${candidates.length} configuraciones del cliente` }

      const res: Res = {
        fv: s.fv, client: s.clientName || cfg?.company_name || '—',
        tercero: cfg?.tercero_name || undefined, contract: cfg?.contract_type,
        outcome, note, base: s.base,
      }

      if (cfg) {
        const isMandate = cfg.contract_type === 'mandato'
        // Cada FV es servicio O mandato (no ambos):
        //  · mandato  → el tercero recibe la porción de las cuentas de mandato
        //               (28150601/28051001) TAL CUAL, sin IVA y sin aplicar %.
        //               Finto se queda con su parte (cuenta 41, con IVA).
        //  · servicio → base gravable ("Valor base" del IVA; respaldo a la 41) × %.
        const serviceBase = s.taxBase > 0 ? s.taxBase : s.income
        const base = isMandate ? s.mandate : serviceBase
        if (base <= 0) {
          res.outcome = 'no_amount'
          res.note = isMandate ? 'FV sin porción de mandato (28150601/28051001)' : 'FV sin base de servicio (Valor base / cuenta 41)'
          results.push(res); continue
        }
        // Valor neto = base − notas crédito + notas débito (ligadas a esta FV)
        const nc  = ncByFv.get(normalizeInvoiceNumber(s.fv)) ?? 0
        const nd  = ndByFv.get(normalizeInvoiceNumber(s.fv)) ?? 0
        const net = Math.max(0, money(base - nc + nd))
        const participationValue = isMandate ? net
          : (cfg.type === 'fixed' ? (cfg.fixed_value ?? 0) : money(net * cfg.percentage / 100))
        // Valor de factura para el % de recaudo: mandato = total facturado
        // (ingreso Finto + porción del tercero); servicio = base del servicio.
        const invoiceValue = isMandate ? s.base : serviceBase
        // Recaudo del cliente (RC) de este mismo informe → libera el disponible
        const coll      = collByFv.get(normalizeInvoiceNumber(s.fv))
        const collected = coll?.collected ?? 0
        const available = availableParticipation({ type: 'percentage', participationValue, invoiceValue, collected })
        const status = deriveInvoiceStatus({
          finto_invoice: s.fv, finto_invoice_value: invoiceValue, collected,
          available_for_payment: available, participation_value: participationValue,
        })
        res.base = base
        res.credit_note = nc
        res.debit_note = nd
        res.net = net
        res.participation_value = participationValue
        res.collected = collected
        res.available = available
        res.status = status
        toWrite.push({
          participation_id:      cfg.id,
          company_id:            cfg.company_id,
          finto_invoice:         s.fv,
          finto_invoice_date:    s.iso || null,
          finto_invoice_value:   invoiceValue,
          credit_note_value:     nc,
          debit_note_value:      nd,
          contract_type:         cfg.contract_type,
          participation_type:    cfg.type,
          percentage:            cfg.type === 'fixed' ? 0 : cfg.percentage,
          fixed_value:           cfg.type === 'fixed' && !isMandate ? cfg.fixed_value : null,
          participation_value:   participationValue,
          collected,
          cash_receipts:         coll?.receipts.join(', ') ?? null,
          available_for_payment: available,
          status,
          _period:               s.iso ? s.iso.slice(0, 7) : null,
        })
        causadasFv.add(normalizeInvoiceNumber(s.fv))
      }
      results.push(res)
    }

    let created = 0, updated = 0, recaudo_updated = 0, third_invoice_matched = 0, paid_matched = 0
    // Documentos para Cruce/Pagos (se persisten al final del apply)
    const docs: any[] = []
    if (apply) {
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
          .select('id, collected, cash_receipts, available_for_payment')
          .eq('finto_invoice', w.finto_invoice)
          .maybeSingle()
        if (byFv) {
          if ((byFv as any).collected > 0) {
            w.collected = (byFv as any).collected
            w.cash_receipts = (byFv as any).cash_receipts
            w.available_for_payment = (byFv as any).available_for_payment
          }
          const { error: upErr } = await supabase.from('invoice_participations').update(w).eq('id', byFv.id)
          if (upErr) throw upErr
          updated++
          continue
        }

        // 2. OC mensual pendiente (sin FV) del mismo servicio/periodo → adjunta la FV
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
          const { error: upErr } = await supabase.from('invoice_participations').update(w).eq('id', placeholder.id)
          if (upErr) throw upErr
          updated++
          continue
        }

        // 3. Sin OC previa → nueva OC para la FV
        w.purchase_order = await nextOc(period)
        const { error: insErr } = await supabase.from('invoice_participations').insert(w)
        if (insErr) throw insErr
        created++
      }

      // ── Recaudo (RC): pagos de clientes sobre la cartera 13050501 ───────────
      // Un RC se asigna siguiendo la jerarquía:
      //  1. Si trae FV explícita en descripción → atiende esa factura primero.
      //  2. Si trae mes explícito en descripción (ej: 'pago mayo') → atiende la FV de ese período.
      //  3. Por defecto / remanente → FIFO (factura más antigua primero por finto_invoice_date / period).
      // Idempotente: si el comprobante RC ya figura en cash_receipts de alguna factura, no se vuelve a sumar.
      if (mov.collections.length) {
        const { data: openInvoices } = await supabase
          .from('invoice_participations')
          .select('id, finto_invoice, finto_invoice_date, finto_invoice_value, period, collected, cash_receipts, participation_value, participation_type, company:companies(nit)')

        const clientNitOf = (ip: any) => normalizeNit(String(one(ip.company)?.nit ?? ''))
        const hasRc = (receipts: string | null, rc: string) =>
          String(receipts ?? '').split(',').some(s => normalizeInvoiceNumber(s) === normalizeInvoiceNumber(rc))

        const rcState = new Map<string, { collected: number; receipts: string[] }>()
        const stateOfRc = (ip: any) => {
          let st = rcState.get(ip.id)
          if (!st) {
            st = {
              collected: Number(ip.collected ?? 0),
              receipts:  String(ip.cash_receipts ?? '').split(',').map(s => s.trim()).filter(Boolean),
            }
            rcState.set(ip.id, st)
          }
          return st
        }

        const rcDoc = (c: MovCollection, applied: number, matched: boolean, appliedFvs: string[], note?: string) => docs.push({
          doc_type: 'RC',
          comprobante: c.receipt,
          fv_ref: appliedFvs.length ? appliedFvs.join(', ') : (c.fvRef ?? ''),
          tercero_nit: c.clientNit || null,
          tercero_name: c.clientName || null,
          period: c.iso ? c.iso.slice(0, 7) : null,
          doc_date: c.iso || null,
          amount: c.amount,
          applied,
          matched,
          note: note ?? (matched ? null : 'Sin facturas pendientes del cliente'),
        })

        for (const c of mov.collections) {
          if (!normalizeNit(c.clientNit)) {
            rcDoc(c, 0, false, [], 'RC sin NIT de cliente')
            continue
          }

          const mine = (openInvoices ?? []).filter((ip: any) => {
            const nit = clientNitOf(ip)
            return nit && nitMatch(nit, c.clientNit)
          })

          if (!mine.length) {
            rcDoc(c, 0, false, [], 'Sin facturas configuradas para este cliente')
            continue
          }

          // Idempotencia: si este RC ya figura en alguna factura del cliente, ya se aplicó
          if (mine.some((ip: any) => hasRc(ip.cash_receipts, c.receipt))) continue

          // FIFO: factura más antigua primero (fecha de venta, luego periodo)
          const ordered = [...mine].sort((a: any, b: any) =>
            String(a.finto_invoice_date ?? a.period ?? '').localeCompare(String(b.finto_invoice_date ?? b.period ?? ''))
          )

          // Prioridad 1: Factura explícita en descripción
          if (c.fvRef) {
            const idx = ordered.findIndex((ip: any) => normalizeInvoiceNumber(ip.finto_invoice ?? '') === normalizeInvoiceNumber(c.fvRef!))
            if (idx > 0) ordered.unshift(ordered.splice(idx, 1)[0]!)
          }
          // Prioridad 2: Mes explícito en descripción (si no hubo FV o la FV no coincidió)
          else if (c.monthRef) {
            const idx = ordered.findIndex((ip: any) => {
              const p = ip.period || (ip.finto_invoice_date ? String(ip.finto_invoice_date).slice(0, 7) : '')
              return p === c.monthRef
            })
            if (idx > 0) ordered.unshift(ordered.splice(idx, 1)[0]!)
          }

          let remaining = c.amount
          let appliedTotal = 0
          const appliedFvs: string[] = []

          for (const ip of ordered) {
            if (remaining <= 0.01) break
            const st = stateOfRc(ip)
            const invoiceVal = Number(ip.finto_invoice_value ?? 0)
            const owed = money(invoiceVal - st.collected)
            if (owed <= 0.01) continue

            const applied = money(Math.min(remaining, owed))
            st.collected = money(st.collected + applied)
            if (!st.receipts.some(r => normalizeInvoiceNumber(r) === normalizeInvoiceNumber(c.receipt))) {
              st.receipts.push(c.receipt)
            }
            remaining = money(remaining - applied)
            appliedTotal = money(appliedTotal + applied)
            if (ip.finto_invoice) appliedFvs.push(ip.finto_invoice)

            // Recalcular disponible para pago de participación
            const partValue = Number(ip.participation_value ?? 0)
            const available = availableParticipation({
              type: ip.participation_type || 'percentage',
              participationValue: partValue,
              invoiceValue: invoiceVal,
              collected: st.collected,
            })

            const { error: upErr } = await supabase
              .from('invoice_participations')
              .update({
                collected: st.collected,
                cash_receipts: st.receipts.join(', '),
                available_for_payment: available,
                updated_at: new Date().toISOString(),
              })
              .eq('id', ip.id)
            if (upErr) throw upErr
            await ParticipationsService.recomputeStatus(ip.id)
            recaudo_updated++
          }

          const matched = appliedTotal > 0
          rcDoc(c, appliedTotal, matched, appliedFvs, remaining > 0.01 ? 'Saldo restante sin aplicar (excede facturas pendientes)' : undefined)
        }
      }

      // ── Factura del tercero (FC): una FC puede cubrir varias participaciones
      //    del mismo tercero (mismo NIT). Se reparte FIFO (facturas más antiguas
      //    primero) entre sus participaciones aún sin conciliar; permite
      //    cobertura parcial (acumula en `third_party_invoice_value`) y guarda la
      //    lista de FC en `third_party_invoice`. Cuando una participación queda
      //    conciliada (FC acumulada ≈ participación) genera su Orden de Pago (OP).
      //    Idempotente: una FC ya registrada no se resuma. Si la FC trae el FV en
      //    su descripción, esa factura se atiende primero. ──
      if (mov.thirdInvoices.length) {
        const { data: openFc } = await supabase
          .from('invoice_participations')
          .select('id, finto_invoice, finto_invoice_date, period, participation_value, third_party_invoice, third_party_invoice_value, payment_order, participation:service_participations(third_party:third_parties(identification))')
          .gt('participation_value', 0)
        const nitOf = (ip: any) => normalizeNit(String(one(one(ip.participation)?.third_party)?.identification ?? ''))
        const hasFc = (doc: string | null, fc: string) =>
          String(doc ?? '').split(',').some(s => normalizeInvoiceNumber(s) === normalizeInvoiceNumber(fc))
        // Estado local de conciliación por participación (acumula varias FC)
        const fcState = new Map<string, { billed: number; docs: string[]; order: string | null }>()
        const stateOf = (ip: any) => {
          let st = fcState.get(ip.id)
          if (!st) {
            st = {
              billed: Number(ip.third_party_invoice_value ?? 0),
              docs:   String(ip.third_party_invoice ?? '').split(',').map(s => s.trim()).filter(Boolean),
              order:  ip.payment_order ?? null,
            }
            fcState.set(ip.id, st)
          }
          return st
        }
        // Secuencia de OP por periodo (evita colisiones al generar varias en un import)
        const opSeqByPeriod = new Map<string, number>()
        const nextOp = async (period: string | null): Promise<string> => {
          const [y, m] = (period ?? '2026-01').split('-')
          const key = `${y}${m}`
          if (!opSeqByPeriod.has(key)) {
            const { count } = await supabase
              .from('invoice_participations')
              .select('id', { count: 'exact', head: true })
              .ilike('payment_order', `OP-${key}-%`)
            opSeqByPeriod.set(key, count ?? 0)
          }
          const seq = opSeqByPeriod.get(key)! + 1
          opSeqByPeriod.set(key, seq)
          return formatPaymentOrder(Number(y), Number(m), seq)
        }

        const fcDoc = (fc: any, applied: number, matched: boolean, note?: string) => docs.push({
          doc_type: 'FC', comprobante: fc.doc, fv_ref: fc.fvRef ?? '',
          tercero_nit: fc.terceroNit || null, tercero_name: fc.terceroName || null,
          period: fc.iso ? fc.iso.slice(0, 7) : null, doc_date: fc.iso || null,
          amount: fc.amount, applied, matched, note: note ?? null,
        })
        for (const fc of mov.thirdInvoices) {
          if (!normalizeNit(fc.terceroNit)) { fcDoc(fc, 0, false, 'FC sin NIT de tercero'); continue }
          const mine = (openFc ?? []).filter((ip: any) => {
            const nit = nitOf(ip)
            return nit && nitMatch(nit, fc.terceroNit)
          })
          if (!mine.length) { fcDoc(fc, 0, false, 'sin participación del tercero'); continue }
          // Idempotencia: si esta FC ya figura en alguna participación del tercero
          // ya se repartió → no volver a sumarla (no se re-registra el documento).
          if (mine.some((ip: any) => hasFc(ip.third_party_invoice, fc.doc))) continue

          // FIFO: factura más antigua primero (fecha de venta, luego periodo).
          const ordered = [...mine].sort((a: any, b: any) =>
            String(a.finto_invoice_date ?? a.period ?? '').localeCompare(String(b.finto_invoice_date ?? b.period ?? '')))
          // El FV indicado en la FC se atiende primero.
          if (fc.fvRef) {
            const i = ordered.findIndex((ip: any) => normalizeInvoiceNumber(ip.finto_invoice ?? '') === normalizeInvoiceNumber(fc.fvRef!))
            if (i > 0) ordered.unshift(ordered.splice(i, 1)[0]!)
          }

          let remaining = fc.amount
          let appliedAny = false
          for (const ip of ordered) {
            if (remaining <= 0.01) break
            const st = stateOf(ip)
            const owed = money(Number(ip.participation_value ?? 0) - st.billed)
            if (owed <= 0.01) continue
            const applied = money(Math.min(remaining, owed))
            st.billed = money(st.billed + applied)
            st.docs.push(fc.doc)
            remaining = money(remaining - applied)
            appliedAny = true
            // Concilia (FC acumulada ≈ participación) → genera OP si aún no tiene.
            const conciliated = validateThirdPartyInvoice(Number(ip.participation_value), {
              number: st.docs.join(', '), value: st.billed,
            }).ok
            if (conciliated && !st.order)
              st.order = await nextOp(ip.period ?? (ip.finto_invoice_date ? String(ip.finto_invoice_date).slice(0, 7) : null))
            const { error: upErr } = await supabase
              .from('invoice_participations')
              .update({
                third_party_invoice:       st.docs.join(', '),
                third_party_invoice_date:  fc.iso || null,
                third_party_invoice_value: st.billed,
                payment_order:             st.order,
                updated_at:                new Date().toISOString(),
              })
              .eq('id', ip.id)
            if (upErr) throw upErr
            await ParticipationsService.recomputeStatus(ip.id)
          }
          if (appliedAny) third_invoice_matched++
          fcDoc(fc, money(fc.amount - remaining), appliedAny, remaining > 0.01 ? 'saldo sin conciliar' : undefined)
        }
      }

      // ── Pago al tercero (RP): un RP puede cubrir varias participaciones del
      //    mismo tercero. Se reparte FIFO (facturas más antiguas primero) entre
      //    sus participaciones con disponible sin pagar; permite pago parcial
      //    (acumula en `egress_voucher_value`) y guarda la lista de RP aplicados
      //    en `egress_voucher`. Idempotente: un RP ya registrado no se resuma.
      //    Si el RP trae el FV en su descripción, esa factura se atiende primero. ──
      if (mov.payments.length) {
        const { data: openRp } = await supabase
          .from('invoice_participations')
          .select('id, finto_invoice, finto_invoice_date, period, available_for_payment, egress_voucher, egress_voucher_value, participation:service_participations(third_party:third_parties(identification))')
          .gt('available_for_payment', 0)
        const nitOf = (ip: any) => normalizeNit(String(one(one(ip.participation)?.third_party)?.identification ?? ''))
        const hasRp = (voucher: string | null, rp: string) =>
          String(voucher ?? '').split(',').some(s => normalizeInvoiceNumber(s) === normalizeInvoiceNumber(rp))
        // Estado local de pago por participación (se acumula al repartir varios RP)
        const paidState = new Map<string, { paid: number; vouchers: string[] }>()
        const stateOf = (ip: any) => {
          let st = paidState.get(ip.id)
          if (!st) {
            st = {
              paid:     Number(ip.egress_voucher_value ?? 0),
              vouchers: String(ip.egress_voucher ?? '').split(',').map(s => s.trim()).filter(Boolean),
            }
            paidState.set(ip.id, st)
          }
          return st
        }

        const rpDoc = (p: any, applied: number, matched: boolean, note?: string) => docs.push({
          doc_type: 'RP', comprobante: p.rp, fv_ref: p.fvRef ?? '',
          tercero_nit: p.terceroNit || null, tercero_name: null,
          period: p.iso ? p.iso.slice(0, 7) : null, doc_date: p.iso || null,
          amount: p.amount, applied, matched, note: note ?? null,
        })
        for (const p of mov.payments) {
          if (!normalizeNit(p.terceroNit)) { rpDoc(p, 0, false, 'RP sin NIT de tercero'); continue }
          const mine = (openRp ?? []).filter((ip: any) => {
            const nit = nitOf(ip)
            return nit && nitMatch(nit, p.terceroNit)
          })
          if (!mine.length) { rpDoc(p, 0, false, 'sin participación del tercero'); continue }
          // Idempotencia: si este RP ya figura en alguna participación del tercero
          // el pago ya se repartió → no volver a sumarlo (no se re-registra).
          if (mine.some((ip: any) => hasRp(ip.egress_voucher, p.rp))) continue

          // FIFO: factura más antigua primero (fecha de venta, luego periodo).
          const ordered = [...mine].sort((a: any, b: any) =>
            String(a.finto_invoice_date ?? a.period ?? '').localeCompare(String(b.finto_invoice_date ?? b.period ?? '')))
          // El FV indicado en el RP se atiende primero
          if (p.fvRef) {
            const i = ordered.findIndex((ip: any) => normalizeInvoiceNumber(ip.finto_invoice ?? '') === normalizeInvoiceNumber(p.fvRef!))
            if (i > 0) ordered.unshift(ordered.splice(i, 1)[0]!)
          }

          let remaining = p.amount
          let appliedAny = false
          for (const ip of ordered) {
            if (remaining <= 0.01) break
            const st = stateOf(ip)
            const owed = money(Number(ip.available_for_payment ?? 0) - st.paid)
            if (owed <= 0.01) continue
            const applied = money(Math.min(remaining, owed))
            st.paid = money(st.paid + applied)
            st.vouchers.push(p.rp)
            remaining = money(remaining - applied)
            appliedAny = true
            const { error: upErr } = await supabase
              .from('invoice_participations')
              .update({
                egress_voucher:       st.vouchers.join(', '),
                egress_voucher_date:  p.iso || null,
                egress_voucher_value: st.paid,
                updated_at:           new Date().toISOString(),
              })
              .eq('id', ip.id)
            if (upErr) throw upErr
            await ParticipationsService.recomputeStatus(ip.id)
          }
          if (appliedAny) paid_matched++
          rpDoc(p, money(p.amount - remaining), appliedAny, remaining > 0.01 ? 'saldo sin aplicar' : undefined)
        }
      }

      // ── Documentos FV / RC / NC / ND para Cruce y Pagos ──────────────────────
      const salesByFv = new Map(mov.sales.map(s => [normalizeInvoiceNumber(s.fv), s]))
      for (const r of results) {
        const s = salesByFv.get(normalizeInvoiceNumber(r.fv))
        const matched = r.outcome === 'matched'
        docs.push({
          doc_type: 'FV', comprobante: r.fv, fv_ref: '',
          tercero_nit: s?.clientNit || null, tercero_name: r.client || s?.clientName || null,
          period: s?.iso ? s.iso.slice(0, 7) : null, doc_date: s?.iso || null,
          amount: r.base ?? s?.base ?? 0, applied: matched ? (r.base ?? s?.base ?? 0) : 0,
          matched, note: matched ? null : (r.note ?? r.outcome),
        })
      }
      for (const n of mov.creditNotes) docs.push({
        doc_type: 'NC', comprobante: n.comprobante, fv_ref: n.fvRef ?? '',
        tercero_nit: n.clientNit || null, tercero_name: n.clientName || null,
        period: n.iso ? n.iso.slice(0, 7) : null, doc_date: n.iso || null,
        amount: n.amount, applied: n.fvRef ? n.amount : 0, matched: !!n.fvRef,
        note: n.fvRef ? null : 'sin FV en la descripción',
      })
      for (const n of mov.debitNotes) docs.push({
        doc_type: 'ND', comprobante: n.comprobante, fv_ref: n.fvRef ?? '',
        tercero_nit: n.clientNit || null, tercero_name: n.clientName || null,
        period: n.iso ? n.iso.slice(0, 7) : null, doc_date: n.iso || null,
        amount: n.amount, applied: n.fvRef ? n.amount : 0, matched: !!n.fvRef,
        note: n.fvRef ? null : 'sin FV en la descripción',
      })

      // Persistir documentos (upsert por tipo+comprobante+FV)
      if (docs.length) {
        const rows = docs.map(d => ({ ...d, updated_at: new Date().toISOString() }))
        const { error: docErr } = await supabase
          .from('siigo_documents')
          .upsert(rows, { onConflict: 'doc_type,comprobante,fv_ref' })
        if (docErr) throw docErr
      }
    } else {
      for (const w of toWrite) delete w._period
    }

    const summary = {
      sales:          mov.sales.length,
      matched:        results.filter(r => r.outcome === 'matched').length,
      no_config:      results.filter(r => r.outcome === 'no_config').length,
      ambiguous:      results.filter(r => r.outcome === 'ambiguous').length,
      no_amount:      results.filter(r => r.outcome === 'no_amount').length,
      collections:    mov.collections.length,
      credit_notes:   mov.creditNotes.length,
      debit_notes:    mov.debitNotes.length,
      third_invoices: mov.thirdInvoices.length,
      payments:       mov.payments.length,
      participation_total: money(toWrite.reduce((a, w) => a + Number(w.participation_value ?? 0), 0)),
      created, updated, recaudo_updated, third_invoice_matched, paid_matched,
    }
    // NC/ND: las que traen el FV en la descripción SÍ ajustan el neto (marcadas
    // con `applied`); las que no, solo se informan para revisión manual.
    const mapNote = (n: { comprobante: string; clientName: string; clientNit: string; amount: number; fvRef: string | null }) => ({
      comprobante: n.comprobante, client: n.clientName || n.clientNit,
      amount: n.amount, fv: n.fvRef ?? null, applied: !!n.fvRef,
    })
    const creditNotes = mov.creditNotes.map(mapNote)
    const debitNotes  = mov.debitNotes.map(mapNote)
    return { summary, results, creditNotes, debitNotes, applied: apply }
  }

  // ── Cruce y Pagos (sobre siigo_documents) ────────────────────────────────────

  /**
   * Cruce: documentos NO cruzados del último import (alertas). Nunca genera OC.
   * Filtros: tipo (FV/RC/NC/ND/FC/RP), periodo (yyyy-mm), NIT (cliente o tercero).
   */
  static async crossingAlerts(f: { doc_type?: string; period?: string; nit?: string } = {}) {
    let q = supabase
      .from('siigo_documents')
      .select('*')
      .eq('matched', false)
      .order('doc_date', { ascending: false })
      .limit(1000)
    if (f.doc_type) q = q.eq('doc_type', f.doc_type)
    if (f.period)   q = q.eq('period', f.period)
    if (f.nit)      q = q.eq('tercero_nit', f.nit)
    const { data, error } = await q
    if (error) throw error
    const rows = data ?? []
    const summary = {
      total:  rows.length,
      by_type: rows.reduce((a: Record<string, number>, r: any) => { a[r.doc_type] = (a[r.doc_type] ?? 0) + 1; return a }, {}),
    }
    return { summary, alerts: rows }
  }

  /**
   * Pagos: RC y RP con saldo sin cruzar (parcial o total). Filtros por Tercero,
   * Cliente, periodo (mes), NIT y búsqueda general.
   */
  static async paymentBalances(f: {
    doc_type?: 'RC' | 'RP'
    period?: string
    nit?: string
    client?: string
    third_party?: string
    search?: string
  } = {}) {
    let q = supabase
      .from('siigo_documents')
      .select('*')
      .in('doc_type', f.doc_type ? [f.doc_type] : ['RC', 'RP'])
      .gt('saldo', 0)
      .order('doc_date', { ascending: false })
      .limit(2000)

    if (f.period) q = q.eq('period', f.period)
    if (f.nit)    q = q.eq('tercero_nit', f.nit)

    const { data, error } = await q
    if (error) throw error
    let rows = data ?? []

    // Filtro por Cliente (aplica a RC donde tercero_nit o tercero_name es el cliente)
    if (f.client) {
      const c = f.client.trim().toLowerCase()
      rows = rows.filter((r: any) => {
        if (r.doc_type !== 'RC') return false
        return (
          (r.tercero_nit && String(r.tercero_nit).toLowerCase().includes(c)) ||
          (r.tercero_name && String(r.tercero_name).toLowerCase().includes(c))
        )
      })
    }

    // Filtro por Tercero (aplica a RP donde tercero_nit o tercero_name es el mandante/proveedor)
    if (f.third_party) {
      const tp = f.third_party.trim().toLowerCase()
      rows = rows.filter((r: any) => {
        if (r.doc_type !== 'RP') return false
        return (
          (r.tercero_nit && String(r.tercero_nit).toLowerCase().includes(tp)) ||
          (r.tercero_name && String(r.tercero_name).toLowerCase().includes(tp))
        )
      })
    }

    // Búsqueda de texto libre (comprobante, fv_ref, NIT, nombre)
    if (f.search) {
      const s = f.search.trim().toLowerCase()
      rows = rows.filter((r: any) =>
        (r.comprobante && String(r.comprobante).toLowerCase().includes(s)) ||
        (r.fv_ref && String(r.fv_ref).toLowerCase().includes(s)) ||
        (r.tercero_nit && String(r.tercero_nit).toLowerCase().includes(s)) ||
        (r.tercero_name && String(r.tercero_name).toLowerCase().includes(s))
      )
    }

    // Opciones de filtro para desplegables (extraídas de todos los siigo_documents con saldo)
    const { data: allUncrossed } = await supabase
      .from('siigo_documents')
      .select('doc_type, tercero_nit, tercero_name, period')
      .in('doc_type', ['RC', 'RP'])
      .gt('saldo', 0)

    const clientMap = new Map<string, string>()
    const tpMap = new Map<string, string>()
    const periodsSet = new Set<string>()

    for (const r of allUncrossed ?? []) {
      if (r.period) periodsSet.add(r.period)
      const nit = (r.tercero_nit ?? '').trim()
      const name = (r.tercero_name ?? '').trim()
      const label = name ? `${name}${nit ? ` (${nit})` : ''}` : nit
      if (r.doc_type === 'RC' && (nit || name)) {
        clientMap.set(nit || name, label)
      } else if (r.doc_type === 'RP' && (nit || name)) {
        tpMap.set(nit || name, label)
      }
    }

    const clients = Array.from(clientMap.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))

    const third_parties = Array.from(tpMap.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))

    const periods = Array.from(periodsSet).sort().reverse()

    const sum = (t: string) => money(rows.filter((r: any) => r.doc_type === t).reduce((a: number, r: any) => a + Number(r.saldo ?? 0), 0))
    const rc_count = rows.filter((r: any) => r.doc_type === 'RC').length
    const rp_count = rows.filter((r: any) => r.doc_type === 'RP').length
    const rc_saldo = sum('RC')
    const rp_saldo = sum('RP')

    return {
      summary: {
        count: rows.length,
        rc_count,
        rp_count,
        rc_saldo,
        rp_saldo,
        total_saldo: money(rc_saldo + rp_saldo),
      },
      items: rows,
      filter_options: {
        clients,
        third_parties,
        periods,
      },
    }
  }

  /**
   * Obtiene las facturas pendientes de cobro de un cliente (finto_invoice_value > collected),
   * ordenadas cronológicamente (FIFO).
   */
  static async getPendingInvoicesByClient(clientNit: string) {
    if (!clientNit) return []
    const nit = normalizeNit(clientNit)
    if (!nit) return []

    // Buscar compañías que coincidan por NIT
    const { data: companies, error: coErr } = await supabase
      .from('companies')
      .select('id, name, nit')
    if (coErr) throw coErr

    const targetCompany = (companies ?? []).find(co => nitMatch(co.nit, nit))
    if (!targetCompany) return []

    const { data, error } = await supabase
      .from('invoice_participations')
      .select('id, finto_invoice, finto_invoice_date, finto_invoice_value, period, collected, cash_receipts, available_for_payment, status')
      .eq('company_id', targetCompany.id)
      .order('finto_invoice_date', { ascending: true })

    if (error) throw error

    return (data ?? [])
      .map((ip: any) => {
        const val = Number(ip.finto_invoice_value ?? 0)
        const coll = Number(ip.collected ?? 0)
        const balance = Math.max(0, money(val - coll))
        return {
          ...ip,
          balance,
          client_name: targetCompany.name,
          client_nit: targetCompany.nit,
        }
      })
      .filter((ip: any) => ip.balance > 0.01)
  }

  /**
   * Aplica un comprobante de recaudo RC de forma manual a una o más facturas seleccionadas.
   */
  static async applyManualPayment(input: {
    comprobante: string
    client_nit: string
    allocations: { invoice_id: string; amount: number }[]
  }) {
    const { comprobante, allocations } = input
    if (!allocations.length) throw Object.assign(new Error('Debe asignar al menos una factura'), { statusCode: 400 })

    const invoiceIds = allocations.map(a => a.invoice_id)
    const { data: invoices, error } = await supabase
      .from('invoice_participations')
      .select('id, finto_invoice, finto_invoice_value, participation_value, participation_type, collected, cash_receipts')
      .in('id', invoiceIds)
    if (error) throw error

    let totalApplied = 0
    const appliedFvs: string[] = []

    for (const alloc of allocations) {
      if (alloc.amount <= 0) continue
      const ip = (invoices ?? []).find((i: any) => i.id === alloc.invoice_id)
      if (!ip) continue
      const currentColl = Number((ip as any).collected ?? 0)
      const newColl = money(currentColl + alloc.amount)
      const existingReceipts = String((ip as any).cash_receipts ?? '').split(',').map(s => s.trim()).filter(Boolean)
      if (!existingReceipts.some(r => normalizeInvoiceNumber(r) === normalizeInvoiceNumber(comprobante))) {
        existingReceipts.push(comprobante)
      }

      const invVal = Number((ip as any).finto_invoice_value ?? 0)
      const partVal = Number((ip as any).participation_value ?? 0)
      const available = availableParticipation({
        type: (ip as any).participation_type || 'percentage',
        participationValue: partVal,
        invoiceValue: invVal,
        collected: newColl,
      })

      const { error: upErr } = await supabase
        .from('invoice_participations')
        .update({
          collected: newColl,
          cash_receipts: existingReceipts.join(', '),
          available_for_payment: available,
          updated_at: new Date().toISOString(),
        })
        .eq('id', (ip as any).id)
      if (upErr) throw upErr
      await ParticipationsService.recomputeStatus((ip as any).id)

      totalApplied = money(totalApplied + alloc.amount)
      if ((ip as any).finto_invoice) appliedFvs.push((ip as any).finto_invoice)
    }

    // Actualizar siigo_documents si existe el comprobante
    const { data: doc } = await supabase
      .from('siigo_documents')
      .select('id, amount, applied')
      .eq('doc_type', 'RC')
      .eq('comprobante', comprobante)
      .maybeSingle()

    if (doc) {
      const docAmount = Number((doc as any).amount ?? totalApplied)
      const prevApplied = Number((doc as any).applied ?? 0)
      const newApplied = money(prevApplied + totalApplied)
      const remaining = Math.max(0, money(docAmount - newApplied))
      await supabase
        .from('siigo_documents')
        .update({
          applied: newApplied,
          matched: newApplied > 0,
          fv_ref: appliedFvs.join(', '),
          note: remaining > 0.01 ? 'Saldo restante' : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', (doc as any).id)
    }

    return { success: true, applied: totalApplied, invoices: appliedFvs }
  }

  /** Recalcula el estado de una participación por factura desde sus datos */
  static async recomputeStatus(id: string) {
    const { data: ip, error } = await supabase
      .from('invoice_participations')
      .select('finto_invoice, finto_invoice_value, collected, available_for_payment, participation_value, payment_order, egress_voucher, egress_voucher_value, third_party_invoice, third_party_invoice_value')
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

  /**
   * Obtiene el registro completo de una participación por factura por su ID.
   */
  static async getInvoiceParticipation(id: string) {
    const { data, error } = await supabase
      .from('invoice_participations')
      .select('*, participation:service_participations(third_party:third_parties(name, identification, tax_profile:tax_profiles(*)), company_service:company_services(services(name))), companies(name, nit)')
      .eq('id', id)
      .single()
    if (error || !data) throw Object.assign(new Error('Factura de participación no encontrada'), { statusCode: 404 })
    return data
  }

  /**
   * Actualiza manualmente los campos de las etapas 2, 3, 4 y 5 de una participación.
   * Recalcula automáticamente el valor disponible y el estado.
   */
  static async updateInvoiceParticipation(id: string, patch: Record<string, any>) {
    const { data: current, error: curErr } = await supabase
      .from('invoice_participations')
      .select('id, finto_invoice, finto_invoice_value, collected, participation_value, participation_type, status')
      .eq('id', id)
      .single()
    if (curErr || !current) throw Object.assign(new Error('Factura de participación no encontrada'), { statusCode: 404 })

    const updatePayload: Record<string, any> = { ...patch, updated_at: new Date().toISOString() }

    const coll = patch.collected !== undefined ? Number(patch.collected) : Number(current.collected ?? 0)
    const fintoVal = patch.finto_invoice_value !== undefined ? Number(patch.finto_invoice_value) : Number(current.finto_invoice_value ?? 0)
    const partVal = patch.participation_value !== undefined ? Number(patch.participation_value) : Number(current.participation_value ?? 0)

    // Recalcular disponible si cambia recaudo, valor de factura o participación
    if (patch.collected !== undefined || patch.finto_invoice_value !== undefined || patch.participation_value !== undefined) {
      updatePayload.available_for_payment = availableParticipation({
        type: current.participation_type || 'percentage',
        participationValue: partVal,
        invoiceValue: fintoVal,
        collected: coll,
      })
    }

    const { error: upErr } = await supabase
      .from('invoice_participations')
      .update(updatePayload)
      .eq('id', id)
    if (upErr) throw upErr

    // Sincronizar estado en siigo_documents si cambió la FV
    const oldFv = current.finto_invoice
    const now = new Date().toISOString()
    if (patch.finto_invoice === null && oldFv) {
      await supabase
        .from('siigo_documents')
        .update({
          matched: false,
          note: 'Desvinculada manualmente de OC',
          updated_at: now,
        })
        .eq('doc_type', 'FV')
        .eq('comprobante', oldFv)
    } else if (patch.finto_invoice && patch.finto_invoice !== oldFv) {
      await supabase
        .from('siigo_documents')
        .update({
          matched: true,
          note: 'Vinculada manualmente a OC',
          updated_at: now,
        })
        .eq('doc_type', 'FV')
        .eq('comprobante', patch.finto_invoice)

      if (oldFv) {
        await supabase
          .from('siigo_documents')
          .update({
            matched: false,
            note: 'Desvinculada manualmente de OC por reemplazo',
            updated_at: now,
          })
          .eq('doc_type', 'FV')
          .eq('comprobante', oldFv)
      }
    }

    // Recalcular estado de la factura derivado de los nuevos datos
    await ParticipationsService.recomputeStatus(id)

    // Devolver el registro completo actualizado
    const { data: updated, error: fetchErr } = await supabase
      .from('invoice_participations')
      .select('*, participation:service_participations(third_party:third_parties(name, identification, tax_profile:tax_profiles(*)), company_service:company_services(services(name))), companies(name, nit)')
      .eq('id', id)
      .single()
    if (fetchErr) throw fetchErr

    return updated
  }

  /**
   * Reasigna un monto de pago (recaudo) entre dos facturas del mismo cliente.
   */
  static async reallocatePayment(input: {
    from_invoice_id: string
    to_invoice_id: string
    amount: number
    comprobante?: string
  }) {
    const { from_invoice_id, to_invoice_id, amount, comprobante } = input
    if (from_invoice_id === to_invoice_id) {
      throw Object.assign(new Error('Las facturas de origen y destino deben ser distintas'), { statusCode: 400 })
    }

    const { data: fromInv, error: fromErr } = await supabase
      .from('invoice_participations')
      .select('id, finto_invoice, finto_invoice_value, collected, cash_receipts, participation_value, participation_type')
      .eq('id', from_invoice_id)
      .single()
    if (fromErr || !fromInv) throw Object.assign(new Error('Factura origen no encontrada'), { statusCode: 404 })

    const { data: toInv, error: toErr } = await supabase
      .from('invoice_participations')
      .select('id, finto_invoice, finto_invoice_value, collected, cash_receipts, participation_value, participation_type')
      .eq('id', to_invoice_id)
      .single()
    if (toErr || !toInv) throw Object.assign(new Error('Factura destino no encontrada'), { statusCode: 404 })

    const fromColl = Number(fromInv.collected ?? 0)
    if (amount > fromColl + 0.01) {
      throw Object.assign(new Error(`El monto a transferir (${amount}) supera el recaudo actual de la factura origen (${fromColl})`), { statusCode: 400 })
    }

    const newFromColl = Math.max(0, money(fromColl - amount))
    const newToColl = money(Number(toInv.collected ?? 0) + amount)

    // Ajustar comprobantes
    let fromReceipts = String(fromInv.cash_receipts ?? '').split(',').map(s => s.trim()).filter(Boolean)
    let toReceipts = String(toInv.cash_receipts ?? '').split(',').map(s => s.trim()).filter(Boolean)

    if (comprobante) {
      const compNorm = normalizeInvoiceNumber(comprobante)
      if (newFromColl <= 0.01) {
        fromReceipts = fromReceipts.filter(r => normalizeInvoiceNumber(r) !== compNorm)
      }
      if (!toReceipts.some(r => normalizeInvoiceNumber(r) === compNorm)) {
        toReceipts.push(comprobante)
      }
    }

    const fromAvail = availableParticipation({
      type: fromInv.participation_type || 'percentage',
      participationValue: Number(fromInv.participation_value ?? 0),
      invoiceValue: Number(fromInv.finto_invoice_value ?? 0),
      collected: newFromColl,
    })

    const toAvail = availableParticipation({
      type: toInv.participation_type || 'percentage',
      participationValue: Number(toInv.participation_value ?? 0),
      invoiceValue: Number(toInv.finto_invoice_value ?? 0),
      collected: newToColl,
    })

    const now = new Date().toISOString()
    const { error: upFromErr } = await supabase
      .from('invoice_participations')
      .update({
        collected: newFromColl,
        cash_receipts: fromReceipts.join(', '),
        available_for_payment: fromAvail,
        updated_at: now,
      })
      .eq('id', from_invoice_id)
    if (upFromErr) throw upFromErr

    const { error: upToErr } = await supabase
      .from('invoice_participations')
      .update({
        collected: newToColl,
        cash_receipts: toReceipts.join(', '),
        available_for_payment: toAvail,
        updated_at: now,
      })
      .eq('id', to_invoice_id)
    if (upToErr) throw upToErr

    await ParticipationsService.recomputeStatus(from_invoice_id)
    await ParticipationsService.recomputeStatus(to_invoice_id)

    // Si el comprobante figura en siigo_documents, actualizar referencia a la nueva factura
    if (comprobante) {
      const { data: doc } = await supabase
        .from('siigo_documents')
        .select('id, fv_ref')
        .eq('doc_type', 'RC')
        .eq('comprobante', comprobante)
        .maybeSingle()

      if (doc) {
        const refs = String(doc.fv_ref ?? '').split(',').map(s => s.trim()).filter(Boolean)
        const targetFv = toInv.finto_invoice
        if (targetFv && !refs.some(r => normalizeInvoiceNumber(r) === normalizeInvoiceNumber(targetFv))) {
          refs.push(targetFv)
        }
        await supabase
          .from('siigo_documents')
          .update({
            fv_ref: refs.join(', '),
            note: 'Reasignado manualmente',
            updated_at: now,
          })
          .eq('id', doc.id)
      }
    }

    return {
      success: true,
      from_collected: newFromColl,
      to_collected: newToColl,
      from_invoice: fromInv.finto_invoice,
      to_invoice: toInv.finto_invoice,
    }
  }

  /**
   * Desvincula un comprobante o monto de recaudo de una factura, liberándolo en siigo_documents.
   */
  static async unlinkPayment(input: {
    invoice_id: string
    amount: number
    comprobante: string
  }) {
    const { invoice_id, amount, comprobante } = input

    const { data: inv, error: invErr } = await supabase
      .from('invoice_participations')
      .select('id, finto_invoice_value, collected, cash_receipts, participation_value, participation_type')
      .eq('id', invoice_id)
      .single()
    if (invErr || !inv) throw Object.assign(new Error('Factura no encontrada'), { statusCode: 404 })

    const curColl = Number(inv.collected ?? 0)
    const newColl = Math.max(0, money(curColl - amount))

    const compNorm = normalizeInvoiceNumber(comprobante)
    const receipts = String(inv.cash_receipts ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(r => normalizeInvoiceNumber(r) !== compNorm)

    const avail = availableParticipation({
      type: inv.participation_type || 'percentage',
      participationValue: Number(inv.participation_value ?? 0),
      invoiceValue: Number(inv.finto_invoice_value ?? 0),
      collected: newColl,
    })

    const now = new Date().toISOString()
    const { error: upErr } = await supabase
      .from('invoice_participations')
      .update({
        collected: newColl,
        cash_receipts: receipts.join(', '),
        available_for_payment: avail,
        updated_at: now,
      })
      .eq('id', invoice_id)
    if (upErr) throw upErr

    await ParticipationsService.recomputeStatus(invoice_id)

    // Liberar en siigo_documents
    const { data: doc } = await supabase
      .from('siigo_documents')
      .select('id, amount, applied')
      .eq('doc_type', 'RC')
      .eq('comprobante', comprobante)
      .maybeSingle()

    if (doc) {
      const curApplied = Number(doc.applied ?? 0)
      const newApplied = Math.max(0, money(curApplied - amount))
      await supabase
        .from('siigo_documents')
        .update({
          applied: newApplied,
          matched: newApplied > 0.01,
          note: 'Desvinculado manualmente de factura',
          updated_at: now,
        })
        .eq('id', doc.id)
    }

    return { success: true, collected: newColl }
  }

  /**
   * Desvincula la factura de venta (FV) asignada a una orden de compra (OC).
   * Deja la OC en estado 'pending_invoice', resetea valores de factura y disponible,
   * y libera la FV en siigo_documents para que pueda asignarse a otra OC.
   * Opcionalmente también desvincula los recibos de caja asociados.
   */
  static async unlinkSaleInvoice(input: { invoice_id: string; unlink_receipts?: boolean }) {
    const { invoice_id, unlink_receipts } = input
    const { data: inv, error: invErr } = await supabase
      .from('invoice_participations')
      .select('id, finto_invoice, finto_invoice_value, collected, cash_receipts, participation_value, participation_type')
      .eq('id', invoice_id)
      .single()
    if (invErr || !inv) throw Object.assign(new Error('Factura de participación no encontrada'), { statusCode: 404 })

    const oldFv = inv.finto_invoice
    const now = new Date().toISOString()

    const updatePayload: Record<string, any> = {
      finto_invoice: null,
      finto_invoice_date: null,
      finto_invoice_value: 0,
      available_for_payment: 0,
      updated_at: now,
    }

    if (unlink_receipts) {
      updatePayload.collected = 0
      updatePayload.cash_receipts = null
      updatePayload.cash_receipt_date = null

      // Liberar en siigo_documents los recibos que estaban aplicados
      const receipts = String(inv.cash_receipts ?? '').split(',').map(s => s.trim()).filter(Boolean)
      for (const r of receipts) {
        const { data: rcDoc } = await supabase
          .from('siigo_documents')
          .select('id, amount, applied')
          .eq('doc_type', 'RC')
          .eq('comprobante', r)
          .maybeSingle()
        if (rcDoc) {
          const curApplied = Number(rcDoc.applied ?? 0)
          const newApplied = Math.max(0, money(curApplied - Number(inv.collected ?? 0)))
          await supabase
            .from('siigo_documents')
            .update({
              applied: newApplied,
              matched: newApplied > 0.01,
              note: 'Desvinculado por desvinculación de FV de OC',
              updated_at: now,
            })
            .eq('id', rcDoc.id)
        }
      }
    }

    const { error: upErr } = await supabase
      .from('invoice_participations')
      .update(updatePayload)
      .eq('id', invoice_id)
    if (upErr) throw upErr

    // Liberar la FV en siigo_documents
    if (oldFv) {
      await supabase
        .from('siigo_documents')
        .update({
          matched: false,
          note: 'Desvinculada manualmente de OC',
          updated_at: now,
        })
        .eq('doc_type', 'FV')
        .eq('comprobante', oldFv)
    }

    await ParticipationsService.recomputeStatus(invoice_id)

    const { data: updated, error: fetchErr } = await supabase
      .from('invoice_participations')
      .select('*, participation:service_participations(third_party:third_parties(name, identification, tax_profile:tax_profiles(*)), company_service:company_services(services(name))), companies(name, nit)')
      .eq('id', invoice_id)
      .single()
    if (fetchErr) throw fetchErr

    return updated
  }

  /**
   * Obtiene los recibos de caja (RC) no cruzados o con saldo disponibles de un cliente.
   */
  static async getClientUncrossedReceipts(clientNit: string) {
    if (!clientNit) return []
    const nit = normalizeNit(clientNit)
    if (!nit) return []

    const { data, error } = await supabase
      .from('siigo_documents')
      .select('id, comprobante, doc_date, amount, applied, saldo, note, period, fv_ref, tercero_name, tercero_nit')
      .eq('doc_type', 'RC')
      .order('doc_date', { ascending: false })

    if (error) throw error

    return (data ?? [])
      .filter((d: any) => {
        const dNit = normalizeNit(d.tercero_nit)
        return dNit && nitMatch(dNit, nit) && (Number(d.saldo ?? 0) > 0.01 || !d.matched)
      })
  }

  /**
   * Obtiene los documentos registrados en siigo_documents para vincular sin inventar facturas.
   * Filtra por doc_type ('FV' | 'RC' | 'FC' | 'RP') y NIT (cliente o tercero).
   */
  static async getAvailableDocuments(params: { doc_type?: string; nit: string; only_unmatched?: boolean }) {
    const { doc_type, nit, only_unmatched } = params
    if (!nit) return []
    const norm = normalizeNit(nit)
    if (!norm) return []

    let q = supabase
      .from('siigo_documents')
      .select('id, doc_type, comprobante, doc_date, amount, applied, saldo, matched, note, period, fv_ref, tercero_name, tercero_nit')
      .order('doc_date', { ascending: false })
      .limit(300)

    if (doc_type) {
      q = q.eq('doc_type', doc_type)
    }

    const { data, error } = await q
    if (error) throw error

    return (data ?? []).filter((d: any) => {
      const dNit = normalizeNit(d.tercero_nit)
      const matchesNit = dNit && nitMatch(dNit, norm)
      if (!matchesNit) return false
      if (only_unmatched) {
        if (d.doc_type === 'RC' || d.doc_type === 'RP') {
          return Number(d.saldo ?? 0) > 0.01 || !d.matched
        }
        return !d.matched
      }
      return true
    })
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
    const by = (s: string) => rows.filter((r: any) => r.status === s).length
    return {
      total:                 rows.length,
      pending_invoice:       by('pending_invoice'),
      pending_third_invoice: by('pending_third_invoice'),
      value_difference:      by('value_difference'),
      pending_payment:       by('pending_payment'),
      complete:              by('complete'),
      participation_total:   sum(r => Number(r.participation_value ?? 0)),
      available_total:       sum(r => Number(r.available_for_payment ?? 0)),
    }
  }

  /**
   * Vista inversa: agrupa las facturas por comprobante de pago. Un solo pago
   * puede cubrir varias facturas (reparto FIFO), así que aquí se ve, dado un
   * comprobante, qué facturas quedaron vinculadas a él.
   *  - kind 'RC': recaudo del cliente (pago que le hacen a Finto) → facturas cobradas.
   *  - kind 'RP': pago de Finto al tercero → facturas pagadas.
   * Nota: el monto aplicado por comprobante a cada factura no se persiste; se
   * muestran los totales de la factura (collected / egress_voucher_value).
   */
  static async paymentsGrouped(f: { company_id?: string; period?: string; year?: string; from?: string; to?: string } = {}) {
    let q = supabase.from('invoice_participations')
      .select('finto_invoice, finto_invoice_date, finto_invoice_value, participation_value, collected, available_for_payment, cash_receipts, egress_voucher, egress_voucher_value, egress_voucher_date, companies(name), participation:service_participations(third_party:third_parties(name, identification))')
    if (f.company_id) q = q.eq('company_id', f.company_id)
    if (f.period)     q = q.eq('period', f.period)
    else if (f.year)  q = q.like('period', `${f.year}-%`)
    if (f.from)       q = q.gte('finto_invoice_date', f.from)
    if (f.to)         q = q.lte('finto_invoice_date', f.to)
    const { data, error } = await q
    if (error) throw error

    type Grp = { voucher: string; kind: 'RC' | 'RP'; date: string | null; invoices: any[] }
    const groups = new Map<string, Grp>()
    const push = (raw: string, kind: 'RC' | 'RP', date: string | null, invoice: any) => {
      const voucher = String(raw ?? '').trim()
      if (!voucher) return
      const key = `${kind}:${normalizeInvoiceNumber(voucher)}`
      let g = groups.get(key)
      if (!g) { g = { voucher, kind, date, invoices: [] }; groups.set(key, g) }
      if (date && (!g.date || date > g.date)) g.date = date
      g.invoices.push(invoice)
    }

    for (const r of data ?? []) {
      const one = (x: any) => Array.isArray(x) ? x[0] : x
      const tp = one(one((r as any).participation)?.third_party)
      const invoice = {
        finto_invoice:      (r as any).finto_invoice,
        finto_invoice_value: Number((r as any).finto_invoice_value ?? 0),
        participation_value: Number((r as any).participation_value ?? 0),
        collected:          Number((r as any).collected ?? 0),
        available_for_payment: Number((r as any).available_for_payment ?? 0),
        egress_voucher_value: Number((r as any).egress_voucher_value ?? 0),
        company:            one((r as any).companies)?.name ?? null,
        third_party:        tp?.name ?? null,
      }
      for (const rc of String((r as any).cash_receipts ?? '').split(',')) push(rc, 'RC', (r as any).finto_invoice_date ?? null, invoice)
      for (const rp of String((r as any).egress_voucher ?? '').split(',')) push(rp, 'RP', (r as any).egress_voucher_date ?? null, invoice)
    }

    const list = [...groups.values()].map(g => ({
      ...g,
      count: g.invoices.length,
      collected_total: money(g.invoices.reduce((a, i) => a + i.collected, 0)),
      paid_total:      money(g.invoices.reduce((a, i) => a + i.egress_voucher_value, 0)),
    }))
    // Solo comprobantes que cubren varias facturas primero, luego por fecha desc.
    list.sort((a, b) => (b.count - a.count) || String(b.date ?? '').localeCompare(String(a.date ?? '')))
    return { payments: list }
  }

  /**
   * Vista maestra de conciliación (hoja "Conciliación" del spec): una fila por
   * OC con las 5 etapas — generación (FINTO), venta, compra del tercero, pago
   * (RP) y recaudo (RC). Aplana los joins a cliente y tercero.
   */
  static async conciliation(filters: { period?: string; company_id?: string; year?: string; from?: string; to?: string }) {
    let q = supabase
      .from('invoice_participations')
      .select('period, contract_type, finto_invoice, finto_invoice_date, finto_invoice_value, credit_note_value, debit_note_value, purchase_order, participation_value, third_party_invoice, third_party_invoice_value, egress_voucher, egress_voucher_value, collected, cash_receipts, status, companies(name, nit), participation:service_participations(third_party:third_parties(name, identification))')
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
        contrato:      r.contract_type ?? 'servicio',
        cliente:       co?.name ?? '—',
        nit_cliente:   co?.nit ?? '',
        venta:         Number(r.finto_invoice_value ?? 0),
        nota_credito:  Number(r.credit_note_value ?? 0),
        nota_debito:   Number(r.debit_note_value ?? 0),
        neto:          money(Number(r.finto_invoice_value ?? 0) - Number(r.credit_note_value ?? 0) + Number(r.debit_note_value ?? 0)),
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
      .select('purchase_order, period, finto_invoice, finto_invoice_value, collected, cash_receipts, participation_value, available_for_payment, egress_voucher, egress_voucher_value, company_id, companies(name), participation:service_participations(third_party:third_parties(name, identification))')
    if (filters.period)     q = q.eq('period', filters.period)
    else if (filters.year)  q = q.like('period', `${filters.year}-%`)
    if (filters.company_id) q = q.eq('company_id', filters.company_id)
    if (filters.from)       q = q.gte('finto_invoice_date', filters.from)
    if (filters.to)         q = q.lte('finto_invoice_date', filters.to)
    const { data, error } = await q
    if (error) throw error
    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const r2 = (n: number) => money(n)

    type CxcItem = { purchase_order: string; period: string; finto_invoice: string; invoiced: number; collected: number; outstanding: number }
    type CxpItem = { purchase_order: string; period: string; client: string; finto_invoice: string | null; participation_value: number; available: number; paid: number; owed: number }
    type CxcEntry = { client: string; invoiced: number; collected: number; outstanding: number; count: number; items: CxcItem[] }
    type CxpEntry = { third_party: string; nit: string; owed: number; paid: number; count: number; items: CxpItem[] }
    const cxc = new Map<string, CxcEntry>()
    const cxp = new Map<string, CxpEntry>()
    let receivable = 0, payable = 0, participationTotal = 0, availableTotal = 0, paidTotal = 0

    for (const r of data ?? []) {
      const inv       = Number((r as any).finto_invoice_value ?? 0)
      const collected = Number((r as any).collected ?? 0)
      const part      = Number((r as any).participation_value ?? 0)
      const avail     = Number((r as any).available_for_payment ?? 0)
      const paid      = Number((r as any).egress_voucher_value ?? 0)
      const co        = one((r as any).companies)
      participationTotal += part
      availableTotal     += avail
      paidTotal          += paid

      // CxC Clientes — solo cuentas con factura de venta emitida
      if ((r as any).finto_invoice) {
        const outstanding = Math.max(0, inv - collected)
        receivable += outstanding
        const key = String((r as any).company_id ?? co?.name ?? '—')
        const e: CxcEntry = cxc.get(key) ?? { client: co?.name ?? '—', invoiced: 0, collected: 0, outstanding: 0, count: 0, items: [] }
        e.invoiced += inv; e.collected += collected; e.outstanding += outstanding; e.count++
        e.items.push({
          purchase_order: (r as any).purchase_order, period: (r as any).period,
          finto_invoice: (r as any).finto_invoice,
          invoiced: r2(inv), collected: r2(collected), outstanding: r2(outstanding),
        })
        cxc.set(key, e)
      }

      // CxP Terceros — lo que aún debemos = disponible − pagado
      const owed = Math.max(0, avail - paid)
      payable += owed
      const tp = one(one((r as any).participation)?.third_party)
      const tkey = String(tp?.identification || tp?.name || '—')
      const te: CxpEntry = cxp.get(tkey) ?? { third_party: tp?.name ?? '—', nit: tp?.identification ?? '', owed: 0, paid: 0, count: 0, items: [] }
      te.owed += owed; te.paid += paid; te.count++
      te.items.push({
        purchase_order: (r as any).purchase_order, period: (r as any).period,
        client: co?.name ?? '—', finto_invoice: (r as any).finto_invoice ?? null,
        participation_value: r2(part), available: r2(avail), paid: r2(paid), owed: r2(owed),
      })
      cxp.set(tkey, te)
    }

    // Ordena los ítems: primero los que tienen saldo pendiente, luego por periodo
    const byPending = (k: 'outstanding' | 'owed') => (a: any, b: any) =>
      (b[k] > 0 ? 1 : 0) - (a[k] > 0 ? 1 : 0) || String(a.period).localeCompare(String(b.period))

    return {
      summary: {
        count:               (data ?? []).length,   // # de OC/participaciones en el alcance
        participation_total: r2(participationTotal),
        available_total:     r2(availableTotal),
        paid_total:          r2(paidTotal),
        receivable_total:    r2(receivable),   // lo que nos deben (clientes)
        payable_total:       r2(payable),      // lo que debemos (terceros)
      },
      receivable: [...cxc.values()]
        .map(e => ({ ...e, invoiced: r2(e.invoiced), collected: r2(e.collected), outstanding: r2(e.outstanding), items: e.items.sort(byPending('outstanding')) }))
        .filter(e => e.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding),
      payable: [...cxp.values()]
        .map(e => ({ ...e, owed: r2(e.owed), paid: r2(e.paid), items: e.items.sort(byPending('owed')) }))
        .filter(e => e.owed > 0)
        .sort((a, b) => b.owed - a.owed),
    }
  }

  /**
   * Resumen y relación de facturas agrupadas por tercero.
   * Agrupa todas las facturas de venta y compra vinculadas al tercero,
   * calculando acumulados de participación, facturación, recaudos, pagos y saldos.
   */
  static async thirdPartiesSummary(filters: { period?: string; year?: string; from?: string; to?: string; q?: string }) {
    let q = supabase
      .from('invoice_participations')
      .select(`
        id,
        purchase_order,
        period,
        contract_type,
        finto_invoice,
        finto_invoice_date,
        finto_invoice_value,
        credit_note_value,
        debit_note_value,
        participation_value,
        collected,
        cash_receipts,
        available_for_payment,
        third_party_invoice,
        third_party_invoice_date,
        third_party_invoice_value,
        payment_order,
        egress_voucher,
        egress_voucher_date,
        egress_voucher_value,
        status,
        company_id,
        companies (id, name, nit),
        participation:service_participations (
          id,
          third_party_id,
          third_party:third_parties (id, name, identification, person_type, tax_profile:tax_profiles(*)),
          company_service:company_services (services (name))
        )
      `)
      .order('finto_invoice_date', { ascending: false })
      .order('purchase_order', { ascending: false })

    if (filters.period)     q = q.eq('period', filters.period)
    else if (filters.year)  q = q.like('period', `${filters.year}-%`)
    if (filters.from)       q = q.gte('finto_invoice_date', filters.from)
    if (filters.to)         q = q.lte('finto_invoice_date', filters.to)

    const { data, error } = await q
    if (error) throw error

    // Alertas de facturas de compra (FC) no cruzadas en siigo_documents
    const { data: unmatchedFCs } = await supabase
      .from('siigo_documents')
      .select('tercero_nit, amount')
      .eq('doc_type', 'FC')
      .eq('matched', false)

    const fcAlertsMap = new Map<string, { count: number; total: number }>()
    for (const fc of (unmatchedFCs ?? [])) {
      const nit = String(fc.tercero_nit ?? '').trim()
      if (!nit) continue
      const curr = fcAlertsMap.get(nit) ?? { count: 0, total: 0 }
      curr.count += 1
      curr.total = money(curr.total + Number(fc.amount ?? 0))
      fcAlertsMap.set(nit, curr)
    }

    const settings = await ParticipationsService.loadTaxSettings()
    const one = (v: any) => Array.isArray(v) ? v[0] : v
    const r2 = (n: number) => money(n)

    type ThirdPartyGroup = {
      id: string
      name: string
      identification: string
      person_type?: string
      has_tax_profile: boolean
      tax_profile_name: string | null
      invoices_count: number
      participation_total: number
      finto_invoiced_total: number
      collected_total: number
      available_total: number
      net_payable_total: number
      third_party_invoiced_total: number
      paid_total: number
      balance_owed: number
      net_balance_owed: number
      unmatched_fc_count: number
      unmatched_fc_total: number
      invoices: any[]
    }

    const groups = new Map<string, ThirdPartyGroup>()
    let globalPartTotal = 0
    let globalFintoTotal = 0
    let globalAvailTotal = 0
    let globalNetPayTotal = 0
    let globalThirdInvTotal = 0
    let globalPaidTotal = 0
    let globalOwedTotal = 0
    let globalNetOwedTotal = 0

    const fvs = (data ?? []).map((r: any) => r.finto_invoice).filter(Boolean)
    const rcDates = new Map<string, string>()
    if (fvs.length) {
      try {
        const { data: rcDocs } = await supabase
          .from('siigo_documents')
          .select('fv_ref, doc_date')
          .eq('doc_type', 'RC')
          .in('fv_ref', fvs)
        for (const d of rcDocs ?? []) {
          const k = normalizeInvoiceNumber(d.fv_ref)
          if (k && d.doc_date && !rcDates.has(k)) {
            rcDates.set(k, d.doc_date)
          }
        }
      } catch (err) {
        logger.warn({ err: (err as any)?.message }, 'Error al consultar siigo_documents para fechas de RC')
      }
    }

    for (const row of (data ?? [])) {
      const partObj = one((row as any).participation)
      const tp = one(partObj?.third_party)
      const co = one((row as any).companies)
      const cs = one(partObj?.company_service)
      const svc = one(cs?.services)

      const profileRow = tp?.tax_profile as TaxProfileRow | null | undefined
      const partition = ParticipationsService.computePartition(row, profileRow ?? null, settings)
      const fv = (row as any).finto_invoice
      const rcDate = fv ? (rcDates.get(normalizeInvoiceNumber(fv)) ?? null) : null
      const rowWithPartition = { ...row, cash_receipt_date: rcDate, tax_partition: partition }

      const tpId = tp?.id ?? 'sin-tercero'
      const tpName = tp?.name ?? 'Sin tercero asignado'
      const tpNit = String(tp?.identification ?? '').trim()

      const fintoVal = Number((row as any).finto_invoice_value ?? 0)
      const partVal = Number((row as any).participation_value ?? 0)
      const collVal = Number((row as any).collected ?? 0)
      const availVal = Number((row as any).available_for_payment ?? 0)
      const thirdInvVal = (row as any).third_party_invoice_value != null ? Number((row as any).third_party_invoice_value) : null
      const paidVal = (row as any).egress_voucher_value != null ? Number((row as any).egress_voucher_value) : 0

      // Saldo bruto y saldo neto tributario
      const owedVal = Math.max(0, availVal - paidVal)
      const netPayVal = Number(partition.payThirdParty ?? 0)
      const netOwedVal = Math.max(0, netPayVal - paidVal)

      globalPartTotal += partVal
      globalFintoTotal += fintoVal
      globalAvailTotal += availVal
      globalNetPayTotal += netPayVal
      globalThirdInvTotal += (thirdInvVal ?? 0)
      globalPaidTotal += paidVal
      globalOwedTotal += owedVal
      globalNetOwedTotal += netOwedVal

      const fcAlert = tpNit ? (fcAlertsMap.get(tpNit) ?? { count: 0, total: 0 }) : { count: 0, total: 0 }

      const group: ThirdPartyGroup = groups.get(tpId) ?? {
        id: tpId,
        name: tpName,
        identification: tpNit,
        person_type: tp?.person_type,
        has_tax_profile: !!profileRow,
        tax_profile_name: profileRow?.name ?? null,
        invoices_count: 0,
        participation_total: 0,
        finto_invoiced_total: 0,
        collected_total: 0,
        available_total: 0,
        net_payable_total: 0,
        third_party_invoiced_total: 0,
        paid_total: 0,
        balance_owed: 0,
        net_balance_owed: 0,
        unmatched_fc_count: fcAlert.count,
        unmatched_fc_total: fcAlert.total,
        invoices: [],
      }

      group.invoices_count += 1
      group.participation_total = r2(group.participation_total + partVal)
      group.finto_invoiced_total = r2(group.finto_invoiced_total + fintoVal)
      group.collected_total = r2(group.collected_total + collVal)
      group.available_total = r2(group.available_total + availVal)
      group.net_payable_total = r2(group.net_payable_total + netPayVal)
      group.third_party_invoiced_total = r2(group.third_party_invoiced_total + (thirdInvVal ?? 0))
      group.paid_total = r2(group.paid_total + paidVal)
      group.balance_owed = r2(group.balance_owed + owedVal)
      group.net_balance_owed = r2(group.net_balance_owed + netOwedVal)

      group.invoices.push({
        id: (row as any).id,
        purchase_order: (row as any).purchase_order,
        period: (row as any).period,
        contract_type: (row as any).contract_type,
        client_name: co?.name ?? '—',
        client_nit: co?.nit ?? '',
        service_name: svc?.name ?? '—',
        finto_invoice: (row as any).finto_invoice,
        finto_invoice_date: (row as any).finto_invoice_date,
        finto_invoice_value: fintoVal,
        credit_note_value: Number((row as any).credit_note_value ?? 0),
        debit_note_value: Number((row as any).debit_note_value ?? 0),
        participation_value: partVal,
        collected: collVal,
        cash_receipts: (row as any).cash_receipts,
        cash_receipt_date: rcDate,
        available_for_payment: availVal,
        net_payable: r2(netPayVal),
        third_party_invoice: (row as any).third_party_invoice,
        third_party_invoice_date: (row as any).third_party_invoice_date,
        third_party_invoice_value: thirdInvVal,
        payment_order: (row as any).payment_order,
        egress_voucher: (row as any).egress_voucher,
        egress_voucher_date: (row as any).egress_voucher_date,
        egress_voucher_value: paidVal,
        balance_owed: r2(owedVal),
        net_balance_owed: r2(netOwedVal),
        status: (row as any).status,
        has_tax_profile: !!profileRow,
        tax_profile_name: profileRow?.name ?? null,
        tax_partition: partition,
        _raw: rowWithPartition,
      })

      groups.set(tpId, group)
    }

    let list = [...groups.values()]

    // Filtrar por búsqueda si aplica
    if (filters.q?.trim()) {
      const term = filters.q.trim().toLowerCase()
      list = list.filter(g =>
        g.name.toLowerCase().includes(term) ||
        g.identification.toLowerCase().includes(term) ||
        g.invoices.some(inv =>
          (inv.finto_invoice && String(inv.finto_invoice).toLowerCase().includes(term)) ||
          (inv.third_party_invoice && String(inv.third_party_invoice).toLowerCase().includes(term)) ||
          (inv.purchase_order && String(inv.purchase_order).toLowerCase().includes(term)) ||
          (inv.client_name && String(inv.client_name).toLowerCase().includes(term))
        )
      )
    }

    // Ordenar: primero los terceros con mayor saldo por pagar, luego por nombre
    list.sort((a, b) => (b.balance_owed - a.balance_owed) || a.name.localeCompare(b.name))

    return {
      summary: {
        third_parties_count: list.length,
        invoices_count: (data ?? []).length,
        participation_total: r2(globalPartTotal),
        finto_invoiced_total: r2(globalFintoTotal),
        available_total: r2(globalAvailTotal),
        net_payable_total: r2(globalNetPayTotal),
        third_party_invoiced_total: r2(globalThirdInvTotal),
        paid_total: r2(globalPaidTotal),
        balance_owed_total: r2(globalOwedTotal),
        net_balance_owed_total: r2(globalNetOwedTotal),
      },
      third_parties: list,
    }
  }

}
