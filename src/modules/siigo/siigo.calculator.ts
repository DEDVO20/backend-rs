import {
  round2,
  toNumberAbs,
  firstNonEmpty,
  isRetentionTax,
  isIcaTax,
  taxAmountBestEffort,
  normalizeStatus,
  normalizeDateText,
  parseDateSafe,
} from './siigo.helpers.js'
import { SIIGO_CONFIG } from './siigo.config.js'

export type SiigoDocType = 'FACTURA' | 'NOTA_CREDITO'

export interface SiigoCatalogLookup {
  getCustomerName(customerKey: string, sucursal: string): Promise<string>
  getProductDescription(item: Record<string, unknown>): Promise<string>
}

export interface SiigoSalesLineInput {
  siigo_doc_id: string
  line_index: number
  doc_type: SiigoDocType
  comprobante: string
  doc_date: string // YYYY-MM-DD
  period: string   // YYYY-MM
  customer_nit: string
  normalized_nit: string
  company_id: string | null
  sucursal: string
  customer_name: string
  seller_id: string
  product_code: string
  product_description: string
  gross_value: number
  discount: number
  subtotal: number
  tax_charge: number
  tax_retention: number
  total_charges: number
  total_discounts: number
  total: number
}

export type SiigoExcelRow = [
  string,      // 0: No. Comprobante
  Date | null, // 1: Fecha de elaboración
  string,      // 2: Identificación
  string,      // 3: Sucursal
  string,      // 4: Cliente
  string,      // 5: Código producto
  string,      // 6: Descripción producto
  number,      // 7: Valor bruto
  number,      // 8: Descuento
  number,      // 9: Subtotal
  number,      // 10: Impuesto cargo
  number,      // 11: Impuesto retención
  number,      // 12: Cargo en totales
  number,      // 13: Descuento en totales
  number,      // 14: Total
]

export function getComprobanteSiigo(doc: Record<string, any>, docType: SiigoDocType): string {
  const d = (doc.document || {}) as Record<string, any>
  const text = firstNonEmpty([
    doc.name,
    doc.code,
    doc.document_name,
    doc.number_full,
    d.name,
    d.code,
    d.number_full,
    '',
  ])

  if (/^(FV|NC)-/i.test(text)) {
    return text
  }

  const number = firstNonEmpty([
    d.number,
    d.consecutive,
    doc.number,
    doc.consecutive,
    doc.numero,
  ])

  if (docType === 'NOTA_CREDITO') {
    return number ? `NC-2-${number}` : text
  }

  return number ? `FV-2-${number}` : text
}

export function getSellerId(doc: Record<string, any>): string {
  const s = doc.seller
  if (typeof s === 'number') return String(s)
  if (typeof s === 'string') return s.trim()
  if (s && typeof s === 'object') {
    return String(s.id || s.identification || s.code || '').trim()
  }
  return ''
}

export function getCustomerKey(doc: Record<string, any>): string {
  const c = doc.customer
  if (!c) return ''
  if (typeof c === 'string') return c.trim()
  if (typeof c === 'object') {
    return String(c.identification || c.id || c.customer_id || c.code || '').trim()
  }
  return ''
}

export function getCustomerSucursal(doc: Record<string, any>): string {
  const c = doc.customer
  if (c && typeof c === 'object') {
    return String(c.branch_office || c.branchOffice || c.branch || '').trim()
  }
  return ''
}

export function customerNameFromObject(c: Record<string, any> | null | undefined): string {
  if (!c || typeof c !== 'object') return ''
  if (Array.isArray(c.name)) {
    return c.name.join(' ').replace(/\s+/g, ' ').trim()
  }
  const direct = firstNonEmpty([
    c.name,
    c.business_name,
    c.commercial_name,
    c.company_name,
    c.full_name,
    c.social_reason,
    c.razon_social,
  ])
  if (direct) return direct

  const person = [c.first_name, c.middle_name, c.last_name, c.second_last_name]
    .filter(x => x !== null && x !== undefined && String(x).trim() !== '')

  if (person.length) {
    return person.join(' ').replace(/\s+/g, ' ').trim()
  }
  return ''
}

export function getCustomerNameInline(doc: Record<string, any>): string {
  const c = doc.customer
  if (c && typeof c === 'object') {
    return customerNameFromObject(c)
  }
  return ''
}

export function getCodigoProductoFromItem(it: Record<string, any> | null | undefined): string {
  if (!it || typeof it !== 'object') return ''
  const product = (it.product || it.item || it.service || {}) as Record<string, any>
  return String(firstNonEmpty([
    product.code,
    product.identification,
    product.reference,
    product.sku,
    it.code,
    it.product_code,
    it.item_code,
    it.service_code,
    it.reference,
    it.sku,
    '',
  ])).trim()
}

