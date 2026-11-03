/**
 * Cartera Siigo — facturas con saldo a la fecha de corte (solo para gráficas).
 *
 * Port del script "RAD - CARTERA SIIGO A GOOGLE SHEETS" (camino 2):
 * - Facturas de /v1/invoices sin anular, con saldo >= 1 y fecha <= corte.
 * - Saldo en pesos (moneda extranjera convertida con la tasa de la factura).
 * - Control contable por cliente (identificación + sucursal): suma de los saldos
 *   positivos de las cuentas 130505 y 13051001. Si las facturas suman más que ese
 *   saldo, la diferencia se descuenta de las facturas más antiguas.
 * - Edades por días vencidos respecto al vencimiento más próximo de la factura.
 *
 * A diferencia del script, el control sale de UN solo balance de prueba por tercero
 * (todas las cuentas y terceros) en vez de 2 reportes por cliente.
 *
 * Sin dependencias de red ni de base de datos (se prueba de forma aislada).
 */
import { normalizeNit } from '../participations/participations.domain.js'
import type { TrialBalanceLine } from './siigo.trialBalance.js'

type Obj = Record<string, any>

/** Cuentas de cartera: 130505 clientes nacionales, 13051001 clientes del exterior */
export const ACCOUNTS_CARTERA = ['130505', '13051001'] as const
export type CarteraAccount = (typeof ACCOUNTS_CARTERA)[number]

/** Por encima de este ratio saldo/total se asume que el saldo ya viene en pesos */
const TOLERANCIA_RATIO_EXTRANJERO = 1.2

export type AgingBucket = 'No vencido' | '1-30' | '31-60' | '61-90' | '91+' | 'Sin vencimiento'

export interface ReceivableInvoice {
  invoice_id: string
  document_id: number | null
  prefix: string
  number: number | null
  invoice_name: string
  invoice_date: string | null
  due_date: string | null
  customer_id: string
  identification: string
  branch: number
  customer_name_inline: string
  currency: string
  exchange_rate: number
  seller_id: string
  total_original: number | null
  balance_original: number | null
  total: number | null
  balance_api: number | null
  observations: string
  siigo_created_at: string
  siigo_updated_at: string
  annulled: boolean
}

export interface CustomerControl {
  /** Saldo contable por cuenta (null = el tercero no aparece en esa cuenta) */
  byAccount: Record<CarteraAccount, number | null>
  /** Suma de los saldos positivos de ambas cuentas (null si no aparece en ninguna) */
  totalPositive: number | null
  /** Nombre del tercero según el balance de prueba */
  name: string
}

export interface ReceivableLine {
  invoice_id: string
  document_id: number | null
  prefix: string
  number: number | null
  invoice_name: string
  invoice_date: string | null
  due_date: string | null
  days_overdue: number | null
  aging_bucket: AgingBucket
  identification: string
  normalized_nit: string
  branch: number
  currency: string
  exchange_rate: number
  seller_id: string
  total_original: number
  balance_original: number
  total: number
  balance_api: number
  control_130505: number | null
  control_13051001: number | null
  control_total: number | null
  control_reduction: number
  balance: number
  observations: string
  siigo_created_at: string
  siigo_updated_at: string
}

// ── Utilidades ──────────────────────────────────────────────────────────────

export function round2(n: unknown): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100
}

function get(obj: unknown, path: string[]): any {
  return path.reduce<any>((acc, k) => (acc && typeof acc === 'object' && k in acc ? acc[k] : null), obj)
}

function texto(v: unknown): string {
  if (v === null || v === undefined) return ''
  const t = String(v).trim()
  return t.toLowerCase() === 'no aplica' ? '' : t
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = texto(v)
  if (!t) return null
  for (const s of [t, t.replace(/\./g, '').replace(',', '.'), t.replace(/,/g, ''), t.replace(/\s/g, '')]) {
    const n = Number(s)
    if (!Number.isNaN(n)) return n
  }
  return null
}

