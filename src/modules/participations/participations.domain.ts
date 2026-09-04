// ─────────────────────────────────────────────────────────────────────────────
// Lógica de dominio pura de participaciones de terceros.
// Sin dependencias de infraestructura (BD/SIIGO) para poder probarse aislada y
// para que una futura sincronización con SIIGO reutilice estas mismas reglas.
// ─────────────────────────────────────────────────────────────────────────────

export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export type ParticipationType = 'percentage' | 'fixed'

/**
 * Tipo de contrato de la participación (hoja `servicio`, columna "Tipo").
 *  - servicio: participación estándar. La firma factura el servicio y le paga al
 *              tercero una comisión (calcParticipation).
 *  - mandato:  contrato de mandato. La porción del tercero (mandante) se reconoce
 *              como cuenta por pagar (cuenta 28150601 en SIIGO) al facturar; su
 *              valor NO se calcula, se lee del reporte de esa cuenta.
 */
export type ContractType = 'servicio' | 'mandato'

/**
 * Cuentas contables del flujo de participaciones en SIIGO (reporte "Movimiento
 * por cuenta contable"). Se comparan por PREFIJO para tolerar subcuentas.
 *  - income (41…):    ventas — todas las facturas que emitimos. Base de la
 *                     participación de servicio (base × %).
 *  - mandate (28150601): contrato de mandato — porción del mandante (se lee, no
 *                     se calcula). Ver [[ContractType]].
 *  - receivable (13050501): cartera del cliente. Comprobante RC = recaudo (libera
 *                     el disponible); comprobante NC = nota crédito (anula factura).
 *  - thirdInvoice (2335…): factura de compra que envía el tercero (FC).
 *  - payment (11200504): banco — el pago al tercero (RP) sale por aquí.
 */
// Cada valor es uno o varios prefijos separados por "|" (matchAcct acepta la lista).
export const PARTICIPATION_ACCOUNTS = {
  income:       '41',
  iva:          '2408',            // línea de IVA → su "Valor base" = base gravable del servicio
  mandate:      '28150601|28051001', // porción del tercero (mandato), 100% suya
  receivable:   '13050501',
  thirdInvoice: '2335',
  payment:      '1120|1110',       // banco: 11200501, 11200504, 1110… (RP al tercero)
} as const

export type ParticipationAccounts = { income?: string; iva?: string; mandate?: string; receivable?: string; thirdInvoice?: string; payment?: string }

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

// ── Estados de la relación (spec §15) ────────────────────────────────────────
// El estado describe la conciliación con el tercero (no el recaudo del cliente,
// que se refleja aparte en `available_for_payment`). Los estados de matching de
// import (PENDIENTE_CLIENTE / PENDIENTE_TERCERO / REVISIÓN_MANUAL) no se guardan:
// corresponden al resultado del import (no_config / no_amount / ambiguous).

export type InvoiceStatus =
  | 'pending_invoice'       // OC del mes sin factura de venta aún
  | 'pending_third_invoice' // PENDIENTE_FACTURA_TERCERO — hay participación, falta la FC del tercero
  | 'value_difference'      // DIFERENCIA_VALOR — la FC del tercero no coincide con lo causado
  | 'pending_payment'       // PENDIENTE_PAGO — FC conciliada, falta el pago (egreso)
  | 'complete'              // COMPLETA — FC conciliada y pagada

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  pending_invoice:       'Pendiente de factura',
  pending_third_invoice: 'Pendiente factura tercero',
  value_difference:      'Diferencia de valor',
  pending_payment:       'Pendiente de pago',
  complete:              'Completa',
}

/**
 * Estado de la participación derivado de los datos (spec §15):
 *   sin FV → pendiente de factura · con FV sin FC → pendiente factura tercero ·
 *   FC parcial (< causado) → pendiente factura tercero · FC > causado →
 *   diferencia de valor · FC = causado con pago < participación → pendiente de
 *   pago · FC = causado con pago acumulado ≥ participación → completa.
 * El recaudo NO cambia el estado; determina cuánto se puede pagar
 * (`available_for_payment`).
 */