export function getProductIdFromItem(it: Record<string, any> | null | undefined): string {
  if (!it || typeof it !== 'object') return ''
  const product = (it.product || it.item || it.service || {}) as Record<string, any>
  return String(firstNonEmpty([
    product.id,
    product.uuid,
    it.product_id,
    it.item_id,
    it.service_id,
    '',
  ])).trim()
}

export function descripcionProductoInline(it: Record<string, any> | null | undefined): string {
  if (!it || typeof it !== 'object') return ''
  const product = (it.product || it.item || it.service || {}) as Record<string, any>
  return firstNonEmpty([
    product.name,
    product.description,
    product.display_name,
    product.product_name,
    product.item_name,
    product.service_name,
    it.description,
    it.name,
    '',
  ])
}

export function descripcionDesdeProductoCatalogo(p: Record<string, any> | null | undefined): string {
  if (!p || typeof p !== 'object') return ''
  return firstNonEmpty([
    p.name,
    p.description,
    p.display_name,
    p.commercial_name,
    p.product_name,
    p.item_name,
    p.service_name,
    '',
  ])
}

export function calcVentaItemSiigo(it: Record<string, any>) {
  let bruto = toNumberAbs(firstNonEmpty([it.subtotal, it.base_value, it.base, '']))
  if (bruto <= 0) {
    const qty = toNumberAbs(firstNonEmpty([it.quantity, 1]))
    const price = toNumberAbs(firstNonEmpty([it.price, it.unit_price, it.value, 0]))
    bruto = qty * price
  }

  const descuento = toNumberAbs(
    it.discount && typeof it.discount === 'object'
      ? firstNonEmpty([it.discount.value, it.discount.amount, 0])
      : firstNonEmpty([it.discount_value, it.discount, 0]),
  )

  let impuestoCargo = 0
  let impuestoRetencion = 0

  const taxes = Array.isArray(it.taxes) ? it.taxes : []
  for (const tx of taxes) {
    const amount = taxAmountBestEffort(tx)
    if (isRetentionTax(tx)) {
      if (!isIcaTax(tx)) {
        impuestoRetencion += amount
      }
    } else {
      impuestoCargo += amount
    }
  }

  const withholdingTaxes = ([] as unknown[])
    .concat(Array.isArray(it.withholding_taxes) ? it.withholding_taxes : [])
    .concat(Array.isArray(it.retentions) ? it.retentions : [])
    .concat(Array.isArray(it.retention) ? it.retention : [])

  for (const r of withholdingTaxes) {
    if (!isIcaTax(r)) {
      impuestoRetencion += taxAmountBestEffort(r)
    }
  }

  bruto = round2(bruto)
  const descuentoRedondeado = round2(descuento)
  impuestoCargo = round2(impuestoCargo)
  impuestoRetencion = round2(impuestoRetencion)
  const subtotal = round2(bruto - descuentoRedondeado)

  return {
    bruto,
    descuento: descuentoRedondeado,
    subtotal,
    impuestoCargo,
    impuestoRetencion,
  }
}

export function totalGlobalRetentions(doc: Record<string, any>): number {
  let total = 0
  const globalRetentions = ([] as unknown[])
    .concat(Array.isArray(doc.withholding_taxes) ? doc.withholding_taxes : [])
    .concat(Array.isArray(doc.retentions) ? doc.retentions : [])
    .concat(Array.isArray(doc.retention) ? doc.retention : [])

  for (const r of globalRetentions) {
    if (!isIcaTax(r)) {
      total += taxAmountBestEffort(r)
    }
  }
  return round2(total)
}

export function totalCharges(doc: Record<string, any>): number {
  let total = 0
  const arrays = [doc.charges, doc.additional_charges]
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const x of arr) {
        total += toNumberAbs(
          typeof x === 'object' && x !== null
            ? firstNonEmpty([(x as any).value, (x as any).amount, (x as any).total, 0])
            : x,
        )
      }
    }
  }
  return round2(total)
}

export function totalDiscounts(doc: Record<string, any>): number {
  let total = 0
  const arrays = [doc.discounts, doc.global_discounts]
  for (const arr of arrays) {
    if (Array.isArray(arr)) {
      for (const x of arr) {
        total += toNumberAbs(
          typeof x === 'object' && x !== null
            ? firstNonEmpty([(x as any).value, (x as any).amount, (x as any).total, 0])
            : x,
        )
      }
    }
  }
  return round2(total)
}

