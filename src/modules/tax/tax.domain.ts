// ─────────────────────────────────────────────────────────────────────────────
// Motor tributario puro y parametrizable (Colombia).
//
// Requisito de arquitectura (spec §9): NADA de `if (perfil === "freddy")`. El
// cálculo depende SOLO de los atributos tributarios del perfil + las tarifas de
// la operación. Agregar un perfil nuevo = crear otro TaxProfile; el motor no
// cambia. Sin dependencias de infraestructura (BD/HTTP) para poder probarse
// aislada — mismo criterio que participations.domain.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Redondeo a 2 decimales (pesos), consistente con participations.domain. */
export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export type PersonType = 'NATURAL' | 'JURIDICA'
export type TaxRegime  = 'ORDINARY' | 'SIMPLE'

/**
 * Una regla de retención: si el emisor está sujeto y a qué tarifa. La tarifa es
 * opcional; si no viene, el cálculo usa la tarifa por defecto de la operación.
 */
export interface TaxRule {
  subject: boolean
  rate?: number
}

/**
 * Perfil tributario de un tercero (spec §2). Atributos independientes: régimen,
 * responsabilidad de IVA y calificación de Gran Contribuyente NO se derivan unos
 * de otros.
 */
export interface TaxProfile {
  personType:     PersonType
  taxRegime:      TaxRegime
  ivaResponsible: boolean
  grandTaxpayer:  boolean

  /** Override de la tarifa de IVA del emisor (null/undefined ⇒ tarifa de la operación). */
  ivaRate?: number | null

  /** Reglas de sujeción del emisor a cada retención (retenciones de la FACTURA). */
  incomeWithholding?: TaxRule   // retención en la fuente (renta)
  icaWithholding?:    TaxRule   // reteICA
  ivaWithholding?:    TaxRule   // reteIVA (sobre el IVA facturado)

  /**
   * Capacidad del tercero de actuar como AGENTE RETENEDOR. Relevante para las
   * retenciones sobre la COMISIÓN: cuando el tercero paga la comisión de la
   * firma, retiene solo si es agente. Una persona natural no comerciante NO
   * retiene ⇒ retefuente/reteICA sobre la comisión = 0 (ver ejemplo PN-Freddy).
   */
  agentIncomeWithholding?: boolean
  agentIcaWithholding?:    boolean
}

/**
 * Capacidad del RECEPTOR de actuar como agente retenedor. Una retención se
 * aplica solo si el emisor está sujeto Y el receptor es agente de esa retención
 * (spec §5: depende de emisor + receptor + operación, no solo del régimen).
 */
export interface WithholdingAgent {
  incomeWithholdingAgent: boolean
  icaWithholdingAgent:    boolean
  ivaWithholdingAgent:    boolean
}

/** Tarifas por defecto de la operación (parametrizables, spec §3 y §10). */
export interface OperationSettings {
  ivaRate:              number   // IVA de la factura
  incomeWithholdingRate: number  // retefuente
  icaWithholdingRate:   number   // reteICA
  ivaWithholdingRate:   number   // reteIVA (sobre el IVA)
  commissionRate:       number   // comisión sobre la base
  commissionIvaRate:    number   // IVA de la comisión
}

export interface OperationInput {
  /** Valor base de la factura (antes de IVA). */
  invoiceValue: number
  emitter:  TaxProfile
  receiver: WithholdingAgent
  settings: OperationSettings
}

/** Una línea de retención en el desglose auditable. */
export interface WithholdingLine {
  applied: boolean
  base:    number
  rate:    number
  amount:  number
  reason:  string
}

/** Desglose completo y auditable de la operación (spec §7 y §8). */
export interface OperationResult {
  // Factura
  invoiceBase:   number   // Factura
  invoiceIva:    number   // IVA factura
  invoiceTotal:  number   // Valor factura (base + IVA)

  // Retenciones sobre la factura
  incomeWithholding: WithholdingLine  // Retención fuente
  icaWithholding:    WithholdingLine  // Retención ICA
  ivaWithholding:    WithholdingLine  // Retención IVA

  invoicePayment: number  // Pago/giro de la factura = total − retenciones

  // Comisión
  commission:      number  // Comisión
  commissionIva:   number  // IVA comisión
  commissionTotal: number  // Comisión + IVA comisión
  commissionIncomeWithholding: WithholdingLine  // Retefuente sobre comisión
  commissionIcaWithholding:    WithholdingLine  // ReteICA sobre comisión
  commissionNet:   number  // Comisión + IVA − retenciones de la comisión

  // Giro final
  finalTotal: number      // Total final (spec §8)
}

/**
 * Tarifa efectiva: override del perfil/regla si viene, si no la de la operación.
 */
function effectiveRate(ruleRate: number | undefined | null, fallback: number): number {
  return ruleRate === undefined || ruleRate === null ? fallback : ruleRate
}

