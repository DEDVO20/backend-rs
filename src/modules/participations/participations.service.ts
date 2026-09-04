import { supabase } from '../../lib/supabase.js'
import { logger }   from '../../lib/logger.js'
import {
  calcParticipation, availableParticipation, deriveInvoiceStatus,
  formatPurchaseOrder, formatPaymentOrder, validateThirdPartyInvoice, money,
  normalizeInvoiceNumber,
  normalizeSiigoInvoice, nitMatch, normalizeNit,
  parseAccountingMovement, PARTICIPATION_ACCOUNTS,
} from './participations.domain.js'
import type { ParticipationAccounts } from './participations.domain.js'
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
        has_third_party:    true,
        active:             input.active,
        updated_at:         new Date().toISOString(),
      }, { onConflict: 'company_service_id' })
      .select('*, third_parties(id, name, identification)')
      .single()
    if (error) throw error
    return { service_value: input.service_value, participation: data }
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
      .eq('contract_type', 'servicio')   // los mandatos se importan aparte (cuenta 28150601)
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
          .select('id')
          .eq('finto_invoice', w.finto_invoice)
          .maybeSingle()
        if (byFv) {
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

      // ── Recaudo (RC) sobre FV YA existentes (causadas en un informe anterior) ──
      const pendingFvs = mov.collections.map(c => c.fv).filter(fv => !causadasFv.has(normalizeInvoiceNumber(fv)))
      if (pendingFvs.length) {
        const { data: existing } = await supabase
          .from('invoice_participations')
          .select('id, finto_invoice, finto_invoice_value, participation_value')
          .in('finto_invoice', pendingFvs)
        for (const ip of existing ?? []) {
          const coll = collByFv.get(normalizeInvoiceNumber((ip as any).finto_invoice))
          if (!coll) continue
          const base      = Number((ip as any).finto_invoice_value ?? 0)
          const partValue = Number((ip as any).participation_value ?? 0)
          const collected = coll.collected
          const available = availableParticipation({ type: 'percentage', participationValue: partValue, invoiceValue: base, collected })
          const { error: upErr } = await supabase
            .from('invoice_participations')
            .update({ collected, cash_receipts: coll.receipts.join(', '), available_for_payment: available, updated_at: new Date().toISOString() })
            .eq('id', (ip as any).id)
          if (upErr) throw upErr
          await ParticipationsService.recomputeStatus((ip as any).id)
          recaudo_updated++
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

        for (const fc of mov.thirdInvoices) {
          if (!normalizeNit(fc.terceroNit)) continue
          const mine = (openFc ?? []).filter((ip: any) => {
            const nit = nitOf(ip)
            return nit && nitMatch(nit, fc.terceroNit)
          })
          if (!mine.length) continue
          // Idempotencia: si esta FC ya figura en alguna participación del tercero
          // ya se repartió → no volver a sumarla.
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

        for (const p of mov.payments) {
          if (!normalizeNit(p.terceroNit)) continue
          const mine = (openRp ?? []).filter((ip: any) => {
            const nit = nitOf(ip)
            return nit && nitMatch(nit, p.terceroNit)
          })
          if (!mine.length) continue
          // Idempotencia: si este RP ya figura en alguna participación del tercero
          // el pago ya se repartió → no volver a sumarlo.
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
        }
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

}
