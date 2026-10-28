/**
 * Balance de prueba por tercero (Siigo) — lectura del XLSX y conversión de filas.
 *
 * Port del script "BALANCE DE PRUEBA POR TERCERO - SIIGO 2026":
 * - Se consulta cada mes por separado (month_start = month_end).
 * - Se localiza la fila de encabezados (primeras 40 filas de cada hoja) por puntuación.
 * - Se conservan las filas de detalle: con tercero/identificación, o subcuentas/auxiliares
 *   transaccionales; se etiquetan clase, grupo, cuenta, subcuenta y auxiliar.
 * - Saldos como números; duplicados exactos eliminados.
 *
 * Sin dependencias de red ni de base de datos (se prueba de forma aislada).
 */
import * as XLSX from 'xlsx'

export const TB_LEVELS = ['CLASE', 'GRUPO', 'CUENTA', 'SUBCUENTA', 'AUXILIAR', 'SUBAUXILIAR'] as const
type Level = (typeof TB_LEVELS)[number]

export const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

export type Cell = string | number | boolean | Date | null
export type SheetRows = Cell[][]

export interface ColumnMap {
  nivel: number
  transaccional: number
  codigo: number
  nombre: number
  identificacion: number
  sucursal: number
  tercero: number
  inicio: number
  debito: number
  credito: number
  final: number
}

export interface TrialBalanceLine {
  period: string
  year: number
  month: number
  cut_date: string
  cut_type: 'Cierre mensual' | 'Actual diario'
  level: string
  class_label: string
  group_label: string
  account_label: string
  subaccount_label: string
  auxiliary_label: string
  subauxiliary_label: string
  transactional: string
  account_code: string
  account_name: string
  identification: string
  branch: string
  third_party_name: string
  initial_balance: number
  debit: number
  credit: number
  final_balance: number
}

export function normalizar(valor: unknown): string {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/** Convierte saldos de Siigo a número: "1.234,56", "(1.234,56)", "-", números de Excel */
export function numero(valor: unknown): number {
  if (typeof valor === 'number') return Math.round(valor * 100) / 100

  let s = String(valor ?? '').trim()
  if (!s || s === '-') return 0

  const negativo = s.startsWith('(') && s.endsWith(')')
  s = s.replace(/[^\d.,+-]/g, '')

  const coma = s.lastIndexOf(',')
  const punto = s.lastIndexOf('.')
  if (coma >= 0 && punto >= 0) {
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (coma >= 0) {
    s = s.replace(',', '.')
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '')
  }

  let n = Number(s)
  if (!Number.isFinite(n)) return 0
  if (negativo) n = -Math.abs(n)
  return Math.round(n * 100) / 100
}

export function periodo(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

export function detectarColumnas(encabezadosNormalizados: string[]): ColumnMap {
  const buscar = (nombres: string[]) => {
    for (const nombre of nombres) {
      const i = encabezadosNormalizados.indexOf(normalizar(nombre))
      if (i >= 0) return i
    }
    return -1
  }

  return {
    nivel:          buscar(['Nivel']),
    transaccional:  buscar(['Transaccional']),
    codigo:         buscar(['Código cuenta contable', 'Código contable']),
    nombre:         buscar(['Nombre cuenta contable', 'Cuenta contable']),
    identificacion: buscar(['Identificación', 'NIT', 'Documento']),
    sucursal:       buscar(['Sucursal']),
    tercero:        buscar(['Nombre tercero', 'Tercero']),
    inicio:         buscar(['Saldo inicial']),
    debito:         buscar(['Movimiento débito', 'Débito']),
    credito:        buscar(['Movimiento crédito', 'Crédito']),
    final:          buscar(['Saldo final']),
  }
}

export interface DetectedReport {
  datos: SheetRows
  filaEncabezado: number
  p: ColumnMap
  puntuacion: number
  hoja: string
}

/** Busca, entre todas las hojas, la fila de encabezados con más columnas contables reconocidas */
export function localizarEncabezados(hojas: { nombre: string; filas: SheetRows }[]): DetectedReport | null {
  let mejor: DetectedReport | null = null

  for (const hoja of hojas) {
    for (let i = 0; i < Math.min(hoja.filas.length, 40); i++) {
      const p = detectarColumnas((hoja.filas[i] ?? []).map(normalizar))
      const puntuacion =
        (p.nivel >= 0 ? 3 : 0) +
        (p.codigo >= 0 ? 4 : 0) +
        (p.inicio >= 0 ? 2 : 0) +
        (p.debito >= 0 ? 2 : 0) +
        (p.credito >= 0 ? 2 : 0) +
        (p.final >= 0 ? 2 : 0)

      if (!mejor || puntuacion > mejor.puntuacion) {
        mejor = { datos: hoja.filas, filaEncabezado: i, p, puntuacion, hoja: hoja.nombre }
      }
    }
  }

  return mejor && mejor.puntuacion >= 13 ? mejor : null
}

function cellText(v: Cell | undefined): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).trim()
}