export function calcVentaSiigo(doc: Record<string, any>) {
  let bruto = 0
  let descuento = 0
  let impuestoCargo = 0
  let impuestoRetencion = 0

  const items = Array.isArray(doc.items) ? doc.items : []
  for (const it of items) {
    const calc = calcVentaItemSiigo(it)
    bruto += calc.bruto
    descuento += calc.descuento
    impuestoCargo += calc.impuestoCargo
    impuestoRetencion += calc.impuestoRetencion
  }

  impuestoRetencion += totalGlobalRetentions(doc)
  const cargoTotales = totalCharges(doc)
  const descuentoTotales = totalDiscounts(doc)

  bruto = round2(bruto)
  descuento = round2(descuento)
  impuestoCargo = round2(impuestoCargo)
  impuestoRetencion = round2(impuestoRetencion)
  const subtotal = round2(bruto - descuento)

  const total = round2(
    subtotal +
    impuestoCargo -
    impuestoRetencion +
    cargoTotales -
    descuentoTotales,
  )

  return {
    bruto,
    descuento,
    subtotal,
    impuestoCargo,
    impuestoRetencion,
    cargoTotales,
    descuentoTotales,
    total,
  }
}

export function totalDocumentoParaCuadre(doc: Record<string, any>, calcDoc: { total?: number }): number {
  const totalDirecto = toNumberAbs(firstNonEmpty([
    doc.total,
    doc.total_value,
    doc.total_amount,
    doc.amount,
    doc.value,
    '',
  ]))

  if (totalDirecto > 0) return round2(totalDirecto)
  return calcDoc && calcDoc.total !== undefined ? round2(calcDoc.total) : 0
}

export function distribuirValorPorProducto(total: number, bases: number[]): number[] {
  const totalRedondeado = round2(total)
  if (!Array.isArray(bases) || !bases.length) return []
  if (totalRedondeado === 0) {
    return bases.map(() => 0)
  }

  const sumaBases = bases.reduce((acc, n) => acc + (Number(n) || 0), 0)
  const result: number[] = []
  let acumulado = 0

  for (let i = 0; i < bases.length; i++) {
    let valor: number
    if (i === bases.length - 1) {
      valor = round2(totalRedondeado - acumulado)
    } else {
      if (sumaBases > 0) {
        valor = round2(totalRedondeado * ((Number(bases[i]) || 0) / sumaBases))
      } else {
        valor = round2(totalRedondeado / bases.length)
      }
      acumulado = round2(acumulado + valor)
    }
    result.push(valor)
  }
  return result
}

