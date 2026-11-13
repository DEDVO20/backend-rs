import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  cashSeries,
  convertirFilas,
  esXlsx,
  fechaCorte,
  localizarEncabezados,
  numero,
  readWorkbook,
} from '../src/modules/siigo/siigo.trialBalance.js'

const HEADERS = [
  'Nivel', 'Transaccional', 'Código cuenta contable', 'Nombre cuenta contable', 'Identificación',
  'Sucursal', 'Nombre tercero', 'Saldo inicial', 'Movimiento débito', 'Movimiento crédito', 'Saldo final',
]

const ROWS: (string | number)[][] = [
  ['Clase', 'No', '1', 'Activo', '', '', '', 1000, 500, 200, 1300],
  ['Grupo', 'No', '13', 'Deudores', '', '', '', 1000, 500, 200, 1300],
  ['Cuenta', 'No', '1305', 'Clientes', '', '', '', 1000, 500, 200, 1300],
  ['Subcuenta', 'No', '130505', 'Nacionales', '', '', '', 1000, 500, 200, 1300],
  ['Auxiliar', 'Sí', '13050501', 'Clientes nacionales', '901655024', '0', 'ANL CORP SAS', '600,00', '500,00', '0', '1.100,00'],
  ['Auxiliar', 'Sí', '13050501', 'Clientes nacionales', '800100200', '0', 'OTRO SAS', 400, 0, 200, 200],
  // Duplicado exacto que Siigo a veces repite
  ['Auxiliar', 'Sí', '13050501', 'Clientes nacionales', '800100200', '0', 'OTRO SAS', 400, 0, 200, 200],
  ['Clase', 'No', '4', 'Ingresos', '', '', '', 0, 0, 500, -500],
  ['Auxiliar', 'Sí', '41556001', 'Contabilidad', '', '', '', 0, 0, '(500,00)', '(500,00)'],
  ['', '', '', 'Totales', '', '', '', '', '', '', ''],
]

describe('numero', () => {
  it('convierte formatos de Siigo a número', () => {
    expect(numero('1.234.567,89')).toBe(1234567.89)
    expect(numero('(1.500,50)')).toBe(-1500.5)
    expect(numero('1,234.5')).toBe(1234.5)
    expect(numero('-')).toBe(0)
    expect(numero(12.345)).toBe(12.35)
  })
})

describe('fechaCorte', () => {
  it('usa hoy en el mes en curso y fin de mes en meses cerrados', () => {
    expect(fechaCorte(2026, 10, '2026-10-28')).toEqual({ corte: '2026-10-28', actual: true })
    expect(fechaCorte(2026, 2, '2026-10-28')).toEqual({ corte: '2026-02-28', actual: false })
  })
})

describe('balance de prueba por tercero', () => {
  it('localiza encabezados y convierte solo filas de detalle, sin duplicados', () => {
    const hojas = [{ nombre: 'Reporte', filas: [['RAD SERVICES S.A.S.'], ['Balance de prueba'], [], HEADERS, ...ROWS] }]
    const reporte = localizarEncabezados(hojas)
    expect(reporte?.filaEncabezado).toBe(3)

    const { lines, detectados, antesDeDuplicados } = convertirFilas(reporte!, 2026, 3, '2026-10-28')
    expect(detectados).toBe(9)
    expect(antesDeDuplicados).toBe(4)
    expect(lines).toHaveLength(3)

    const anl = lines.find(l => l.identification === '901655024')!
    expect(anl).toMatchObject({
      period: '2026-03',
      cut_date: '2026-03-31',
      cut_type: 'Cierre mensual',
      account_code: '13050501',
      class_label: '1 - Activo',
      group_label: '13 - Deudores',
      account_label: '1305 - Clientes',
      subaccount_label: '130505 - Nacionales',
      third_party_name: 'ANL CORP SAS',
      initial_balance: 600,
      debit: 500,
      final_balance: 1100,
    })

    // Auxiliar transaccional sin tercero (ingresos) también se conserva
    const ingreso = lines.find(l => l.account_code === '41556001')!
    expect(ingreso.credit).toBe(-500)
    expect(ingreso.class_label).toBe('4 - Ingresos')
  })

  it('rechaza un archivo sin columnas contables', () => {
    expect(localizarEncabezados([{ nombre: 'x', filas: [['Hola', 'Mundo'], [1, 2]] }])).toBeNull()
  })

  it('lee un XLSX real como lo entrega Siigo', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Balance')
    ws.addRow(['RAD SERVICES S.A.S. - NIT 901954048'])
    ws.addRow([])
    ws.addRow(HEADERS)
    for (const r of ROWS) ws.addRow(r)
    const buffer = Buffer.from(await wb.xlsx.writeBuffer())

    expect(esXlsx(new Uint8Array(buffer))).toBe(true)
    const hojas = readWorkbook(buffer)
    const reporte = localizarEncabezados(hojas)
    expect(reporte?.filaEncabezado).toBe(2)
    expect(convertirFilas(reporte!, 2026, 10, '2026-10-28').lines.map(l => [l.account_code, l.cut_type, l.final_balance])).toEqual([
      ['13050501', 'Actual diario', 1100],
      ['13050501', 'Actual diario', 200],
      ['41556001', 'Actual diario', -500],
    ])
  })
})

describe('cashSeries', () => {
  const l = (period: string, account_code: string, identification: string, debit: number, credit: number, final_balance: number) =>
    ({ period, account_code, identification, debit, credit, final_balance })

  it('suma el disponible (11) por mes sin contar dos veces la cuenta con terceros', () => {
    expect(cashSeries([
      l('2026-01', '11100501', '860002964', 1000, 400, 600), // banco por tercero
      l('2026-01', '11100501', '', 1000, 400, 600),          // la misma cuenta sin tercero: se ignora
      l('2026-01', '11050501', '', 50, 20, 30),              // caja sin terceros
      l('2026-01', '13050501', '900100200', 999, 0, 999),    // no es disponible
      l('2026-02', '11100501', '860002964', 200, 700, 100),
    ])).toEqual([
      { period: '2026-01', entradas: 1050, salidas: 420, posicion: 630 },
      { period: '2026-02', entradas: 200, salidas: 700, posicion: 100 },
    ])
  })
})