/** Fecha de corte: hoy si es el mes en curso, si no el último día del mes */
export function fechaCorte(year: number, month: number, today: string): { corte: string; actual: boolean } {
  const actual = today.slice(0, 7) === periodo(year, month)
  if (actual) return { corte: today.slice(0, 10), actual }
  const ultimoDia = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { corte: `${periodo(year, month)}-${String(ultimoDia).padStart(2, '0')}`, actual }
}

/**
 * Convierte el reporte detectado en líneas de balance por tercero.
 * @param today fecha de hoy (YYYY-MM-DD, hora Colombia) para decidir el tipo de corte
 */
export function convertirFilas(
  reporte: DetectedReport,
  year: number,
  month: number,
  today: string,
): { lines: TrialBalanceLine[]; detectados: number; antesDeDuplicados: number } {
  const p = reporte.p
  const valor = (fila: Cell[], col: number): Cell => (col < 0 ? '' : (fila[col] ?? ''))

  const nombres: Record<Level, Record<string, string>> = {
    CLASE: {}, GRUPO: {}, CUENTA: {}, SUBCUENTA: {}, AUXILIAR: {}, SUBAUXILIAR: {},
  }
  const registros: { fila: Cell[]; nivel: Level; codigo: string; nombre: string }[] = []

  for (let i = reporte.filaEncabezado + 1; i < reporte.datos.length; i++) {
    const fila = reporte.datos[i] ?? []
    const nivel = normalizar(valor(fila, p.nivel)) as Level
    const codigo = String(valor(fila, p.codigo) ?? '').replace(/\D/g, '')
    const nombre = cellText(valor(fila, p.nombre))

    if (!codigo || !(TB_LEVELS as readonly string[]).includes(nivel)) continue
    if (nombre && !nombres[nivel][codigo]) nombres[nivel][codigo] = nombre
    registros.push({ fila, nivel, codigo, nombre })
  }

  const etiqueta = (nivel: Level, codigo: string): string => {
    const mapa = nombres[nivel]
    const clave = Object.keys(mapa)
      .filter(c => codigo.startsWith(c))
      .sort((a, b) => b.length - a.length)[0]
    return clave ? `${clave} - ${mapa[clave]}` : ''
  }

  const detalles = registros.filter(r => {
    const tercero = cellText(valor(r.fila, p.tercero))
    const documento = cellText(valor(r.fila, p.identificacion))
    const transaccional = normalizar(valor(r.fila, p.transaccional))
    return (
      tercero !== '' ||
      documento !== '' ||
      (['SUBCUENTA', 'AUXILIAR', 'SUBAUXILIAR'].includes(r.nivel) && ['SI', 'S', 'TRUE', '1', 'X'].includes(transaccional))
    )
  })

  const { corte, actual } = fechaCorte(year, month, today)
  const per = periodo(year, month)

  const lines: TrialBalanceLine[] = detalles.map(r => ({
    period:             per,
    year,
    month,
    cut_date:           corte,
    cut_type:           actual ? 'Actual diario' : 'Cierre mensual',
    level:              r.nivel,
    class_label:        etiqueta('CLASE', r.codigo.slice(0, 1)),
    group_label:        etiqueta('GRUPO', r.codigo.slice(0, 2)),
    account_label:      etiqueta('CUENTA', r.codigo.slice(0, 4)),
    subaccount_label:   etiqueta('SUBCUENTA', r.codigo),
    auxiliary_label:    etiqueta('AUXILIAR', r.codigo),
    subauxiliary_label: etiqueta('SUBAUXILIAR', r.codigo),
    transactional:      cellText(valor(r.fila, p.transaccional)),
    account_code:       r.codigo,
    account_name:       r.nombre,
    identification:     cellText(valor(r.fila, p.identificacion)),
    branch:             cellText(valor(r.fila, p.sucursal)),
    third_party_name:   cellText(valor(r.fila, p.tercero)),
    initial_balance:    numero(valor(r.fila, p.inicio)),
    debit:              numero(valor(r.fila, p.debito)),
    credit:             numero(valor(r.fila, p.credito)),
    final_balance:      numero(valor(r.fila, p.final)),
  }))

  // Quitar duplicados exactos de la respuesta
  const vistos = new Set<string>()
  const unicos = lines.filter(l => {
    const k = JSON.stringify(l)
    if (vistos.has(k)) return false
    vistos.add(k)
    return true
  })

  return { lines: unicos, detectados: registros.length, antesDeDuplicados: lines.length }
}

/**
 * Lee todas las hojas del XLSX como matrices de valores (fila/columna 0-indexadas).
 * Usa SheetJS: el XLSX que genera Siigo no lo puede abrir ExcelJS
 * ("Cannot read properties of undefined (reading 'sheets')").
 */
export function readWorkbook(buffer: ArrayBuffer | Uint8Array): { nombre: string; filas: SheetRows }[] {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const wb = XLSX.read(data, { type: 'array', cellDates: true })
  return wb.SheetNames.map(nombre => ({
    nombre,
    filas: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[nombre]!, { header: 1, raw: true, defval: null, blankrows: true }),
  }))
}

/** El archivo descargado es un XLSX válido (ZIP: empieza por "PK") */
export function esXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 80 && bytes[1] === 75
}
