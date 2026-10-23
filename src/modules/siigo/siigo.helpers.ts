export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function buildQueryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
  }
  return parts.length ? '?' + parts.join('&') : ''
}

export function normalizeStatus(statusField: unknown): string {
  if (!statusField) return ''
  if (typeof statusField === 'string') {
    return statusField.trim().toLowerCase()
  }
  if (typeof statusField === 'object' && statusField !== null) {
    const obj = statusField as Record<string, unknown>
    const cands = [obj.name, obj.status, obj.value, obj.code]
    for (const v of cands) {
      if (v) return String(v).trim().toLowerCase()
    }
  }
  return String(statusField).trim().toLowerCase()
}

export function firstNonEmpty(arr: unknown[]): string {
  for (const v of arr) {
    if (v === null || v === undefined) continue
    const s = String(v).trim()
    if (s !== '') return s
  }
  return ''
}

export function toNumber(x: unknown): number {
  if (x === null || x === undefined || x === '') return 0
  if (typeof x === 'number') return Number.isNaN(x) ? 0 : x
  if (typeof x === 'object') {
    const obj = x as Record<string, unknown>
    if (obj.amount !== undefined) return toNumber(obj.amount)
    if (obj.value !== undefined)  return toNumber(obj.value)
    if (obj.total !== undefined)  return toNumber(obj.total)
    return 0
  }

  let s = String(x).replace(/\$/g, '').replace(/\s/g, '').trim()
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.')
  } else if (/^-?\d+,\d+$/.test(s)) {
    s = s.replace(',', '.')
  } else {
    s = s.replace(/,/g, '')
  }
  const n = Number(s)
  return Number.isNaN(n) ? 0 : n
}

export function toNumberAbs(x: unknown): number {
  return Math.abs(toNumber(x))
}

export function round2(n: unknown): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

export function formatDate(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeDateText(value: unknown): string {
  if (!value) return ''
  if (value instanceof Date) {
    return formatDate(value)
  }
  const s = String(value).trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.substring(0, 10)
  }
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const day = ('0' + m[1]).slice(-2)
    const month = ('0' + m[2]).slice(-2)
    const year = m[3]
    return `${year}-${month}-${day}`
  }
  return s.substring(0, 10)
}

export function parseDateSafe(dateStr: unknown): Date | null {
  if (!dateStr) return null
  const normalized = normalizeDateText(dateStr)
  if (!normalized) return null
  const parts = normalized.split('-')
  if (parts.length === 3) {
    return new Date(parseInt(parts[0]!, 10), parseInt(parts[1]!, 10) - 1, parseInt(parts[2]!, 10), 12, 0, 0)
  }
  const d = new Date(String(dateStr))
  return Number.isNaN(d.getTime()) ? null : d
}

export function looksLikeUuid(s: unknown): boolean {
  const x = String(s || '').trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
}

export function taxText(tx: unknown): string {
  if (!tx || typeof tx !== 'object') return ''
  const obj = tx as Record<string, unknown>
  return [obj.type, obj.name, obj.code, obj.description, obj.label]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function isRetentionTax(tx: unknown): boolean {
  const txt = taxText(tx)
  return txt.includes('rete') || txt.includes('reten') || txt.includes('withhold') || txt.includes('retention')
}

export function isIcaTax(tx: unknown): boolean {
  const txt = taxText(tx)
  return txt.includes('ica') || txt.includes('industria') || txt.includes('comercio')
}

export function taxAmountBestEffort(tx: unknown): number {
  if (!tx || typeof tx !== 'object') return 0
  const obj = tx as Record<string, unknown>
  const amount = toNumberAbs(firstNonEmpty([obj.amount, obj.total, obj.tax_amount, '']))
  if (amount > 0) return amount

  const base = toNumberAbs(firstNonEmpty([obj.base_value, obj.base, obj.tax_base, '']))
  const pct = toNumberAbs(firstNonEmpty([obj.percentage, obj.rate, obj.value, '']))
  if (base > 0 && pct > 0 && pct <= 100) {
    return round2(base * (pct / 100))
  }

  const value = toNumberAbs(obj.value)
  return value > 0 ? value : 0
}

/**
 * Vincula un NIT de Siigo con una empresa de forma estricta:
 * primero coincidencia exacta; si no hay, tolera el dígito de verificación
 * solo cuando existe un único candidato (evita asignar líneas a otra empresa).
 */
export function matchCompanyByNit<T extends { normNit: string }>(companies: T[], rawNit: string): T | null {
  const nit = String(rawNit ?? '').replace(/\D/g, '')
  if (!nit) return null

  const exact = companies.filter(c => c.normNit && c.normNit === nit)
  if (exact.length) return exact.length === 1 ? exact[0]! : null

  const withDv = companies.filter(c =>
    c.normNit && (c.normNit === nit.slice(0, -1) || nit === c.normNit.slice(0, -1)),
  )
  return withDv.length === 1 ? withDv[0]! : null
}

/**
 * Fecha inicial de una sync incremental: la última fecha cubierta menos un margen de
 * solape (para recoger anulaciones/ediciones tardías). Sin sync previa: carga completa del año base.
 */
export function incrementalStartDate(lastEndDate: string | null, overlapDays: number, startYear: number): string {
  if (!lastEndDate) return `${startYear}-01-01`
  const d = new Date(`${lastEndDate.slice(0, 10)}T00:00:00Z`)
  if (isNaN(d.getTime())) return `${startYear}-01-01`
  d.setUTCDate(d.getUTCDate() - Math.max(0, overlapDays))
  const iso = d.toISOString().slice(0, 10)
  const floor = `${startYear}-01-01`
  return iso < floor ? floor : iso
}