function entero(v: unknown): number | null {
  const n = numero(v)
  return n === null ? null : Math.trunc(n)
}

/** Fecha ISO (YYYY-MM-DD) de un valor de la API, o null */
export function isoDate(v: unknown): string | null {
  const t = texto(v)
  if (!t) return null
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** Días de b a a (a - b), sobre fechas YYYY-MM-DD */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)
}

/** Vencimiento más próximo entre las cuotas (payments[].due_date) */
export function dueDateOf(payments: unknown): string | null {
  const list = Array.isArray(payments) ? payments : payments && typeof payments === 'object' ? [payments] : []
  const dates = list.map(p => isoDate(get(p, ['due_date']))).filter((d): d is string => Boolean(d)).sort()
  return dates[0] ?? null
}

function nombreLista(v: unknown): string {
  return Array.isArray(v) ? texto(v.map(x => String(x).trim()).filter(Boolean).join(' ')) : texto(v)
}

function nombrePersona(r: unknown): string {
  if (!r || typeof r !== 'object') return ''
  return ['first_name', 'middle_name', 'last_name', 'second_last_name']
    .map(k => texto(get(r, [k])))
    .filter(Boolean)
    .join(' ')
}

/** Nombre del cliente que trae la factura (comercial, lista de nombres o persona) */
export function inlineCustomerName(customer: unknown): string {
  return texto(get(customer, ['commercial_name'])) || nombreLista(get(customer, ['name'])) || nombrePersona(get(customer, ['person']))
}

/** Nombre de un usuario de Siigo (vendedor) */
export function sellerNameOf(user: Obj): string {
  const full = [texto(user.first_name), texto(user.last_name)].filter(Boolean).join(' ').trim()
  return full || texto(user.username) || texto(user.email)
}

// ── Montos en pesos ─────────────────────────────────────────────────────────

export function amountInPesos(currency: string, rate: number, amount: number | null): number | null {
  if (amount === null) return null
  return currency === 'COP' ? amount : amount * (rate || 1)
}

/**
 * Saldo de la factura en pesos. En moneda extranjera el saldo de la API suele venir en
 * la moneda de la factura (ratio saldo/total <= 1.2): se convierte en proporción al total
 * en pesos. Si el ratio es mayor, ya viene en pesos. Nunca supera el total en pesos.
 */
export function balanceInPesos(
  currency: string,
  rate: number,
  totalOriginal: number | null,
  balanceOriginal: number | null,
  totalPesos: number | null,
): number | null {
  if (balanceOriginal === null) return null
  const r = rate || 1
  const ratio = totalOriginal ? Math.abs(balanceOriginal) / Math.abs(totalOriginal) : null

  let balance: number
  if (currency === 'COP' || r === 1) balance = balanceOriginal
  else if (ratio !== null && ratio <= TOLERANCIA_RATIO_EXTRANJERO) {
    balance = totalPesos !== null && totalOriginal ? (balanceOriginal / totalOriginal) * totalPesos : balanceOriginal * r
  } else balance = balanceOriginal

  return totalPesos !== null && balance > totalPesos ? totalPesos : balance
}

// ── Facturas ────────────────────────────────────────────────────────────────