export function deriveInvoiceStatus(ip: {
  finto_invoice?: string | null
  finto_invoice_value?: number
  collected?: number
  available_for_payment?: number
  egress_voucher?: string | null
  egress_voucher_value?: number | null
  participation_value?: number
  payment_order?: string | null
  third_party_invoice?: string | null
  third_party_invoice_value?: number | null
}): InvoiceStatus {
  // OC del mes (placeholder) sin factura de venta ni movimientos del tercero
  if ('finto_invoice' in ip && !ip.finto_invoice && !ip.third_party_invoice && !ip.egress_voucher)
    return 'pending_invoice'

  if (!ip.third_party_invoice) return 'pending_third_invoice'

  const part = Number(ip.participation_value ?? 0)
  const tpiVal = Number(ip.third_party_invoice_value ?? 0)
  // FC del tercero por debajo de lo causado → cobertura parcial (una FC del
  // tercero puede repartirse entre varias participaciones): sigue pendiente.
  if (part - tpiVal >= 0.01) return 'pending_third_invoice'
  // FC por encima de lo causado → diferencia de valor (revisión manual).
  if (tpiVal - part >= 0.01) return 'value_difference'

  // Completa solo cuando el pago acumulado cubre la participación. Un pago
  // parcial (egress_voucher_value < participación) sigue pendiente de pago.
  const paid = Number(ip.egress_voucher_value ?? 0)
  return ip.egress_voucher && paid + 0.01 >= part ? 'complete' : 'pending_payment'
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

/**
 * Parsea un número en formato colombiano a `number`: el punto es separador de
 * miles y la coma el decimal ("$33.823.175,51" → 33823175.51). Ignora símbolos
 * de moneda y espacios. Devuelve 0 si no es numérico.
 * Nota: pensado para el reporte consolidado (todos los montos con coma decimal);
 * un valor sin coma se toma como entero ("11200501" → 11200501).
 */
export function parseColombianNumber(v: unknown): number {
  // Si el lector (xlsx) ya lo interpretó como número, se usa tal cual: aplicar el
  // parseo colombiano a "758539.56" quitaría el punto y daría 75853956.
  if (typeof v === 'number') return Number.isFinite(v) ? money(v) : 0
  const s = String(v ?? '').replace(/[^\d.,-]/g, '').trim()
  if (!s) return 0
  const norm = s.replace(/\./g, '').replace(',', '.')
  const n = Number(norm)
  return Number.isFinite(n) ? money(n) : 0
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

// ── Helpers del reporte "Movimiento por cuenta contable" ─────────────────────

const stripAccentsLower = (s: string) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// El reporte "Movimiento por cuenta contable" trae los montos en formato US
// (coma = miles, punto = decimal): "1,047,200.00". Igual que el de egresos.
const mandateAmount = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? money(v) : 0
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? money(n) : 0
}

/** Índice de la primera columna cuyo encabezado contiene alguno de los términos */
function headerCol(header: string[], ...terms: string[]): number {
  return header.findIndex(h => terms.some(t => stripAccentsLower(h).includes(stripAccentsLower(t))))
}

/**
 * Fecha de una celda del reporte "Movimiento por cuenta contable". Este reporte
 * usa el formato US corto M/D/YY (ej. "7/1/26" = 1 jul 2026). Soporta también el
 * serial de Excel y, como respaldo, el DD/MM/YYYY de otros reportes SIIGO.
 * Desambigua día/mes: si el primer campo > 12 es día (D/M), si el segundo > 12 es
 * mes (M/D); ante la duda asume M/D (locale del reporte).
 */
function mandateDateCell(v: unknown): { iso: string; year: number; month: number } | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const iso = excelSerialToISO(Number(s))
    if (!iso) return null
    const [y, m] = iso.split('-')
    return { iso, year: Number(y), month: Number(m) }
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    let a = Number(m[1]), b = Number(m[2])
    const yr = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    let month: number, day: number
    if (a > 12)      { day = a; month = b }   // D/M
    else if (b > 12) { month = a; day = b }   // M/D
    else             { month = a; day = b }   // ambiguo → M/D (US)
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    const iso = `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return { iso, year: yr, month }
  }
  return parseSiigoDate(s)
}

type MandateHeader = { hIdx: number; iCode: number; iNit: number; iComp: number; iDate: number; iDesc: number; iVal: number; iDebito: number; iBase: number; iName: number }

/** Ubica la fila de encabezado del reporte "Movimiento por cuenta contable" y
 *  sus columnas (por nombre, tolera orden). Devuelve hIdx=-1 si no la encuentra.
 *  Soporta el layout con columnas nuevas: "Valor base" y "Nombre tercero". */
function mandateHeader(rows: string[][]): MandateHeader {
  const empty: MandateHeader = { hIdx: -1, iCode: -1, iNit: -1, iComp: -1, iDate: -1, iDesc: -1, iVal: -1, iDebito: -1, iBase: -1, iName: -1 }
  if (!rows.length) return empty
  const hIdx = rows.findIndex(r => {
    const h = (r as unknown[]).map(String)
    return headerCol(h, 'cuentas contables', 'codigo cuenta') >= 0
      && headerCol(h, 'comprobante') >= 0
      && headerCol(h, 'credito', 'valor', 'debito') >= 0
  })
  if (hIdx < 0) return empty
  const header = rows[hIdx]!.map(String)
  const iVal    = headerCol(header, 'credito', 'valor', 'debito')
  // Columna "Débito" separada (para notas débito). -1 si no existe o si es la
  // misma que la de crédito/valor (reporte con una sola columna de monto).
  let iDebito   = headerCol(header, 'debito')
  if (iDebito === iVal) iDebito = -1
  return {
    hIdx,
    iCode: headerCol(header, 'cuentas contables', 'codigo cuenta'),
    iNit:  headerCol(header, 'identificacion', 'nit'),
    iComp: headerCol(header, 'comprobante'),
    iDate: headerCol(header, 'fecha'),
    iDesc: headerCol(header, 'descripcion'),
    iVal,
    iDebito,
    iBase: headerCol(header, 'valor base', 'base'),
    iName: headerCol(header, 'nombre tercero', 'nombre'),
  }
}

/** ¿La cuenta `code` coincide con alguno de los prefijos de `acct` (lista "a|b")? */
const matchAcct = (code: string, acct: string) =>
  acct.split('|').some(a => a && (code === a || code.startsWith(a)))


// ── Parser unificado del "Movimiento por cuenta contable" ─────────────────────
// Un solo reporte alimenta todo el ciclo de participaciones (servicio y mandato),
// clasificando cada fila por (cuenta contable + tipo de comprobante).

/** Venta (FV): por comprobante.
 *  - `income`  : suma de la cuenta 41 (respaldo de base si la FV no tiene IVA).
 *  - `mandate` : porción del mandante (cuenta 28150601) — base del mandato.
 *  - `taxBase` : "Valor base" de la línea de IVA (2408) = base gravable del
 *                servicio. Base de la participación de servicio (con respaldo a
 *                `income` si la FV es exenta / sin IVA).
 *  - `base`    : income + mandate (total de las cuentas de ingreso). */
export type MovSale = {
  fv: string; iso: string; year: number; month: number
  clientNit: string; clientName: string
  income: number; mandate: number; taxBase: number; base: number; descripcion: string
}
/** Nota crédito (NC) sobre la cartera 13050501 — anula/rebaja una factura. */
export type MovCreditNote = { comprobante: string; clientNit: string; clientName: string; iso: string; amount: number; fvRef: string | null }
/** Recaudo (RC) sobre la cartera 13050501 — lo que paga el cliente, por FV. */
export type MovCollection = { fv: string; collected: number; receipts: string[]; iso: string }
/** Factura de compra que envía el tercero (FC) sobre la cuenta 2335. */
export type MovThirdInvoice = { terceroNit: string; terceroName: string; doc: string; iso: string; amount: number; fvRef: string | null }
/** Pago al tercero (RP) por la cuenta de banco 11200504. */
export type MovPayment = { terceroNit: string; rp: string; iso: string; amount: number; fvRef: string | null }

export type AccountingMovement = {
  sales:        MovSale[]
  creditNotes:  MovCreditNote[]   // NC — restan del neto
  debitNotes:   MovCreditNote[]   // ND — suman al neto (misma forma que NC)
  collections:  MovCollection[]
  thirdInvoices: MovThirdInvoice[]
  payments:     MovPayment[]
}

/**
 * Parsea el reporte "Movimiento por cuenta contable" en las etapas del flujo de
 * participaciones. Función pura (sin BD). El cruce con la configuración del
 * cliente/tercero y la escritura ocurren en el servicio.
 *
 * Cuentas por prefijo (ver PARTICIPATION_ACCOUNTS); comprobante determina la etapa:
 *  - FV + cuenta 41 → venta (base servicio) · FV + 28150601 → porción mandato
 *  - RC + cuenta 13050501 → recaudo · NC + cuenta 13050501 → nota crédito
 *  - FC + cuenta 2335 → factura del tercero · RP + cuenta 11200504 → pago al tercero
 */
export function parseAccountingMovement(rows: string[][], accounts?: ParticipationAccounts): AccountingMovement {
  const empty: AccountingMovement = { sales: [], creditNotes: [], debitNotes: [], collections: [], thirdInvoices: [], payments: [] }
  const h = mandateHeader(rows)
  if (h.hIdx < 0) return empty
  const { hIdx, iCode, iNit, iComp, iDate, iDesc, iVal, iDebito, iBase, iName } = h
  const acc = { ...PARTICIPATION_ACCOUNTS, ...accounts }

  const sales = new Map<string, MovSale>()
  const collections = new Map<string, MovCollection>()
  const creditNotes: MovCreditNote[] = []
  const debitNotes: MovCreditNote[] = []
  const thirdInvoices = new Map<string, MovThirdInvoice>()
  const payments = new Map<string, MovPayment>()
  const seenRc = new Set<string>()

  const str = (r: string[], i: number) => (i >= 0 ? String(r[i] ?? '').trim() : '')
  const compType = (comp: string) => comp.slice(0, 2).toUpperCase()

  for (const r of rows.slice(hIdx + 1)) {
    const code = str(r, iCode)
    const comp = str(r, iComp)
    if (!code || !comp) continue
    const type  = compType(comp)
    const nit   = str(r, iNit)
    const name  = str(r, iName)
    const desc  = str(r, iDesc)
    const value = mandateAmount(r[iVal])
    const debito = iDebito >= 0 ? mandateAmount(r[iDebito]) : 0
    const valorBase = iBase >= 0 ? mandateAmount(r[iBase]) : 0
    const d     = iDate >= 0 ? mandateDateCell(r[iDate]) : null
    const ref   = desc ? extractInvoiceRef(desc) : null
    const fvRef = ref ? normalizeSiigoInvoice(ref) : null
    const fvRefOk = fvRef && /^FV/i.test(fvRef) ? fvRef : null

    // ── Venta (FV): por comprobante. Recorre TODAS las líneas de la FV: ingreso
    //    (41), porción mandato (28150601) y las de impuesto, que traen el
    //    "Valor base" = base gravable real del servicio. ──
    if (type === 'FV') {
      const fv = normalizeSiigoInvoice(comp)
      if (!fv) continue
      const g = sales.get(fv) ?? {
        fv, iso: d?.iso ?? '', year: d?.year ?? 0, month: d?.month ?? 0,
        clientNit: nit, clientName: name, income: 0, mandate: 0, taxBase: 0, base: 0, descripcion: '',
      }
      if (!g.iso && d?.iso) { g.iso = d.iso; g.year = d.year; g.month = d.month }
      if (!g.clientNit && nit) g.clientNit = nit
      if (!g.clientName && name) g.clientName = name
      if (matchAcct(code, acc.income))       { g.income  = money(g.income + value);  if (!g.descripcion) g.descripcion = desc }
      else if (matchAcct(code, acc.mandate)) { g.mandate = money(g.mandate + value); if (!g.descripcion) g.descripcion = desc }
      // Base gravable del servicio = "Valor base" de la línea de IVA (no la de
      // retención, que incluiría la porción de mandato). Respaldo: cuenta 41.
      if (matchAcct(code, acc.iva) && valorBase > g.taxBase) g.taxBase = valorBase
      g.base = money(g.income + g.mandate)
      sales.set(fv, g)
      continue
    }

    // ── Recaudo (RC) sobre la cartera 13050501 ───────────────────────────────
    if (type === 'RC' && matchAcct(code, acc.receivable) && fvRefOk && value > 0) {
      const key = `${normalizeInvoiceNumber(comp)}::${normalizeInvoiceNumber(fvRefOk)}`
      if (seenRc.has(key)) continue
      seenRc.add(key)
      const g = collections.get(fvRefOk) ?? { fv: fvRefOk, collected: 0, receipts: [], iso: '' }
      g.collected = money(g.collected + value)
      g.receipts.push(comp)
      if (d?.iso && d.iso > g.iso) g.iso = d.iso
      collections.set(fvRefOk, g)
      continue
    }

    // ── Nota crédito (NC) sobre la cartera 13050501 → resta del neto ─────────
    if (type === 'NC' && matchAcct(code, acc.receivable) && value > 0) {
      creditNotes.push({ comprobante: comp, clientNit: nit, clientName: name, iso: d?.iso ?? '', amount: value, fvRef: fvRefOk })
      continue
    }

    // ── Nota débito (ND) sobre la cartera 13050501 → suma al neto ────────────
    // El monto va por el lado débito si hay columna separada; si no, por el valor.
    if (type === 'ND' && matchAcct(code, acc.receivable)) {
      const amount = debito > 0 ? debito : value
      if (amount > 0) debitNotes.push({ comprobante: comp, clientNit: nit, clientName: name, iso: d?.iso ?? '', amount, fvRef: fvRefOk })
      continue
    }

    // ── Factura del tercero (FC) sobre la cuenta 2335 ────────────────────────
    if (type === 'FC' && matchAcct(code, acc.thirdInvoice) && value > 0) {
      const g = thirdInvoices.get(comp) ?? { terceroNit: nit, terceroName: name, doc: comp, iso: d?.iso ?? '', amount: 0, fvRef: fvRefOk }
      g.amount = money(g.amount + value)
      if (!g.fvRef && fvRefOk) g.fvRef = fvRefOk
      thirdInvoices.set(comp, g)
      continue
    }

    // ── Pago al tercero (RP) por la cuenta de banco 11200504 ─────────────────
    if (type === 'RP' && matchAcct(code, acc.payment) && value > 0) {
      if (payments.has(normalizeInvoiceNumber(comp))) continue
      payments.set(normalizeInvoiceNumber(comp), { terceroNit: nit, rp: comp, iso: d?.iso ?? '', amount: value, fvRef: fvRefOk })
      continue
    }
  }

  return {
    // Descarta FV sin ningún monto de ingreso/mandato/base gravable (ruido)
    sales:        [...sales.values()].filter(s => s.income > 0 || s.mandate > 0 || s.taxBase > 0),
    creditNotes,
    debitNotes,
    collections:  [...collections.values()],
    thirdInvoices: [...thirdInvoices.values()],
    payments:     [...payments.values()],
  }
}
