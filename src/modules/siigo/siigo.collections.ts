/**
 * Recaudo Siigo — lógica de movimientos de recibos de caja (vouchers RC).
 *
 * Port del script "SIIGO -> GOOGLE SHEETS · RECAUDO - API OFICIAL DE VOUCHERS - V4":
 * - items[].value es el valor principal del movimiento.
 * - items[].due identifica el vencimiento aplicado cuando existe.
 * - taxes[] y discounts[] son ajustes informativos: NO se suman al valor aplicado.
 * - payment.value se usa solo cuando el voucher no trae items con valor (y una sola vez).
 * - Conserva FV, CC, RC y cualquier prefijo real que venga en due.
 * - Conserva items con value aunque due sea nulo.
 * - Producto facturado es solo informativo y nunca altera el valor.
 *
 * Este módulo no hace llamadas HTTP directas: las consultas de facturas se inyectan
 * mediante `CollectionInvoiceLookup`, lo que permite probar la lógica de forma aislada.
 */
import { round2, toNumber } from './siigo.helpers.js'

export const TOLERANCIA = 0.005

type Obj = Record<string, any>

export interface DueInfo {
  vencimientoCompleto: string
  documentoBase: string
  quote: string | number
  dueDate: string
}

export type MovementClass = 'ITEM' | 'ANTICIPO' | 'OTRO_INGRESO' | 'PAGO_SIN_ITEMS'

export interface CollectionMovement {
  clase: MovementClass
  vencimiento: string
  documentoBase: string
  quote: string | number
  dueDate: string
  valor: number
  cuenta: string
  descripcion: string
  indiceItem: number
  origenSinDue: boolean
}

/** Consultas a Siigo que necesita la resolución de movimientos sin due */
export interface CollectionInvoiceLookup {
  /** Total de la factura (FV-x-n) o 0 si no se encuentra */
  getInvoiceTotal(ref: string): Promise<number>
}

/** Estado cronológico para resolver movimientos de cartera sin items[].due */
export interface ResolutionState {
  historialFacturas: Record<string, { orden: string[]; porFactura: Record<string, { ref: string; aplicado: number }> }>
  saldosClientes2805: { ref: string; disponible: number }[]
}

export function newResolutionState(): ResolutionState {
  return { historialFacturas: {}, saldosClientes2805: [] }
}

/* ───────────────────────────── utilidades ───────────────────────────── */

export function primeroNoVacio(arr: unknown[]): any {
  for (const v of arr) {
    if (v === null || v === undefined) continue
    if (String(v).trim() !== '') return v
  }
  return ''
}

export function convertirNumero(x: unknown): number {
  if (x && typeof x === 'object' && (x as Obj).amount === undefined && (x as Obj).value === undefined &&
      (x as Obj).total === undefined && (x as Obj).balance !== undefined) {
    return toNumber((x as Obj).balance)
  }
  return toNumber(x)
}

export function normalizarTextoComparacion(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '')
}