/**
 * Evalúa una retención genérica sobre una base. Se aplica solo si el emisor está
 * sujeto (`rule.subject`) y el receptor es agente (`agent`).
 */
function evalWithholding(
  base: number,
  rule: TaxRule | undefined,
  agent: boolean,
  fallbackRate: number,
  label: string,
): WithholdingLine {
  const subject = rule?.subject ?? false
  const rate    = effectiveRate(rule?.rate, fallbackRate)
  const applied = subject && agent
  const reason  = applied
    ? `${label}: emisor sujeto y receptor agente`
    : !subject
      ? `${label}: emisor no sujeto`
      : `${label}: receptor no es agente`
  return { applied, base, rate, amount: applied ? money(base * rate) : 0, reason }
}

/**
 * Retención sobre la COMISIÓN. Aquí el tercero (emisor de la factura) es quien
 * paga la comisión a la firma y, por tanto, quien retiene — solo si es agente
 * retenedor. La firma (perceptora de la comisión) se asume sujeta a la retención.
 */
function evalCommissionWithholding(
  base: number,
  isAgent: boolean,
  rate: number,
  label: string,
): WithholdingLine {
  const applied = isAgent
  return {
    applied,
    base,
    rate: applied ? rate : 0,
    amount: applied ? money(base * rate) : 0,
    reason: applied ? `${label}: el tercero es agente retenedor` : `${label}: el tercero no es agente retenedor`,
  }
}

/**
 * Motor principal. Sigue el flujo de spec §9:
 * perfil → IVA → retefuente → reteICA → reteIVA → comisión → impuestos comisión
 * → giro → desglose.
 */
export function computeOperation(input: OperationInput): OperationResult {
  const { invoiceValue, emitter, receiver, settings } = input
  const base = money(invoiceValue)

  // ── IVA de la factura ──────────────────────────────────────────────────────
  // Solo si el emisor es responsable de IVA. La tarifa: override del perfil o la
  // de la operación. No se asume que SIMPLE ⇒ sin IVA (spec §1).
  const ivaRate = emitter.ivaResponsible ? effectiveRate(emitter.ivaRate, settings.ivaRate) : 0
  const invoiceIva   = money(base * ivaRate)
  const invoiceTotal = money(base + invoiceIva)

  // ── Retenciones sobre la factura ─────────────────────────────────────────────
  const incomeWithholding = evalWithholding(
    base, emitter.incomeWithholding, receiver.incomeWithholdingAgent,
    settings.incomeWithholdingRate, 'Retefuente')

  const icaWithholding = evalWithholding(
    base, emitter.icaWithholding, receiver.icaWithholdingAgent,
    settings.icaWithholdingRate, 'ReteICA')

  // reteIVA se calcula sobre el IVA generado, y requiere además que exista IVA.
  const ivaWithholding = evalWithholding(
    invoiceIva, emitter.ivaWithholding, receiver.ivaWithholdingAgent,
    settings.ivaWithholdingRate, 'ReteIVA')
  if (invoiceIva === 0 && ivaWithholding.applied) {
    ivaWithholding.applied = false
    ivaWithholding.amount  = 0
    ivaWithholding.reason  = 'ReteIVA: no hay IVA que retener'
  }

  const invoicePayment = money(
    invoiceTotal - incomeWithholding.amount - icaWithholding.amount - ivaWithholding.amount)

  // ── Comisión (spec §6) ───────────────────────────────────────────────────────
  const commission      = money(base * settings.commissionRate)
  const commissionIva   = money(commission * settings.commissionIvaRate)
  const commissionTotal = money(commission + commissionIva)

  // Retenciones sobre la comisión — dependen de si el tercero es AGENTE retenedor
  // (retiene sobre la comisión que le paga a la firma). Base = comisión.
  const commissionIncomeWithholding = evalCommissionWithholding(
    commission, emitter.agentIncomeWithholding ?? false,
    settings.incomeWithholdingRate, 'Retefuente comisión')

  const commissionIcaWithholding = evalCommissionWithholding(
    commission, emitter.agentIcaWithholding ?? false,
    settings.icaWithholdingRate, 'ReteICA comisión')

  const commissionNet = money(
    commissionTotal - commissionIncomeWithholding.amount - commissionIcaWithholding.amount)

  // ── Giro final (spec §7) ─────────────────────────────────────────────────────
  // Giro de la factura al tercero, menos lo que la firma retiene como comisión neta.
  const finalTotal = money(invoicePayment - commissionNet)

  return {
    invoiceBase: base,
    invoiceIva,
    invoiceTotal,
    incomeWithholding,
    icaWithholding,
    ivaWithholding,
    invoicePayment,
    commission,
    commissionIva,
    commissionTotal,
    commissionIncomeWithholding,
    commissionIcaWithholding,
    commissionNet,
    finalTotal,
  }
}
