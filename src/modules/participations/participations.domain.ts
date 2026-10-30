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
  // Anticipo de impuestos (1355…): en un RC son los impuestos que el cliente nos
  // retuvo al pagar — 135515 retefuente, 135517 reteIVA, 135518 reteICA.
  withholding:  '1355',
} as const

export type ParticipationAccounts = { income?: string; iva?: string; mandate?: string; receivable?: string; thirdInvoice?: string; payment?: string; withholding?: string }

/** Impuestos retenidos por el cliente en un recaudo (RC). */
export type CollectionTaxes = { income: number; ica: number; iva: number; total: number }
export const emptyCollectionTaxes = (): CollectionTaxes => ({ income: 0, ica: 0, iva: 0, total: 0 })

/** Clasifica una línea de retención: por la descripción y, si no la nombra,
 *  por la subcuenta PUC (135517 reteIVA, 135518 reteICA, resto retefuente). */
export function withholdingKind(code: string, desc: string): 'income' | 'ica' | 'iva' {
  const d = String(desc ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (/rete\s*-?\s*ica|industria y comercio|\bica\b/.test(d)) return 'ica'
  if (/rete\s*-?\s*iva|\biva\b|impuesto a las ventas/.test(d)) return 'iva'
  if (/rete\s*-?\s*fuente|renta/.test(d)) return 'income'
  if (code.startsWith('135518')) return 'ica'
  if (code.startsWith('135517')) return 'iva'
  return 'income'
}

/**
 * Tarifa (fracción) que trae la descripción de una línea de impuesto:
 * "IVA 19%" → 0.19 · "Retefuente 11%" → 0.11 · "ReteICA 8.66" → 0.00866.
 * ReteICA se expresa POR MIL (8.66‰, 6.9‰, 9.66‰): un número > 1.5 (o con
 * "mil"/"‰") se divide entre 1000; si no, entre 100. Sin número → null.
 */
export function taxRateFromDesc(desc: string, kind: 'income' | 'ica' | 'iva' | 'vat'): number | null {
  const d = String(desc ?? '').toLowerCase()
  const m = d.match(/(\d+(?:[.,]\d+)?)/)
  if (!m) return null
  const n = Number(m[1]!.replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  const perMil = /mil|‰|x\s*1\.?000/.test(d) || (kind === 'ica' && n > 1.5)
  return perMil ? n / 1000 : n / 100
}

/** Monto de una línea de impuesto: lo que traiga (débito o crédito); si viene
 *  vacía, "Valor base" × la tarifa de la descripción. */
function taxLineAmount(debito: number, credito: number, valorBase: number, desc: string, kind: 'income' | 'ica' | 'iva' | 'vat'): number {
  const direct = debito > 0 ? debito : credito
  if (direct > 0) return direct
  if (valorBase <= 0) return 0
  const rate = taxRateFromDesc(desc, kind)
  return rate ? money(valorBase * rate) : 0
}

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

// ── Periodos facturables para la generación de OC ────────────────────────────

export type BillingMode = 'vencido' | 'anticipado'

/** Suma n meses a un periodo 'YYYY-MM' (n puede ser negativo). */
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = ((total % 12) + 12) % 12
  return `${ny}-${String(nm + 1).padStart(2, '0')}`
}

/**
 * Periodos que deben tener OC para una participación, dado el mes de generación.
 * Backfill: desde el mes de inicio del tercero hasta el último periodo facturable.
 *  - anticipado → último periodo = mes de generación.
 *  - vencido    → último periodo = mes anterior al de generación.
 * El primer mes se prorratea: día 1 → 1.0, día 15 → 0.5; los demás → 1.0.
 * Respeta end_date (no genera periodos posteriores a su mes).
 */
export function billedPeriods(input: {
  startDate: string
  billingDay: number
  billingMode: BillingMode
  targetMonth: string           // 'YYYY-MM' del mes de generación
  endDate?: string | null
}): { period: string; proration: number }[] {
  const { startDate, billingDay, billingMode, targetMonth, endDate } = input
  if (!startDate || !/^\d{4}-\d{2}/.test(startDate) || !/^\d{4}-\d{2}$/.test(targetMonth)) return []
  const startMonth = startDate.slice(0, 7)
  let last = billingMode === 'anticipado' ? targetMonth : addMonths(targetMonth, -1)
  if (endDate && /^\d{4}-\d{2}/.test(endDate)) {
    const endMonth = endDate.slice(0, 7)
    if (endMonth < last) last = endMonth
  }
  const out: { period: string; proration: number }[] = []
  let p = startMonth
  for (let i = 0; i < 600 && p <= last; i++, p = addMonths(p, 1)) {
    out.push({ period: p, proration: p === startMonth && billingDay === 15 ? 0.5 : 1 })
  }
  return out
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
export function normalizeInvoiceNumber(n?: string | null): string {
  if (!n) return ''
  return String(n).replace(/[\s.\-_]/g, '').toUpperCase()
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
 * Extrae un período 'YYYY-MM' de un texto libre (ej: "pago mayo", "mes de junio 2026", "2026-05", "05/2026").
 * Si no viene el año en el texto, usa el año de `docDate` o el año actual como fallback.
 * Ignora fechas completas tipo DD/MM/YYYY (ej. "Fecha: 17/06/2026") para no confundirlas con el mes facturado.
 */
export function extractMonthRef(text: string, docDate?: string | null): string | null {
  if (!text) return null

  // 1. Quitar fechas completas (ej: 17/06/2026, 01-05-2025) para no confundir días con meses
  const cleaned = String(text)
    .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

  // 2. Formato explícito YYYY-MM o YYYY/MM (ej: 2026-05, 2026/05)
  const isoMatch = cleaned.match(/\b(202\d)[\/\-](0?[1-9]|1[0-2])\b/)
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]!.padStart(2, '0')}`
  }

  // 3. Formato explícito MM/YYYY precedido o seguido de indicador de mes o período
  const myMatch = cleaned.match(/\b(?:mes|periodo|cuota)?\s*(0?[1-9]|1[0-2])[\/\-](202\d)\b/)
  if (myMatch && myMatch[2]) {
    return `${myMatch[2]}-${myMatch[1]!.padStart(2, '0')}`
  }

  // 4. Meses nombrados en español
  const months: Record<string, string> = {
    enero: '01',
    febrero: '02',
    marzo: '03',
    abril: '04',
    mayo: '05',
    junio: '06',
    julio: '07',
    agosto: '08',
    septiembre: '09',
    setiembre: '09',
    octubre: '10',
    noviembre: '11',
    diciembre: '12',
  }

  // Determinar año: buscar año de 4 dígitos (202x) en el texto
  const yrMatch = cleaned.match(/\b(202\d)\b/)
  let year = yrMatch ? yrMatch[1]! : null
  if (!year) {
    if (docDate && /^\d{4}/.test(docDate)) year = docDate.slice(0, 4)
    else year = String(new Date().getFullYear())
  }

  for (const [name, num] of Object.entries(months)) {
    if (new RegExp(`\\b${name}\\b`).test(cleaned)) {
      return `${year}-${num}`
    }
  }

  return null
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
// Si la celda llega como texto puede venir en formato US ("1,400,000.00") o
// colombiano ("1.400.000,00"); el separador decimal es el ÚLTIMO de los dos que
// aparezca. Con un solo tipo de separador: ",dd" o ".dd" al final es decimal; si
// no (p. ej. "1.400.000" o "500.000"), son miles.
export const mandateAmount = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? money(v) : 0
  let s = String(v ?? '').trim().replace(/[^\d.,-]/g, '')
  if (!s) return 0
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ','
    const thou = dec === '.' ? ',' : '.'
    s = s.split(thou).join('').replace(dec, '.')
  } else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : ''
    if (sep) {
      const parts = s.split(sep)
      const isDecimal = parts.length === 2 && parts[1]!.length > 0 && parts[1]!.length <= 2
      s = isDecimal ? `${parts[0]}.${parts[1]}` : parts.join('')
    }
  }
  const n = Number(s)
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
  // Prioridad Crédito → Valor → Débito (aunque Débito venga antes en el reporte).
  const iCred   = headerCol(header, 'credito')
  const iValor  = header.findIndex(h => { const s = stripAccentsLower(h); return s.includes('valor') && !s.includes('base') })
  const iVal    = iCred >= 0 ? iCred : iValor >= 0 ? iValor : headerCol(header, 'debito')
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
  /** IVA facturado (cuenta 2408): SUMA a lo que paga el cliente. */
  iva: number
  /** Retenciones que practica el cliente (cuenta 1355): RESTAN de lo que paga. */
  withholdings: CollectionTaxes
  /** Débito de la cartera (13050501) en la FV, si el reporte trae columna Débito. */
  receivableDebit: number
  /** Lo que el cliente debe pagar por la FV = base + IVA − retenciones (o el
   *  débito de cartera si viene). Contra esto se mide el % de recaudo. */
  netReceivable: number
}
/** Nota crédito (NC) sobre la cartera 13050501 — anula/rebaja una factura. */
export type MovCreditNote = { comprobante: string; clientNit: string; clientName: string; iso: string; amount: number; fvRef: string | null }
/** Recaudo (RC) sobre la cartera 13050501 — lo que paga el cliente. */
export type MovCollection = {
  receipt: string
  clientNit: string
  clientName: string
  iso: string
  amount: number
  desc: string
  fvRef: string | null
  monthRef: string | null
  // Compatibilidad con código existente:
  fv: string
  collected: number
  receipts: string[]
  /** Impuestos que el cliente retuvo en este recaudo (líneas 1355 del RC). */
  taxes: CollectionTaxes
}
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
  const collections: MovCollection[] = []
  const creditNotes: MovCreditNote[] = []
  const debitNotes: MovCreditNote[] = []
  const thirdInvoices = new Map<string, MovThirdInvoice>()
  const payments = new Map<string, MovPayment>()
  const seenRc = new Map<string, MovCollection>()
  // Retenciones de cada RC (cuenta 1355): se asocian al recaudo al final, porque
  // pueden venir antes o después de la línea de cartera en el reporte.
  const rcTaxes: { comp: string; fvRef: string | null; kind: 'income' | 'ica' | 'iva'; amount: number }[] = []

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
        iva: 0, withholdings: emptyCollectionTaxes(), receivableDebit: 0, netReceivable: 0,
      }
      if (!g.iso && d?.iso) { g.iso = d.iso; g.year = d.year; g.month = d.month }
      if (!g.clientNit && nit) g.clientNit = nit
      if (!g.clientName && name) g.clientName = name
      if (matchAcct(code, acc.income))       { g.income  = money(g.income + value);  if (!g.descripcion) g.descripcion = desc }
      else if (matchAcct(code, acc.mandate)) { g.mandate = money(g.mandate + value); if (!g.descripcion) g.descripcion = desc }
      // Base gravable del servicio = "Valor base" de la línea de IVA (no la de
      // retención, que incluiría la porción de mandato). Respaldo: cuenta 41.
      if (matchAcct(code, acc.iva)) {
        if (valorBase > g.taxBase) g.taxBase = valorBase
        // IVA (crédito): suma a lo que paga el cliente
        g.iva = money(g.iva + taxLineAmount(0, value, valorBase, desc, 'vat'))
      } else if (matchAcct(code, acc.withholding)) {
        // Retención que practica el cliente (débito 1355): resta de lo que paga.
        // Varias líneas del mismo tipo se suman (p. ej. reteICA 8.66 y 6.9).
        const kind = withholdingKind(code, desc)
        const amt = taxLineAmount(debito, value, valorBase, desc, kind)
        g.withholdings[kind] = money(g.withholdings[kind] + amt)
        g.withholdings.total = money(g.withholdings.total + amt)
      } else if (matchAcct(code, acc.receivable) && debito > 0) {
        g.receivableDebit = money(g.receivableDebit + debito)
      }
      g.base = money(g.income + g.mandate)
      // Neto a cobrar: el débito de cartera si el reporte lo trae (exacto); si no,
      // base + IVA − retenciones.
      g.netReceivable = g.receivableDebit > 0 ? g.receivableDebit
        : money(Math.max(0, g.base + g.iva - g.withholdings.total))
      sales.set(fv, g)
      continue
    }

    // ── Recaudo (RC) sobre la cartera 13050501 ───────────────────────────────
    if (type === 'RC' && matchAcct(code, acc.receivable) && value > 0) {
      const monthRef = desc ? extractMonthRef(desc, d?.iso) : null
      const fvTarget = fvRefOk || ''
      // Clave = RC + FV (sin incluir monto). Permite acumular cuotas del mismo
      // recibo hacia la misma factura; evita duplicados verdaderos del reporte.
      const key = `${normalizeInvoiceNumber(comp)}::${normalizeInvoiceNumber(fvTarget)}`
      const existing = seenRc.get(key)
      if (existing) {
        // Acumular: mismo RC, misma FV pero distinto monto (cuotas del mismo recibo)
        existing.amount    = money(existing.amount    + value)
        existing.collected = money(existing.collected + value)
      } else {
        const entry: MovCollection = {
          receipt: comp,
          clientNit: nit,
          clientName: name,
          amount: value,
          iso: d?.iso ?? '',
          desc,
          fvRef: fvRefOk,
          monthRef,
          fv: fvTarget,
          collected: value,
          receipts: [comp],
          taxes: emptyCollectionTaxes(),
        }
        seenRc.set(key, entry)
        collections.push(entry)
      }
      continue
    }

    // ── Impuestos retenidos en el recaudo (RC + 1355): el cliente paga neto y
    //    descuenta retefuente/reteICA/reteIVA. Van por el débito; si el reporte
    //    solo trae Crédito, se estima con "Valor base" × % de la descripción. ──
    if (type === 'RC' && matchAcct(code, acc.withholding)) {
      const kind = withholdingKind(code, desc)
      const amount = taxLineAmount(debito, value, valorBase, desc, kind)
      if (amount > 0) rcTaxes.push({ comp, fvRef: fvRefOk, kind, amount })
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

  // Asocia cada retención a su recaudo: mismo RC y misma FV si la línea la nombra;
  // si no, al primer recaudo de ese RC.
  for (const t of rcTaxes) {
    const sameRc = collections.filter(c => normalizeInvoiceNumber(c.receipt) === normalizeInvoiceNumber(t.comp))
    if (!sameRc.length) continue
    const target = (t.fvRef && sameRc.find(c => c.fvRef && normalizeInvoiceNumber(c.fvRef) === normalizeInvoiceNumber(t.fvRef!))) || sameRc[0]!
    target.taxes[t.kind] = money(target.taxes[t.kind] + t.amount)
    target.taxes.total   = money(target.taxes.total + t.amount)
  }

  return {
    // Descarta FV sin ningún monto de ingreso/mandato/base gravable (ruido)
    sales:        [...sales.values()].filter(s => s.income > 0 || s.mandate > 0 || s.taxBase > 0),
    creditNotes,
    debitNotes,
    collections,
    thirdInvoices: [...thirdInvoices.values()],
    payments:     [...payments.values()],
  }
}

// ── Import idempotente de documentos de dinero (RC/FC/RP) ────────────────────

type MoneyDocRow = {
  id?: string; doc_type: string; comprobante: string; fv_ref?: string | null; amount: number
  tax_income_withholding?: number | null; tax_ica_withholding?: number | null; tax_iva_withholding?: number | null
  [k: string]: any
}

/**
 * Decide qué hacer con los documentos de dinero que trae un import frente a los
 * ya guardados (función pura). Se reconocen por tipo + comprobante:
 *  - misma factura de referencia (fv_ref) → actualizar valor y datos, conservando
 *    fv_ref y lo aplicado.
 *  - fv_ref distinta pero el documento ya está registrado por el mismo valor (se
 *    reasignó a mano) → no insertar de nuevo; sus impuestos van a la fila
 *    reasignada.
 *  - el documento no existe, o el reporte trae una porción nueva → insertar.
 */
export function planMoneyDocs(incoming: MoneyDocRow[], existing: MoneyDocRow[]): { updates: MoneyDocRow[]; inserts: MoneyDocRow[] } {
  const keyOf = (t: string, comp: string) => `${t}::${normalizeInvoiceNumber(comp)}`
  const group = (xs: MoneyDocRow[]) => {
    const m = new Map<string, MoneyDocRow[]>()
    for (const x of xs) { const k = keyOf(x.doc_type, x.comprobante); m.set(k, [...(m.get(k) ?? []), x]) }
    return m
  }
  const existingBy = group(existing)
  const taxKeys = ['tax_income_withholding', 'tax_ica_withholding', 'tax_iva_withholding'] as const
  const meta = (r: MoneyDocRow) => ({
    tercero_nit: r.tercero_nit, tercero_name: r.tercero_name, period: r.period, doc_date: r.doc_date,
    tax_income_withholding: Number(r.tax_income_withholding ?? 0),
    tax_ica_withholding:    Number(r.tax_ica_withholding ?? 0),
    tax_iva_withholding:    Number(r.tax_iva_withholding ?? 0),
    updated_at: r.updated_at,
  })
  const updates: MoneyDocRow[] = []
  const inserts: MoneyDocRow[] = []
  for (const [k, inc] of group(incoming)) {
    const ex = existingBy.get(k) ?? []
    if (!ex.length) { inserts.push(...inc); continue }
    const usedIds = new Set<string>()
    const unmatched: MoneyDocRow[] = []
    for (const r of inc) {
      const same = ex.find(e => !usedIds.has(e.id!) && String(e.fv_ref ?? '').trim() === String(r.fv_ref ?? '').trim())
      if (same) {
        usedIds.add(same.id!)
        updates.push({ id: same.id, doc_type: same.doc_type, comprobante: same.comprobante, fv_ref: same.fv_ref, amount: r.amount, ...meta(r) })
      } else unmatched.push(r)
    }
    if (!unmatched.length) continue
    const exTotal  = money(ex.reduce((s, e) => s + Number(e.amount ?? 0), 0))
    const incTotal = money(inc.reduce((s, r) => s + Number(r.amount ?? 0), 0))
    if (exTotal + 0.01 >= incTotal) {
      const target = ex.find(e => !usedIds.has(e.id!)) ?? ex[0]!
      const sums = Object.fromEntries(taxKeys.map(t => [t, money(unmatched.reduce((s, r) => s + Number(r[t] ?? 0), 0))])) as Record<typeof taxKeys[number], number>
      if (taxKeys.some(t => sums[t] > 0)) {
        const prev = updates.find(u => u.id === target.id)
        if (prev) for (const t of taxKeys) prev[t] = money(Number(prev[t] ?? 0) + sums[t])
        else updates.push({
          id: target.id, doc_type: target.doc_type, comprobante: target.comprobante, fv_ref: target.fv_ref,
          amount: Number(target.amount ?? 0), ...sums, updated_at: unmatched[0]!.updated_at,
        })
      }
    } else inserts.push(...unmatched)
  }
  return { updates, inserts }
}

// ── Porcentaje de participación por vigencia ─────────────────────────────────

export type ParticipationRate = { percentage: number | string; valid_from: string }

/**
 * Porcentaje vigente en una fecha: el de mayor `valid_from` que no sea posterior
 * a `isoDate`. Si la fecha es anterior a todos, el más antiguo; sin historial (o
 * sin fecha), `fallback` (el % actual de la configuración).
 */
/**
 * Desde cuándo rige sin interrupción el último %: si hay registros seguidos con
 * el mismo % (3% ago, 3% oct) vale el primero, no el más reciente.
 */
export function currentRateStart(rates: ParticipationRate[]): string | null {
  const list = [...rates]
    .map(r => ({ pct: Number(r.percentage), from: String(r.valid_from).slice(0, 10) }))
    .sort((a, b) => a.from.localeCompare(b.from))
  if (!list.length) return null
  let i = list.length - 1
  while (i > 0 && list[i - 1]!.pct === list[i]!.pct) i--
  return list[i]!.from
}

/** Comisión de una OC de mandato: el % de su mes (0–100); sin él, la general (0–1). */
export function mandateCommissionRate(percentage: number | null | undefined, generalRate: number): number {
  const pct = Number(percentage ?? 0)
  return pct > 0 ? pct / 100 : generalRate
}

/** Mes del servicio de una FV: en facturación vencida, el mes anterior a la FV. */
export function servicePeriod(isoDate: string, billingMode: BillingMode): string {
  const month = isoDate.slice(0, 7)
  return billingMode === 'vencido' ? addMonths(month, -1) : month
}

/** Reexpresa lo causado con otro %. null si no se conoce el % original. */
export function rescaleParticipation(value: number, oldPct: number, newPct: number): number | null {
  if (!(oldPct > 0)) return null
  return Math.round(value * newPct / oldPct * 100) / 100
}

export function rateAt(rates: ParticipationRate[] | null | undefined, isoDate: string | null | undefined, fallback: number): number {
  const list = [...(rates ?? [])]
    .map(r => ({ pct: Number(r.percentage), from: String(r.valid_from).slice(0, 10) }))
    .filter(r => Number.isFinite(r.pct) && r.from)
    .sort((a, b) => a.from.localeCompare(b.from))
  if (!list.length) return fallback
  if (!isoDate) return list[list.length - 1]!.pct
  const d = String(isoDate).slice(0, 10)
  let pick = list[0]!
  for (const r of list) if (r.from <= d) pick = r
  return pick.pct
}

/** Primer día del mes de una fecha o periodo ('2026-07-15' | '2026-07' → '2026-07-01'). */
export const monthStart = (isoOrPeriod: string) => `${String(isoOrPeriod).slice(0, 7)}-01`