export function normalizarDocumento(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

export function normalizarFecha(value: unknown): string {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const s = String(value).trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10)
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[3]}-${('0' + m[2]).slice(-2)}-${('0' + m[1]).slice(-2)}`
  return s.substring(0, 10)
}

export function listaUnica(arr: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of arr ?? []) {
    const s = String(x ?? '').trim()
    if (!s) continue
    const k = normalizarTextoComparacion(s)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

export function clonar<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj
  try {
    return JSON.parse(JSON.stringify(obj))
  } catch {
    return { ...(obj as any) }
  }
}

/** Combina b sobre a sin perder los valores de a cuando b los trae vacíos */
export function mezclarObjetosSinPerder(a: Obj | null | undefined, b: Obj | null | undefined): Obj {
  const A = a ?? {}
  const B = b ?? {}
  const out: Obj = { ...A, ...B }
  for (const k of Object.keys(A)) {
    const vb = B[k]
    if (vb === undefined || vb === null || vb === '' || (Array.isArray(vb) && vb.length === 0)) {
      out[k] = A[k]
    }
  }
  return out
}

export function fechaVoucher(v: Obj | null | undefined): string {
  return normalizarFecha(primeroNoVacio([v?.date, v?.metadata?.created, v?.created, '']))
}

/* ───────────────────────────── cuentas y valores ───────────────────────────── */

export function codigoCuentaItem(item: Obj | null | undefined): string {
  const it = item ?? {}
  const candidatos = [
    it.account,
    it.accounting_account,
    it.account_code,
    it.account_number,
    it.due?.account,
    it.due?.accounting_account,
  ]
  for (const c of candidatos) {
    if (c === null || c === undefined || c === '') continue
    if (typeof c === 'string' || typeof c === 'number') {
      const s = String(c).trim()
      if (s) return s
    }
    if (typeof c === 'object') {
      const s = String(c.code || c.account_code || c.number || c.account_number || '').trim()
      if (s) return s
    }
  }
  return ''
}

export function codigoCuentaMovimientoVoucher(voucher: Obj | null | undefined): string {
  const v = voucher ?? {}
  for (const c of [v.account, v.income?.account, v.payment?.account]) {
    if (!c) continue
    if (typeof c === 'string' || typeof c === 'number') return String(c).trim()
    if (typeof c === 'object') {
      const s = String(c.code || c.account_code || c.number || '').trim()
      if (s) return s
    }
  }
  return ''
}

/** Según el modelo oficial ItemVoucher el valor del item es `value` (no amount/total/balance) */
export function obtenerValorItem(item: Obj | null | undefined): number {
  const it = item ?? {}
  if (it.value === undefined || it.value === null || it.value === '') return 0
  return convertirNumero(it.value)
}

function obtenerValorAjuste(x: Obj | null | undefined): number {
  const it = x ?? {}
  return convertirNumero(primeroNoVacio([it.value, it.amount, it.total, 0]))
}

/** payment.value solo cuando no hubo items con value; payments[] como compatibilidad */
export function valorVoucherSinItems(voucher: Obj | null | undefined): number {
  const v = voucher ?? {}
  if (v.payment && v.payment.value !== undefined) {
    const val = Math.abs(convertirNumero(v.payment.value))
    if (val > TOLERANCIA) return val
  }
  if (Array.isArray(v.payments) && v.payments.length) {
    const total = v.payments.reduce((acc: number, p: Obj) => acc + Math.abs(convertirNumero(p?.value)), 0)
    if (total > TOLERANCIA) return total
  }
  return 0
}

/* ───────────────────────────── due / documento aplicado ───────────────────────────── */

function parecePrefijoDocumento(x: unknown): boolean {
  return /^(FV|CC|RC)(-|$)/i.test(String(x ?? '').trim())
}

function pareceDocumentoAplicado(x: unknown): boolean {
  return /^(FV|CC|RC)-/i.test(String(x ?? '').trim())
}

export function dueDesdeTexto(texto: unknown, contexto: Obj = {}): DueInfo | null {
  const raw = String(texto ?? '').trim()
  if (!raw || !pareceDocumentoAplicado(raw)) return null

  let quote: string | number = primeroNoVacio([contexto.quote, contexto.installment, contexto.fee, ''])
  const dueDate = normalizarFecha(primeroNoVacio([contexto.due_date, contexto.expiration_date, '']))
  let base = raw

  if (quote !== '' && raw.endsWith('-' + String(quote))) {
    base = raw.substring(0, raw.length - String(quote).length - 1)
  } else {
    let m = raw.match(/^(FV-.+)-(\d+)-(\d+)$/i)
    if (m) {
      base = `${m[1]}-${m[2]}`
      quote = m[3]!
    } else {
      m = raw.match(/^((?:CC|RC)-.+)-(\d+)$/i)
      if (m) {
        base = m[1]!
        quote = m[2]!
      }
    }
  }

  const full = quote !== '' && !raw.endsWith('-' + String(quote)) ? `${base}-${quote}` : raw
  return { vencimientoCompleto: full, documentoBase: base, quote, dueDate }
}

export function normalizarDue(due: unknown, contexto: Obj = {}): DueInfo | null {
  if (due === null || due === undefined || due === '') return null
  if (typeof due === 'string' || typeof due === 'number') return dueDesdeTexto(String(due).trim(), contexto)
  if (typeof due !== 'object' || Array.isArray(due)) return null

  const d = due as Obj
  const prefix = String(primeroNoVacio([d.prefix, d.document_prefix, d.prefijo, '']) || '').trim().replace(/-+$/, '')
  const consecutive = primeroNoVacio([d.consecutive, d.number, d.document_number, d.numero, ''])
  const quote = primeroNoVacio([d.quote, d.installment, d.fee, contexto.quote, contexto.installment, contexto.fee, ''])
  const dueDate = normalizarFecha(primeroNoVacio([d.date, d.due_date, d.expiration_date, contexto.due_date, contexto.expiration_date, '']))

  if (prefix && consecutive !== '') {
    const base = `${prefix}-${String(consecutive).trim()}`
    const full = base + (quote !== '' ? '-' + String(quote).trim() : '')
    return { vencimientoCompleto: full, documentoBase: base, quote, dueDate }
  }

  const texto = String(primeroNoVacio([d.name, d.code, d.document_name, d.document, d.reference, '']) || '').trim()
  if (texto && pareceDocumentoAplicado(texto)) {
    return dueDesdeTexto(texto, { ...contexto, quote, due_date: dueDate })
  }
  return null
}

export function extraerReferenciaDocumentoTexto(texto: unknown): string {
  const s = String(texto ?? '').trim()
  if (!s) return ''
  let m = s.match(/\bFV-[A-Za-z0-9]+-\d+(?:-\d+)?\b/i)
  if (m) return m[0].toUpperCase()
  m = s.match(/\b(?:CC|RC)-[A-Za-z0-9]+(?:-\d+){1,2}\b/i)
  if (m) return m[0].toUpperCase()
  return ''
}

function referenciaDocumentoDesdeItem(item: Obj | null | undefined): string {
  const it = item ?? {}
  const candidatos = [
    it.reference_document, it.document_name, it.invoice_name, it.receivable_name,
    it.due_name, it.due_number, it.reference, it.code, it.name,
  ]
  for (const c of candidatos) {
    const ref = extraerReferenciaDocumentoTexto(c)
    if (ref) return ref
  }
  return ''
}

/** Lee el vencimiento aplicado de forma defensiva (item.due y campos auxiliares del listado) */
export function extraerDueFlexible(item: Obj | null | undefined): DueInfo | null {
  const it = item ?? {}
  const candidatos = [it.due, it.receivable, it.invoice, it.document, it.document_due, it.due_document, it.account_receivable]

  for (const d of candidatos) {
    if (d === null || d === undefined || d === '' || Array.isArray(d)) continue
    const info = normalizarDue(d, it)
    if (info?.vencimientoCompleto) return info
  }

  if (it.prefix !== undefined && it.consecutive !== undefined && parecePrefijoDocumento(it.prefix)) {
    const infoPlano = normalizarDue({
      prefix: it.prefix,
      consecutive: it.consecutive,
      quote: primeroNoVacio([it.quote, it.installment, it.fee, '']),
      date: primeroNoVacio([it.due_date, it.expiration_date, it.date, '']),
    }, it)
    if (infoPlano?.vencimientoCompleto) return infoPlano
  }

  const ref = referenciaDocumentoDesdeItem(it)
  if (ref) {
    const infoRef = dueDesdeTexto(ref, it)
    if (infoRef?.vencimientoCompleto) return infoRef
  }
  return null
}

/* ───────────────────────────── fusión de vouchers ───────────────────────────── */

function firmaAjuste(x: Obj | null | undefined): string {
  const it = x ?? {}
  return [String(it.id || ''), String(it.name || ''), String(it.type || ''), round2(obtenerValorAjuste(it)).toFixed(2), codigoCuentaItem(it)].join(':')
}

function deduplicarAjustes(lista: Obj[]): Obj[] {
  const vistos = new Set<string>()
  return (lista ?? []).filter(x => {
    const k = firmaAjuste(x)
    if (vistos.has(k)) return false
    vistos.add(k)
    return true
  })
}

function obtenerListaTaxes(item: Obj | null | undefined): Obj[] {
  if (!item) return []
  const salida: Obj[] = []
  if (Array.isArray(item.taxes)) salida.push(...item.taxes.filter(Boolean))
  if (item.tax && typeof item.tax === 'object') salida.push(item.tax)
  return deduplicarAjustes(salida)
}

function obtenerListaDiscounts(item: Obj | null | undefined): Obj[] {
  if (!item) return []
  const salida: Obj[] = []
  if (Array.isArray(item.discounts)) salida.push(...item.discounts.filter(Boolean))
  if (item.discount && typeof item.discount === 'object') salida.push(item.discount)
  return deduplicarAjustes(salida)
}

function combinarAjustesPorOcurrencia(lista1: Obj[], lista2: Obj[]): Obj[] {
  const salida: Obj[] = []
  const conteo: Record<string, number> = {}

  const agregar = (lista: Obj[], fusionarContraExistente: boolean) => {
    const local: Record<string, number> = {}
    for (const x of lista ?? []) {
      if (!x) continue
      const k = firmaAjuste(x)
      local[k] = (local[k] || 0) + 1
      const objetivo = fusionarContraExistente ? Math.max(conteo[k] || 0, local[k]!) : local[k]!
      if ((conteo[k] || 0) < objetivo) {
        salida.push(clonar(x))
        conteo[k] = (conteo[k] || 0) + 1
      }
    }
  }

  agregar(lista1 ?? [], false)
  agregar(lista2 ?? [], true)
  return salida
}

export function itemsVoucherEquivalentes(a: Obj | null | undefined, b: Obj | null | undefined): boolean {
  const A = a ?? {}
  const B = b ?? {}
  const dueA = normalizarDocumento(extraerDueFlexible(A)?.vencimientoCompleto)
  const dueB = normalizarDocumento(extraerDueFlexible(B)?.vencimientoCompleto)
  const valorA = Math.abs(obtenerValorItem(A))
  const valorB = Math.abs(obtenerValorItem(B))
  const cuentaA = codigoCuentaItem(A)
  const cuentaB = codigoCuentaItem(B)

  if (dueA && dueB && dueA !== dueB) return false
  if ((dueA && !dueB) || (!dueA && dueB)) return false
  if (valorA > TOLERANCIA && valorB > TOLERANCIA && Math.abs(valorA - valorB) > TOLERANCIA) return false
  if (cuentaA && cuentaB && cuentaA !== cuentaB) return false

  if (!dueA && !dueB) {
    const descA = normalizarTextoComparacion(A.description || A.name || A.code || '')
    const descB = normalizarTextoComparacion(B.description || B.name || B.code || '')
    if (descA && descB && descA !== descB) return false
  }
  return true
}

/** Une items por ocurrencia: no duplica el mismo movimiento visto en listado/nombre/detalle */
export function combinarItemsVoucher(itemsA: Obj[] | undefined, itemsB: Obj[] | undefined): Obj[] {
  const base = (Array.isArray(itemsA) ? itemsA : []).map(clonar)
  const usados = new Array<boolean>(base.length).fill(false)

  for (const itemB of Array.isArray(itemsB) ? itemsB : []) {
    let pos = -1
    for (let i = 0; i < base.length; i++) {
      if (!usados[i] && itemsVoucherEquivalentes(base[i], itemB)) {
        pos = i
        break
      }
    }

    if (pos >= 0) {
      usados[pos] = true
      const merged = mezclarObjetosSinPerder(base[pos], itemB)
      merged.taxes = combinarAjustesPorOcurrencia(obtenerListaTaxes(base[pos]), obtenerListaTaxes(itemB))
      merged.discounts = combinarAjustesPorOcurrencia(obtenerListaDiscounts(base[pos]), obtenerListaDiscounts(itemB))
      if (!merged.tax && base[pos]!.tax) merged.tax = base[pos]!.tax
      if (!merged.discount && base[pos]!.discount) merged.discount = base[pos]!.discount
      base[pos] = merged
    } else {
      base.push(clonar(itemB))
      usados.push(true)
    }
  }
  return base
}

/** Fusiona vouchers por id/uuid/nombre sin perder items de ninguna respuesta */
export function fusionarListaVouchers(docs: Obj[]): Obj[] {
  const mapa = new Map<string, Obj>()

  for (const doc of docs ?? []) {
    if (!doc) continue
    const clave = String(doc.id || doc.uuid || doc.name || '').trim()
    if (!clave) continue

    const anterior = mapa.get(clave)
    if (!anterior) {
      mapa.set(clave, { ...doc, items: Array.isArray(doc.items) ? doc.items.map(clonar) : [] })
      continue
    }
    const combinado = mezclarObjetosSinPerder(anterior, doc)
    combinado.items = combinarItemsVoucher(anterior.items, Array.isArray(doc.items) ? doc.items : [])
    mapa.set(clave, combinado)
  }
  return Array.from(mapa.values())
}

/** Integra al voucher acumulado otra respuesta (consulta por nombre o detalle por UUID) */
export function fusionarRespuestaVoucher(combinado: Obj, otro: Obj | null | undefined): Obj {
  if (!otro) return combinado
  const idA = String(combinado.id || combinado.uuid || '').trim()
  const idB = String(otro.id || otro.uuid || '').trim()
  if (idA && idB && idA !== idB) return combinado
  const out = mezclarObjetosSinPerder(combinado, otro)
  out.items = combinarItemsVoucher(combinado.items ?? [], Array.isArray(otro.items) ? otro.items : [])
  return out
}

/* ───────────────────────────── consecutivos RC ───────────────────────────── */

/** Consecutivos RC faltantes por serie (huecos entre min y max ya conocidos) */
export function consecutivosFaltantesRC(docs: Obj[], limite = 200): string[] {
  const existentes = new Set<string>()
  const series: Record<string, { min: number; max: number }> = {}

  for (const doc of docs ?? []) {
    const m = String(doc?.name || '').trim().match(/^(RC-[^-]+-)(\d+)$/i)
    if (!m) continue
    const serie = m[1]!.toUpperCase()
    const n = Number(m[2])
    if (!Number.isFinite(n)) continue
    existentes.add(serie + n)
    const s = series[serie]
    series[serie] = s ? { min: Math.min(s.min, n), max: Math.max(s.max, n) } : { min: n, max: n }
  }

  const out: string[] = []
  for (const [serie, r] of Object.entries(series)) {
    for (let n = r.min; n <= r.max; n++) {
      if (existentes.has(serie + n)) continue
      if (out.length >= limite) return out
      out.push(serie + n)
    }
  }
  return out
}

/**
 * Nombres RC que se deben verificar según el catálogo oficial de tipos RC
 * (`consecutive` = PRÓXIMO consecutivo). Series grandes se acotan cerca de lo conocido.
 */
export function nombresRCPorCatalogo(
  docs: Obj[],
  tipos: Obj[],
  opts: { maxDiscoveryScan?: number; backMargin?: number } = {},
): string[] {
  const maxScan = opts.maxDiscoveryScan ?? 500
  const margin = opts.backMargin ?? 100
  const existentes = new Set<string>()
  const porSerie: Record<string, { min: number; max: number }> = {}

  for (const doc of docs ?? []) {
    const name = String(doc?.name || '').trim().toUpperCase()
    if (!name) continue
    existentes.add(name)
    const m = name.match(/^RC-([^-]+)-(\d+)$/i)
    if (!m) continue
    const code = m[1]!.trim()
    const n = Number(m[2])
    if (!Number.isFinite(n)) continue
    const s = porSerie[code]
    porSerie[code] = s ? { min: Math.min(s.min, n), max: Math.max(s.max, n) } : { min: n, max: n }
  }

  const out: string[] = []
  for (const tipo of tipos ?? []) {
    if (!tipo || tipo.active === false) continue
    const code = String(primeroNoVacio([tipo.code, '']) || '').trim()
    const siguiente = Number(tipo.consecutive)
    if (!code || !Number.isFinite(siguiente) || siguiente <= 1) continue

    const ultimoPosible = Math.floor(siguiente - 1)
    let desde = 1
    if (ultimoPosible > maxScan) {
      const info = porSerie[code]
      desde = info ? Math.max(1, info.min - margin) : Math.max(1, ultimoPosible - maxScan + 1)
    }
    for (let n = desde; n <= ultimoPosible; n++) {
      const name = `RC-${code}-${n}`.toUpperCase()
      if (!existentes.has(name)) out.push(name)
    }
  }
  return out
}

/* ───────────────────────────── expansión de movimientos ───────────────────────────── */

function descripcionEsAjusteNoRecaudo(descripcion: unknown): boolean {
  const d = normalizarTextoComparacion(descripcion)
  return !!d && /ajustealpeso|reteica|retefuente|reteiva|retencion|autorretencion/.test(d)
}

function descripcionSugiereMovimientoCartera(descripcion: unknown): boolean {
  const d = normalizarTextoComparacion(descripcion)
  if (!d) return false
  if (/ajustealpeso|reteica|retefuente|reteiva|retencion/.test(d)) return false
  if (/^pago|^fv/.test(d)) return false
  return /clientesnacionales|declientes|anticipo|abono|excedente|exedente/.test(d)
}

/** Grupo 13 (cuentas por cobrar) y 2805 (anticipos / saldos a favor de clientes) */
export function esCuentaObjetivoRecaudo(cuenta: unknown): boolean {
  const c = String(cuenta ?? '').replace(/\D/g, '')
  return !!c && (/^13/.test(c) || /^2805/.test(c))
}

function referenciasFacturasFaltantesEnVoucher(items: Obj[]): string[] {
  const existentes = new Set<string>()
  const candidatas: Record<string, string> = {}
  const prefijosFV = new Set<string>()

  for (const it of items ?? []) {
    const due = extraerDueFlexible(it)
    if (due && /^FV-/i.test(String(due.documentoBase || ''))) {
      const base = String(due.documentoBase).trim()
      existentes.add(normalizarDocumento(base))
      const mp = base.match(/^(FV-[^-]+)-\d+$/i)
      if (mp) prefijosFV.add(mp[1]!.toUpperCase())
    }

    for (const txt of [it?.description, it?.reference_document, it?.document_name, it?.invoice_name, it?.name]) {
      const re = /\bFV-[A-Za-z0-9]+-\d+(?:-\d+)?\b/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(String(txt ?? ''))) !== null) {
        const info = dueDesdeTexto(m[0].toUpperCase(), {})
        if (info?.documentoBase) {
          candidatas[normalizarDocumento(info.documentoBase)] = info.documentoBase
          const mp = String(info.documentoBase).match(/^(FV-[^-]+)-\d+$/i)
          if (mp) prefijosFV.add(mp[1]!.toUpperCase())
        }
      }
    }
  }

  // Con una sola serie FV en el voucher se interpretan abreviaturas tipo "abono factura 31"
  if (prefijosFV.size === 1) {
    const pref = Array.from(prefijosFV)[0]!
    for (const it of items ?? []) {
      const re = /\b(?:factura|fv)\s*(?:n(?:ro|o)?\.?\s*)?(\d+)\b/gi
      let m: RegExpExecArray | null
      while ((m = re.exec(String(it?.description ?? ''))) !== null) {
        const base = `${pref}-${m[1]}`
        candidatas[normalizarDocumento(base)] = base
      }
    }
  }

  return Object.keys(candidatas).filter(k => !existentes.has(k)).map(k => candidatas[k]!)
}

function referenciaRCSaldoFavor(voucher: Obj): string {
  const m = String(voucher?.name || '').trim().match(/^RC-[^-]+-(\d+)$/i)
  return m ? `RC-${m[1]}-1` : ''
}

function referenciaCCDesdeVoucher(voucher: Obj): string {
  const m = String(voucher?.name || '').trim().match(/^RC-[^-]+-(\d+)$/i)
  return m ? `CC-${m[1]}-1` : ''
}

function registrarSaldoCliente2805(estado: ResolutionState, ref: string, valor: number) {
  const v = round2(Math.abs(Number(valor || 0)))
  if (!(v > TOLERANCIA) || !ref) return
  estado.saldosClientes2805.push({ ref, disponible: v })
}

function consumirSaldoCliente2805(estado: ResolutionState, valor: number): string {
  const v = round2(Math.abs(Number(valor || 0)))
  if (!(v > TOLERANCIA)) return ''

  // Primero coincidencia exacta; luego un saldo mayor que permita aplicación parcial
  for (const s of estado.saldosClientes2805) {
    if (!(s.disponible > TOLERANCIA)) continue
    if (Math.abs(s.disponible - v) <= TOLERANCIA) {
      s.disponible = 0
      return s.ref
    }
  }
  for (const s of estado.saldosClientes2805) {
    if (!(s.disponible > v + TOLERANCIA)) continue
    s.disponible = round2(s.disponible - v)
    return s.ref
  }
  return ''
}

function unicaFacturaConDueEnVoucher(items: Obj[]): string {
  const mapa: Record<string, string> = {}
  for (const it of items ?? []) {
    const ref = String(extraerDueFlexible(it)?.documentoBase || '').trim()
    if (/^FV-/i.test(ref)) mapa[normalizarDocumento(ref)] = ref
  }
  const keys = Object.keys(mapa)
  return keys.length === 1 ? mapa[keys[0]!]! : ''
}

/** Registra lo aplicado a cada factura para resolver saldos pendientes en RC posteriores */
export function registrarAplicacionesFactura(estado: ResolutionState, identification: string, movimientos: CollectionMovement[]) {
  const tercero = String(identification || '').trim()
  if (!tercero) return
  const h = (estado.historialFacturas[tercero] ??= { orden: [], porFactura: {} })

  for (const m of movimientos ?? []) {
    const ref = String(m?.documentoBase || '').trim()
    if (!/^FV-/i.test(ref)) continue
    const key = normalizarDocumento(ref)
    if (!h.porFactura[key]) {
      h.porFactura[key] = { ref, aplicado: 0 }
      h.orden.push(key)
    }
    h.porFactura[key]!.aplicado = round2(h.porFactura[key]!.aplicado + Number(m.valor || 0))
  }
}

async function buscarFacturaAnteriorPorSaldo(
  estado: ResolutionState,
  identification: string,
  valor: number,
  lookup: CollectionInvoiceLookup,
): Promise<string> {
  const h = estado.historialFacturas[String(identification || '').trim()]
  if (!h) return ''
  const objetivo = round2(Math.abs(Number(valor || 0)))
  if (!(objetivo > TOLERANCIA)) return ''

  // De la factura vista más recientemente hacia atrás
  for (let i = h.orden.length - 1; i >= 0; i--) {
    const reg = h.porFactura[h.orden[i]!]
    if (!reg?.ref) continue
    const total = round2(await lookup.getInvoiceTotal(reg.ref))
    if (!(total > TOLERANCIA)) continue
    const restante = round2(Math.max(0, total - reg.aplicado))
    if (Math.abs(restante - objetivo) <= 0.02) return reg.ref
  }
  return ''
}

async function resolverDueSinDue(
  voucher: Obj,
  item: Obj,
  items: Obj[],
  cuenta: string,
  estado: ResolutionState,
  identification: string,
  valor: number,
  lookup: CollectionInvoiceLookup,
): Promise<DueInfo> {
  const c = String(cuenta || '').replace(/\D/g, '')
  const desc = normalizarTextoComparacion(item?.description)

  // A. Cuenta 2805: saldo/anticipo de clientes
  if (/^2805/.test(c)) {
    if (/declientes/.test(desc)) {
      const previo = consumirSaldoCliente2805(estado, valor)
      if (previo) {
        const info = dueDesdeTexto(previo, item)
        if (info) return info
      }
    }
    const refRC = referenciaRCSaldoFavor(voucher)
    if (refRC) {
      registrarSaldoCliente2805(estado, refRC, valor)
      const info = dueDesdeTexto(refRC, item)
      if (info) return info
    }
  }

  // B. Referencia explícita en el propio item
  const propio = referenciaDocumentoDesdeItem(item)
  if (propio) {
    const info = dueDesdeTexto(propio, item)
    if (info) return info
  }

  // C. Referencia documental dentro de la descripción
  const descRef = extraerReferenciaDocumentoTexto(item?.description)
  if (descRef) {
    const info = dueDesdeTexto(descRef, item)
    if (info) return info
  }

  if (/^13/.test(c)) {
    // D. Facturas mencionadas en otras descripciones del RC
    const faltantes = referenciasFacturasFaltantesEnVoucher(items ?? [])
    if (faltantes.length === 1) {
      const info = dueDesdeTexto(faltantes[0], item)
      if (info) return info
    }

    // E. Anticipo sin FV identificable → comprobante contable derivado del consecutivo del RC
    if (/anticipo/.test(desc)) {
      const refCC = referenciaCCDesdeVoucher(voucher)
      if (refCC) {
        const info = dueDesdeTexto(refCC, item)
        if (info) return info
      }
    }

    // F. Saldo pendiente de una factura previa del mismo cliente
    const anterior = await buscarFacturaAnteriorPorSaldo(estado, identification, valor, lookup)
    if (anterior) {
      const info = dueDesdeTexto(anterior, item)
      if (info) return info
    }

    // G. Única FV documentada en este RC
    const unica = unicaFacturaConDueEnVoucher(items ?? [])
    if (unica) {
      const info = dueDesdeTexto(unica, item)
      if (info) return info
    }
  }

  // H. Sin referencia suficiente: el RC es el documento base (nunca se inventa una factura)
  const recibo = String(voucher?.name || '').trim()
  return { vencimientoCompleto: recibo, documentoBase: recibo, quote: '', dueDate: '' }
}

/** Una línea sin due que equivale a la suma de las demás es la contrapartida/total del pago */
function eliminarTotalesDuplicadosSinDue(movs: CollectionMovement[]): CollectionMovement[] {
  const lista = (movs ?? []).slice()
  if (lista.length < 3) return lista
  return lista.filter((m, idx) => {
    if (!m?.origenSinDue) return true
    const sumaOtros = round2(lista.reduce((acc, otro, j) => (j === idx || !otro ? acc : acc + Number(otro.valor || 0)), 0))
    return Math.abs(Number(m.valor || 0) - sumaOtros) > TOLERANCIA
  })
}

function eliminarDuplicadosAplicaciones(movs: CollectionMovement[]): CollectionMovement[] {
  const lista = (movs ?? []).slice()
  const salida: CollectionMovement[] = []
  const vistosSinDue = new Set<string>()
  const clavesConDue = new Set<string>()
  const firmasSinDueEspecificas = new Set<string>()
  const firma = (m: CollectionMovement) => `${round2(m.valor || 0).toFixed(2)}|${normalizarTextoComparacion(m.descripcion || '')}`

  for (const m of lista) {
    if (!m) continue
    if (!m.origenSinDue) {
      clavesConDue.add(`${normalizarDocumento(m.documentoBase)}|${round2(m.valor || 0).toFixed(2)}`)
      continue
    }
    if (!/^RC-[^-]+-\d+$/i.test(String(m.documentoBase || '').trim())) firmasSinDueEspecificas.add(firma(m))
  }

  for (const m of lista) {
    if (!m) continue
    const docVal = `${normalizarDocumento(m.documentoBase)}|${round2(m.valor || 0).toFixed(2)}`
    // Copia sin due de una aplicación con due oficial → contrapartida descriptiva
    if (m.origenSinDue && clavesConDue.has(docVal)) continue

    if (m.origenSinDue) {
      const esFallbackRCActual = /^RC-[^-]+-\d+$/i.test(String(m.documentoBase || '').trim())
      if (esFallbackRCActual && firmasSinDueEspecificas.has(firma(m))) continue

      const k = [
        normalizarDocumento(m.documentoBase),
        round2(m.valor || 0).toFixed(2),
        String(m.cuenta || '').replace(/\D/g, ''),
        normalizarTextoComparacion(m.descripcion || ''),
      ].join('|')
      if (vistosSinDue.has(k)) continue
      vistosSinDue.add(k)
    }
    salida.push(m)
  }
  return salida
}

function deduplicarMovimientosFinales(movs: CollectionMovement[]): CollectionMovement[] {
  const vistos = new Set<string>()
  return (movs ?? []).filter(m => {
    if (m.clase === 'ITEM') return true
    const key = [m.clase, normalizarDocumento(m.vencimiento), round2(m.valor || 0).toFixed(2), String(m.cuenta || '')].join('|')
    if (vistos.has(key)) return false
    vistos.add(key)
    return true
  })
}

/**
 * Expande un voucher ya fusionado en movimientos de recaudo.
 * Items con due = aplicaciones documentadas; items sin due solo si son líneas reales de
 * cartera/anticipos. Retenciones, ReteICA, ajustes al peso y contrapartidas se excluyen.
 */
export async function expandirMovimientosVoucher(
  voucher: Obj,
  estado: ResolutionState,
  identification: string,
  lookup: CollectionInvoiceLookup,
): Promise<CollectionMovement[]> {
  const v = voucher ?? {}
  const items: Obj[] = Array.isArray(v.items) ? v.items : []
  const recibo = String(v.name || '').trim()
  const salida: CollectionMovement[] = []

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex] ?? {}
    const valorPrincipal = Math.abs(obtenerValorItem(item))
    if (!(valorPrincipal > TOLERANCIA)) continue

    const cuenta = codigoCuentaItem(item)
    const dueOriginal = extraerDueFlexible(item)
    let dueInfo: DueInfo | null = dueOriginal

    if (!dueInfo?.vencimientoCompleto) {
      if (descripcionEsAjusteNoRecaudo(item.description)) continue
      if (!esCuentaObjetivoRecaudo(cuenta) && !descripcionSugiereMovimientoCartera(item.description)) continue
      dueInfo = await resolverDueSinDue(v, item, items, cuenta, estado, identification, valorPrincipal, lookup)
    }

    const documentoBase = dueInfo?.documentoBase || recibo
    salida.push({
      clase: 'ITEM',
      vencimiento: dueInfo?.vencimientoCompleto || documentoBase,
      documentoBase,
      quote: dueInfo?.quote ?? '',
      dueDate: dueInfo?.dueDate ?? '',
      valor: round2(valorPrincipal),
      cuenta,
      descripcion: String(item.description || '').trim(),
      indiceItem: itemIndex,
      origenSinDue: !dueOriginal?.vencimientoCompleto,
    })
  }

  // Anticipos / otros ingresos cuando Siigo no entrega items útiles: payment.value una sola vez
  if (!salida.length) {
    const tipo = String(v.type || '').trim().toLowerCase()
    const valorPago = valorVoucherSinItems(v)
    if (valorPago > TOLERANCIA) {
      let clase: MovementClass = 'PAGO_SIN_ITEMS'
      if (tipo === 'advancepayment') clase = 'ANTICIPO'
      if (tipo === 'miscincome') clase = 'OTRO_INGRESO'

      salida.push({
        clase,
        vencimiento: recibo ? `${recibo}-1` : '',
        documentoBase: recibo,
        quote: 1,
        dueDate: normalizarFecha(v.payment?.due_date),
        valor: round2(valorPago),
        cuenta: codigoCuentaMovimientoVoucher(v),
        descripcion: String(primeroNoVacio([v.income?.name, v.payment?.name, v.observations, '']) || '').trim(),
        indiceItem: -1,
        origenSinDue: true,
      })
    }
  }

  return deduplicarMovimientosFinales(eliminarDuplicadosAplicaciones(eliminarTotalesDuplicadosSinDue(salida)))
}

/* ───────────────────────────── terceros y recibo ───────────────────────────── */

function getNested(obj: Obj | null | undefined, path: string[]): any {
  let cur: any = obj
  for (const p of path) {
    if (!cur || cur[p] === undefined || cur[p] === null) return ''
    cur = cur[p]
  }
  return cur
}

const THIRD_KEYS = ['customer', 'supplier', 'third_party', 'thirdParty', 'client', 'party']

export function extractThirdIdentification(v: Obj): string {
  return String(primeroNoVacio([...THIRD_KEYS.map(k => getNested(v, [k, 'identification'])), '']) || '').trim()
}

export function extractThirdName(obj: Obj | null | undefined): string {
  if (!obj || typeof obj !== 'object') return ''
  if (Array.isArray(obj.name)) return obj.name.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()

  const direct = primeroNoVacio([
    obj.name, obj.commercial_name, obj.business_name, obj.company_name, obj.full_name,
    obj.display_name, obj.social_reason, obj.razon_social, '',
  ])
  if (direct) return String(direct).trim()

  const persona = [obj.first_name, obj.middle_name, obj.last_name, obj.second_last_name]
    .filter(x => x !== null && x !== undefined && String(x).trim() !== '')
  if (persona.length) return persona.join(' ').replace(/\s+/g, ' ').trim()

  if (obj.person) return extractThirdName(obj.person)
  if (obj.company) return extractThirdName(obj.company)
  return ''
}

export function extractThirdNameFromVoucher(v: Obj): string {
  for (const k of THIRD_KEYS) {
    const n = extractThirdName(v?.[k])
    if (n) return n
  }
  return ''
}

export function obtenerNombreRecibo(v: Obj): string {
  const name = primeroNoVacio([v?.name, v?.code, v?.number_full, ''])
  if (name) return String(name).trim()
  const prefix = primeroNoVacio([v?.prefix, ''])
  const number = primeroNoVacio([v?.number, v?.consecutive, ''])
  if (prefix || number) return [prefix, number].filter(x => x !== '' && x !== null && x !== undefined).join('-')
  return String(v?.id || v?.uuid || '')
}

/** Rangos mensuales [inicio, fin] entre dos fechas ISO (el listado de Siigo se consulta mes a mes) */
export function crearRangosMensuales(inicio: string, fin: string): { inicio: string; fin: string }[] {
  const out: { inicio: string; fin: string }[] = []
  let [y, m] = inicio.slice(0, 7).split('-').map(Number) as [number, number]
  for (let i = 0; i < 240; i++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`
    const mesInicio = `${ym}-01`
    const mesFin = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
    if (mesInicio > fin) break
    out.push({ inicio: mesInicio < inicio ? inicio : mesInicio, fin: mesFin > fin ? fin : mesFin })
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}