/** Normaliza una factura de /v1/invoices */
export function toReceivableInvoice(r: Obj): ReceivableInvoice {
  const prefix = texto(r.prefix)
  const number = entero(r.number)
  const currencyRaw = texto(get(r, ['currency', 'code']))
  const currency = currencyRaw ? currencyRaw.toUpperCase() : 'COP'
  const rateRaw = numero(get(r, ['currency', 'exchange_rate']))
  const rate = !rateRaw ? 1 : rateRaw

  const totalOriginal = numero(r.total)
  const balanceOriginal = numero(r.balance)
  const total = amountInPesos(currency, rate, totalOriginal)

  return {
    invoice_id:           texto(r.id),
    document_id:          entero(get(r, ['document', 'id'])),
    prefix,
    number,
    invoice_name:         texto(r.name) || (prefix && number !== null ? `${prefix}-${number}` : ''),
    invoice_date:         isoDate(r.date),
    due_date:             dueDateOf(r.payments),
    customer_id:          texto(get(r, ['customer', 'id'])),
    identification:       texto(get(r, ['customer', 'identification'])),
    branch:               entero(get(r, ['customer', 'branch_office'])) ?? 0,
    customer_name_inline: inlineCustomerName(r.customer),
    currency,
    exchange_rate:        rate,
    seller_id:            String(entero(get(r, ['seller', 'id']) ?? r.seller) ?? ''),
    total_original:       totalOriginal,
    balance_original:     balanceOriginal,
    total,
    balance_api:          balanceInPesos(currency, rate, totalOriginal, balanceOriginal, total),
    observations:         texto(r.observations),
    siigo_created_at:     texto(get(r, ['metadata', 'created'])),
    siigo_updated_at:     texto(get(r, ['metadata', 'last_updated'])),
    annulled:             r.annulled === true,
  }
}

/** Facturas con saldo a la fecha de corte */
export function invoicesWithBalance(invoices: ReceivableInvoice[], cutDate: string): ReceivableInvoice[] {
  return invoices.filter(r =>
    !r.annulled &&
    r.invoice_id !== '' &&
    r.balance_api !== null && r.balance_api >= 1 &&
    r.identification !== '' &&
    (!r.invoice_date || r.invoice_date <= cutDate),
  )
}

// ── Control contable (balance de prueba por tercero) ────────────────────────

export function customerKey(identification: string, branch: number | string): string {
  return `${normalizeNit(identification) || identification.trim()}||${Number(branch) || 0}`
}

/**
 * Saldo contable por cliente en las cuentas de cartera, a partir del balance de prueba por tercero.
 * Por cuenta y tercero se usan las filas de la cuenta exacta; si no las hay, las de sus subcuentas
 * (p. ej. 13050501 bajo 130505). Así no se cuenta dos veces un mismo saldo.
 */
export function customerControls(lines: TrialBalanceLine[]): Map<string, CustomerControl> {
  const out = new Map<string, CustomerControl>()

  for (const account of ACCOUNTS_CARTERA) {
    const exact = new Map<string, number>()
    const child = new Map<string, number>()
    for (const l of lines) {
      if (!l.identification) continue
      const code = l.account_code
      if (code !== account && !code.startsWith(account)) continue
      const key = customerKey(l.identification, l.branch)
      const bag = code === account ? exact : child
      bag.set(key, round2((bag.get(key) ?? 0) + l.final_balance))

      const c = out.get(key) ?? { byAccount: { '130505': null, '13051001': null }, totalPositive: null, name: '' }
      if (!c.name && l.third_party_name) c.name = l.third_party_name
      out.set(key, c)
    }
    for (const [key, c] of out) {
      const saldo = exact.has(key) ? exact.get(key)! : child.has(key) ? child.get(key)! : null
      c.byAccount[account] = saldo
    }
  }

  for (const c of out.values()) {
    const values = ACCOUNTS_CARTERA.map(a => c.byAccount[a]).filter((v): v is number => v !== null)
    // Saldos negativos o menores a $1 no suman al control
    c.totalPositive = values.length ? round2(values.reduce((s, v) => s + (v >= 1 ? v : 0), 0)) : null
  }
  return out
}

/** Busca el control de un cliente tolerando el dígito de verificación en la identificación */
export function findControl(controls: Map<string, CustomerControl>, identification: string, branch: number): CustomerControl | null {
  const exact = controls.get(customerKey(identification, branch))
  if (exact) return exact
  const nit = normalizeNit(identification)
  if (!nit) return null
  for (const [key, c] of controls) {
    const [kNit, kBranch] = key.split('||')
    if (Number(kBranch) !== (Number(branch) || 0) || !kNit) continue
    if (kNit === nit.slice(0, -1) || nit === kNit.slice(0, -1)) return c
  }
  return null
}

