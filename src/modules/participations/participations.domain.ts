// ─────────────────────────────────────────────────────────────────────────────
// Lógica de dominio pura de participaciones de terceros.
// Sin dependencias de infraestructura (BD/SIIGO) para poder probarse aislada y
// para que una futura sincronización con SIIGO reutilice estas mismas reglas.
// ─────────────────────────────────────────────────────────────────────────────

export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export type ParticipationType = 'percentage' | 'fixed'

/**
 * Valor de la participación.
 *  - percentage: valor del servicio × (porcentaje / 100)
 *  - fixed:      un monto fijo que cobra el tercero
 */
export function calcParticipation(
  serviceValue: number,
  percentage: number,
  opts?: { type?: ParticipationType; fixedValue?: number | null },
): number {
  if (opts?.type === 'fixed') return money(Number(opts.fixedValue ?? 0))
  return money(serviceValue * (percentage / 100))
}

/**
 * Participación disponible para pagar al tercero, según lo recaudado:
 *  - percentage: proporcional al % recaudado de la factura
 *  - fixed:      completo cuando el recaudo es total; $0 antes
 */
export function availableParticipation(input: {
  type: ParticipationType
  participationValue: number   // participación total calculada
  invoiceValue: number         // valor de la factura de Finto
  collected: number            // recaudado (recibos de caja)
}): number {
  const { type, participationValue, invoiceValue, collected } = input
  if (invoiceValue <= 0) return 0
  const fullyCollected = collected + 0.01 >= invoiceValue

  if (type === 'fixed') return fullyCollected ? money(participationValue) : 0

  const ratio = Math.min(1, Math.max(0, collected / invoiceValue))
  return money(participationValue * ratio)
}

/** Número de orden de compra: OC-YYYYMM-NNNNNN */
export function formatPurchaseOrder(year: number, month: number, seq: number): string {
  return `OC-${year}${String(month).padStart(2, '0')}-${String(seq).padStart(6, '0')}`
}

/** Número de orden de pago: OP-YYYYMM-NNNNNN */
export function formatPaymentOrder(year: number, month: number, seq: number): string {
  return `OP-${year}${String(month).padStart(2, '0')}-${String(seq).padStart(6, '0')}`
}

/**
 * Concilia la factura del tercero contra lo causado (la participación).
 * Si el valor coincide, se puede generar la Orden de Pago; si no, queda
 * pendiente de revisión manual (sección 4 del flujo).
 */
export function validateThirdPartyInvoice(
  participationValue: number,
  thirdInvoice: { number?: string | null; value?: number | null },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!thirdInvoice.number) reasons.push('No existe factura del tercero')
  else if (thirdInvoice.value == null || Math.abs(thirdInvoice.value - participationValue) >= 0.01)
    reasons.push('El valor de la factura del tercero no coincide con lo causado (participación)')
  return { ok: reasons.length === 0, reasons }
}

/** Normaliza números de factura para comparar duplicados ("F-001" ≡ "f 001") */
export function normalizeInvoiceNumber(n: string): string {
  return n.replace(/[\s.\-_]/g, '').toUpperCase()
}

// ── Estados del proceso por factura ──────────────────────────────────────────

export type InvoiceStatus =
  | 'pending_invoice'    // OC creada (servicio contratado), sin factura de venta aún
  | 'invoiced'           // Facturada — FV creada, sin recaudo
  | 'partial_collection' // Recaudo parcial
  | 'available'          // Disponible para pago — recaudo total
  | 'payment_in_process' // Pago en proceso — con Orden de Pago (Fase 3)
  | 'paid'               // Pagada — egreso registrado (Fase 3)
  | 'closed'             // Cerrada (Fase 3)

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  pending_invoice:     'Pendiente de factura',
  invoiced:            'Facturada',
  partial_collection:  'Recaudo parcial',
  available:           'Disponible para pago',
  payment_in_process:  'Pago en proceso',
  paid:                'Pagada',
  closed:              'Cerrada',
}

/**
 * Estado de la participación por factura, derivado del recaudo (y del pago
 * en fases siguientes). En Fase 2 llega hasta 'available'.
 */
