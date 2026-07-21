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

export type ValidationResult = { status: 'validated' | 'review'; reasons: string[] }

/** Concilia lo facturado contra lo calculado (sección 5 del spec) */
export function validateInvoicing(
  monthly: { service_value: number; participation_value: number },
  inv: {
    finto_invoice?: string | null; finto_invoice_value?: number | null
    third_party_invoice?: string | null; third_party_invoice_value?: number | null
  } | null,
): ValidationResult {
  const reasons: string[] = []
  const eq = (a?: number | null, b?: number | null) => a != null && b != null && Math.abs(a - b) < 0.01

  if (!inv?.finto_invoice)       reasons.push('No existe factura de Finto')
  if (!inv?.third_party_invoice) reasons.push('No existe factura del tercero')

  if (inv?.finto_invoice && !eq(inv.finto_invoice_value, monthly.service_value))
    reasons.push('El valor de la factura de Finto no coincide con el valor del servicio')

  if (inv?.third_party_invoice && !eq(inv.third_party_invoice_value, monthly.participation_value))
    reasons.push('El valor de la factura del tercero no coincide con la participación calculada')

  return { status: reasons.length ? 'review' : 'validated', reasons }
}
