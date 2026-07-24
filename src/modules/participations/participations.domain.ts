// ─────────────────────────────────────────────────────────────────────────────
// Lógica de dominio pura de participaciones de terceros.
// Sin dependencias de infraestructura (BD/SIIGO) para poder probarse aislada y
// para que una futura sincronización con SIIGO reutilice estas mismas reglas.
// ─────────────────────────────────────────────────────────────────────────────

export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Valor participación = valor del servicio × (porcentaje / 100) */
export function calcParticipation(serviceValue: number, percentage: number): number {
  return money(serviceValue * (percentage / 100))
}

/** Número de orden de compra: OC-YYYYMM-NNNNNN */
export function formatPurchaseOrder(year: number, month: number, seq: number): string {
  return `OC-${year}${String(month).padStart(2, '0')}-${String(seq).padStart(6, '0')}`
}

export type Invoicing = {
  finto_invoice?: string | null;       finto_invoice_value?: number | null
  third_party_invoice?: string | null; third_party_invoice_value?: number | null
  cash_receipt?: string | null;        cash_receipt_value?: number | null
  egress_voucher?: string | null;      egress_voucher_value?: number | null
} | null

export type ValidationResult = { status: 'validated' | 'review'; reasons: string[] }

const eqMoney = (a?: number | null, b?: number | null) =>
  a != null && b != null && Math.abs(a - b) < 0.01

/** CxC Clientes = valor facturado por Finto − valor recaudado (recibo de caja) */
export function calcReceivable(inv: Invoicing): number {
  return money(Number(inv?.finto_invoice_value ?? 0) - Number(inv?.cash_receipt_value ?? 0))
}

/** CxP Terceros = valor facturado por el tercero − valor pagado (comprobante de egreso) */
export function calcPayable(inv: Invoicing): number {
  return money(Number(inv?.third_party_invoice_value ?? 0) - Number(inv?.egress_voucher_value ?? 0))
}

/** Concilia lo facturado/recaudado/pagado contra lo calculado (sección 5 del spec) */
export function validateInvoicing(
  monthly: { service_value: number; participation_value: number },
  inv: Invoicing,
): ValidationResult {
  const reasons: string[] = []

  if (!inv?.finto_invoice)       reasons.push('No existe factura de Finto')
  if (!inv?.third_party_invoice) reasons.push('No existe factura del tercero')

  if (inv?.finto_invoice && !eqMoney(inv.finto_invoice_value, monthly.service_value))
    reasons.push('El valor de la factura de Finto no coincide con el valor del servicio')

  if (inv?.third_party_invoice && !eqMoney(inv.third_party_invoice_value, monthly.participation_value))
    reasons.push('El valor de la factura del tercero no coincide con la participación calculada')

  // El recaudo y el pago solo se validan si ya fueron registrados: que falten
  // no es un error, simplemente la participación aún no está cerrada.
  if (inv?.cash_receipt && !eqMoney(inv.cash_receipt_value, inv.finto_invoice_value))
    reasons.push('El recaudo no coincide con lo facturado por Finto')

  if (inv?.egress_voucher && !eqMoney(inv.egress_voucher_value, monthly.participation_value))
    reasons.push('El pago al tercero no coincide con la participación calculada')

  return { status: reasons.length ? 'review' : 'validated', reasons }
}

export type ParticipationStatus = 'pending' | 'review' | 'validated' | 'closed'

export type StatusResult = {
  status:     ParticipationStatus
  reasons:    string[]
  receivable: number   // CxC Clientes
  payable:    number   // CxP Terceros
}

/**
 * Estado del ciclo completo:
 *  pending    → aún no se registró nada
 *  review     → hay inconsistencias (motivos)
 *  validated  → facturas correctas, falta recaudar y/o pagar
 *  closed     → además ya se recaudó al cliente y se pagó al tercero
 */
export function deriveStatus(
  monthly: { service_value: number; participation_value: number },
  inv: Invoicing,
): StatusResult {
  const receivable = calcReceivable(inv)
  const payable    = calcPayable(inv)

  const nothingRegistered = !inv?.finto_invoice && !inv?.third_party_invoice
    && !inv?.cash_receipt && !inv?.egress_voucher

  if (nothingRegistered) return { status: 'pending', reasons: [], receivable, payable }

  const { status, reasons } = validateInvoicing(monthly, inv)
  if (status === 'review') return { status: 'review', reasons, receivable, payable }

  const collected = !!inv?.cash_receipt   && receivable <= 0.009
  const paid      = !!inv?.egress_voucher && payable    <= 0.009

  return { status: collected && paid ? 'closed' : 'validated', reasons, receivable, payable }
}

/** Normaliza números de factura para comparar duplicados ("F-001" ≡ "f 001") */
export function normalizeInvoiceNumber(n: string): string {
  return n.replace(/[\s.\-_]/g, '').toUpperCase()
}