export function deriveInvoiceStatus(ip: {
  finto_invoice?: string | null
  finto_invoice_value: number
  collected: number
  available_for_payment?: number
  egress_voucher?: string | null
  egress_voucher_value?: number | null
  participation_value?: number
  payment_order?: string | null
}): InvoiceStatus {
  const inv       = Number(ip.finto_invoice_value ?? 0)
  const collected = Number(ip.collected ?? 0)

  // OC generada por servicio contratado que aún no tiene factura de venta
  if ('finto_invoice' in ip && !ip.finto_invoice
      && !ip.egress_voucher && !ip.payment_order && collected <= 0)
    return 'pending_invoice'

  // Fase 3 (pago al tercero)
  if (ip.egress_voucher) {
    const paid = Number(ip.egress_voucher_value ?? 0)
    const target = Number(ip.available_for_payment ?? ip.participation_value ?? 0)
    return paid + 0.01 >= target && target > 0 ? 'closed' : 'paid'
  }
  if (ip.payment_order) return 'payment_in_process'

  // Fase 2 (recaudo del cliente)
  if (collected <= 0) return 'invoiced'
  if (inv > 0 && collected + 0.01 >= inv) return 'available'
  return 'partial_collection'
}

// ── Conciliación con reportes de SIIGO ───────────────────────────────────────

/**
 * Normaliza el comprobante de factura de SIIGO quitando el sufijo de cuota.
 * En "Recibos de caja" la factura viene como "FV-4-4663-1" (cuota 1) y en
 * "Ventas" como "FV-4-4663"; se comparan sin ese sufijo.
 */
export function normalizeSiigoInvoice(s: string): string {
  const up = String(s ?? '').trim().toUpperCase()
  // FV-<serie>-<numero>[-<cuota>] → conservar FV-<serie>-<numero>
  const m = up.match(/^(FV-\d+-\d+)/)
  if (m) return m[1]!
  // Otros formatos: quitar un posible "-<n>" final de cuota
  return up.replace(/-\d+$/, '')
}

/** NIT/documento normalizado a solo dígitos */
export function normalizeNit(s: string): string {
  return String(s ?? '').replace(/\D/g, '')
}

/** Compara dos NIT tolerando el dígito de verificación (900062985 ≡ 900062985-1) */
export function nitMatch(a: string, b: string): boolean {
  const x = normalizeNit(a), y = normalizeNit(b)
  if (!x || !y) return false
  if (x === y) return true
  // Uno puede traer el dígito de verificación y el otro no
  return x === y.slice(0, -1) || y === x.slice(0, -1)
}

/** Convierte un serial de fecha de Excel (46204.51…) a yyyy-mm-dd */
export function excelSerialToISO(serial: number): string | null {
  if (!serial || !isFinite(serial)) return null
  // Época de Excel: 1899-12-30 (25569 días antes de la época Unix)
  const d = new Date(Math.round((serial - 25569) * 86_400_000))
  if (isNaN(d.getTime())) return null
  return d.toISOString().split('T')[0]!
}

/** Extrae un número de factura (FV-…) de un texto libre; null si no hay */
export function extractInvoiceRef(text: string): string | null {
  const m = String(text ?? '').match(/[A-Za-z]{1,5}-?\d[\d-]*/)
  return m ? m[0] : null
}

/** Convierte una fecha SIIGO "dd/mm/yyyy" a { iso, year, month } */
export function parseSiigoDate(s: string): { iso: string; year: number; month: number } | null {
  const raw = String(s ?? '').trim()
  // Formato texto DD/MM/YYYY (o D/M/YYYY)
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) {
    const day = m[1]!.padStart(2, '0'), month = m[2]!.padStart(2, '0'), year = m[3]!
    return { iso: `${year}-${month}-${day}`, year: Number(year), month: Number(month) }
  }
  // Serial de Excel (ej. 46235 → 2026-07-…). SIIGO exporta algunas fechas así.
  const n = Number(raw)
  if (Number.isFinite(n) && n > 20000 && n < 90000) {
    const iso = excelSerialToISO(n)
    if (iso) {
      const [y, mo] = iso.split('-')
      return { iso, year: Number(y), month: Number(mo) }
    }
  }
  return null
}