export async function buildVentaLinesPorProducto(
  doc: Record<string, any>,
  docType: SiigoDocType,
  sign: 1 | -1,
  apiHelper: SiigoCatalogLookup,
  startDate: string,
  endDate: string,
  sellerFilter = '',
): Promise<Omit<SiigoSalesLineInput, 'normalized_nit' | 'company_id'>[]> {
  const status = normalizeStatus(doc.status || doc.state)
  if (SIIGO_CONFIG.STATUS_EXCLUDE.has(status)) return []

  const fechaText = normalizeDateText(
    firstNonEmpty([doc.date, doc.created, doc.created_at, doc.invoice_date]),
  )

  if (!fechaText || fechaText < startDate || fechaText > endDate) return []

  const sellerId = getSellerId(doc)
  if (sellerFilter && sellerId && String(sellerId) !== String(sellerFilter)) {
    return []
  }

  const siigoDocId = String(doc.id || doc.uuid || getComprobanteSiigo(doc, docType))
  const comprobante = getComprobanteSiigo(doc, docType)
  const customerKey = getCustomerKey(doc)
  const rawSucursal = getCustomerSucursal(doc)
  const sucursal = rawSucursal === '0' ? '' : rawSucursal
  let customerName = getCustomerNameInline(doc)

  if (!customerName && customerKey) {
    customerName = await apiHelper.getCustomerName(customerKey, rawSucursal)
  }

  const period = fechaText.slice(0, 7)
  const items = Array.isArray(doc.items) ? doc.items : []

  if (!items.length) {
    const calcDocSinItems = calcVentaSiigo(doc)
    const totalDocSinItems = totalDocumentoParaCuadre(doc, calcDocSinItems)

    return [{
      siigo_doc_id:        siigoDocId,
      line_index:          0,
      doc_type:            docType,
      comprobante,
      doc_date:            fechaText,
      period,
      customer_nit:        customerKey,
      sucursal,
      customer_name:       customerName,
      seller_id:           sellerId,
      product_code:        '',
      product_description: 'SIN PRODUCTO',
      gross_value:         round2(calcDocSinItems.bruto * sign),
      discount:            round2(calcDocSinItems.descuento * sign),
      subtotal:            round2(calcDocSinItems.subtotal * sign),
      tax_charge:          round2(calcDocSinItems.impuestoCargo * sign),
      tax_retention:       round2(calcDocSinItems.impuestoRetencion * sign),
      total_charges:       round2(calcDocSinItems.cargoTotales * sign),
      total_discounts:     round2(calcDocSinItems.descuentoTotales * sign),
      total:               round2(totalDocSinItems * sign),
    }]
  }

  const calcDoc = calcVentaSiigo(doc)
  const totalDoc = totalDocumentoParaCuadre(doc, calcDoc)
  const itemCalcs = items.map(it => calcVentaItemSiigo(it))

  const basesParaDistribuir = itemCalcs.map(c => Math.max(0, c.subtotal || c.bruto || 0))
  const cargosAsignados = distribuirValorPorProducto(totalCharges(doc), basesParaDistribuir)
  const descuentosAsignados = distribuirValorPorProducto(totalDiscounts(doc), basesParaDistribuir)
  const retencionesGlobalesAsignadas = distribuirValorPorProducto(totalGlobalRetentions(doc), basesParaDistribuir)

  const lineas: {
    codigoProducto: string
    descripcionProducto: string
    bruto: number
    descuento: number
    subtotal: number
    impuestoCargo: number
    impuestoRetencion: number
    cargoTotales: number
    descuentoTotales: number
    total: number
  }[] = []

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const calc = itemCalcs[i]!
    const codigoProducto = getCodigoProductoFromItem(it)
    const descripcionProducto = await apiHelper.getProductDescription(it)

    const cargoTotales = cargosAsignados[i] || 0
    const descuentoTotales = descuentosAsignados[i] || 0
    const retencionGlobal = retencionesGlobalesAsignadas[i] || 0

    const totalLinea = round2(
      calc.subtotal +
      calc.impuestoCargo -
      calc.impuestoRetencion -
      retencionGlobal +
      cargoTotales -
      descuentoTotales,
    )

    lineas.push({
      codigoProducto,
      descripcionProducto,
      bruto:             round2(calc.bruto),
      descuento:         round2(calc.descuento),
      subtotal:          round2(calc.subtotal),
      impuestoCargo:     round2(calc.impuestoCargo),
      impuestoRetencion: round2(calc.impuestoRetencion + retencionGlobal),
      cargoTotales:      round2(cargoTotales),
      descuentoTotales:  round2(descuentoTotales),
      total:             round2(totalLinea),
    })
  }

  // Cuadre del total del documento con la suma de las líneas
  const sumaLineas = round2(lineas.reduce((acc, x) => acc + (Number(x.total) || 0), 0))
  const diferencia = round2(totalDoc - sumaLineas)
  if (lineas.length && diferencia !== 0) {
    const last = lineas[lineas.length - 1]!
    last.total = round2(last.total + diferencia)
  }

  return lineas.map((linea, idx) => ({
    siigo_doc_id:        siigoDocId,
    line_index:          idx,
    doc_type:            docType,
    comprobante,
    doc_date:            fechaText,
    period,
    customer_nit:        customerKey,
    sucursal,
    customer_name:       customerName,
    seller_id:           sellerId,
    product_code:        linea.codigoProducto,
    product_description: linea.descripcionProducto,
    gross_value:         round2(linea.bruto * sign),
    discount:            round2(linea.descuento * sign),
    subtotal:            round2(linea.subtotal * sign),
    tax_charge:          round2(linea.impuestoCargo * sign),
    tax_retention:       round2(linea.impuestoRetencion * sign),
    total_charges:       round2(linea.cargoTotales * sign),
    total_discounts:     round2(linea.descuentoTotales * sign),
    total:               round2(linea.total * sign),
  }))
}

export function lineToExcelRow(line: {
  comprobante: string
  doc_date: string
  customer_nit: string
  sucursal: string
  customer_name: string
  product_code: string
  product_description: string
  gross_value: number
  discount: number
  subtotal: number
  tax_charge: number
  tax_retention: number
  total_charges: number
  total_discounts: number
  total: number
}): SiigoExcelRow {
  return [
    line.comprobante,
    parseDateSafe(line.doc_date),
    line.customer_nit,
    line.sucursal === '0' ? '' : (line.sucursal || ''),
    line.customer_name,
    line.product_code,
    line.product_description,
    round2(line.gross_value),
    round2(line.discount),
    round2(line.subtotal),
    round2(line.tax_charge),
    round2(line.tax_retention),
    round2(line.total_charges),
    round2(line.total_discounts),
    round2(line.total),
  ]
}