// ── Edades ──────────────────────────────────────────────────────────────────

export function agingOf(dueDate: string | null, cutDate: string): { days: number | null; bucket: AgingBucket } {
  if (!dueDate) return { days: null, bucket: 'Sin vencimiento' }
  const days = daysBetween(cutDate, dueDate)
  const bucket: AgingBucket =
    days <= 0 ? 'No vencido' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '91+'
  return { days, bucket }
}

/** Orden de aplicación: vencimiento más antiguo primero (sin vencimiento al inicio), luego fecha y nombre */
export function compareInvoices(a: ReceivableInvoice, b: ReceivableInvoice): number {
  const cmp = (x: string | null, y: string | null) => (x === y ? 0 : !x ? -1 : !y ? 1 : x < y ? -1 : 1)
  return cmp(a.due_date, b.due_date) || cmp(a.invoice_date, b.invoice_date) || a.invoice_name.localeCompare(b.invoice_name, 'es')
}

/**
 * Cartera final: por cliente, el saldo de sus facturas se limita a su saldo contable
 * (130505 + 13051001). La diferencia se descuenta de las facturas más antiguas.
 * Un cliente sin saldo contable positivo queda sin cartera.
 */
export function buildReceivables(
  invoices: ReceivableInvoice[],
  controls: Map<string, CustomerControl>,
  cutDate: string,
): ReceivableLine[] {
  const groups = new Map<string, ReceivableInvoice[]>()
  for (const inv of invoicesWithBalance(invoices, cutDate)) {
    const key = customerKey(inv.identification, inv.branch)
    const list = groups.get(key) ?? []
    list.push(inv)
    groups.set(key, list)
  }

  const out: ReceivableLine[] = []
  for (const list of groups.values()) {
    const ordered = [...list].sort(compareInvoices)
    const first = ordered[0]!
    const ctrl = findControl(controls, first.identification, first.branch)

    const totalFacturas = round2(ordered.reduce((s, r) => s + (r.balance_api ?? 0), 0))
    const control = ctrl?.totalPositive ?? 0
    const keep = control > 0 ? Math.min(control, totalFacturas) : 0
    const reduction = round2(totalFacturas - keep)

    let previous = 0
    for (const r of ordered) {
      const balanceApi = r.balance_api ?? 0
      const pending = reduction - previous
      let applied = pending > 0 ? Math.min(pending, balanceApi) : 0
      if (Math.abs(applied) < 1) applied = 0
      previous += balanceApi

      const net = round2(balanceApi - applied)
      const balance = net < 1 ? 0 : net
      if (balance < 1) continue

      const { days, bucket } = agingOf(r.due_date, cutDate)
      out.push({
        invoice_id:        r.invoice_id,
        document_id:       r.document_id,
        prefix:            r.prefix,
        number:            r.number,
        invoice_name:      r.invoice_name,
        invoice_date:      r.invoice_date,
        due_date:          r.due_date,
        days_overdue:      days,
        aging_bucket:      bucket,
        identification:    r.identification,
        normalized_nit:    normalizeNit(r.identification),
        branch:            r.branch,
        currency:          r.currency,
        exchange_rate:     r.exchange_rate,
        seller_id:         r.seller_id,
        total_original:    round2(r.total_original),
        balance_original:  round2(r.balance_original),
        total:             round2(r.total),
        balance_api:       round2(balanceApi),
        control_130505:    ctrl?.byAccount['130505'] ?? null,
        control_13051001:  ctrl?.byAccount['13051001'] ?? null,
        control_total:     ctrl?.totalPositive ?? null,
        control_reduction: round2(applied),
        balance,
        observations:      r.observations,
        siigo_created_at:  r.siigo_created_at,
        siigo_updated_at:  r.siigo_updated_at,
      })
    }
  }
  return out
}
