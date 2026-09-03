import { describe, it, expect } from 'vitest'
import {
  calcParticipation,
  availableParticipation,
  deriveInvoiceStatus,
  formatPurchaseOrder,
  formatPaymentOrder,
  excelSerialToISO,
  extractInvoiceRef,
  validateThirdPartyInvoice,
  normalizeInvoiceNumber,
  normalizeSiigoInvoice,
  nitMatch,
  parseSiigoDate,
  parseColombianNumber,
  parseAccountingMovement,
} from '../src/modules/participations/participations.domain.js'

describe('calcParticipation', () => {
  it('calcula valor × (porcentaje / 100)', () => {
    expect(calcParticipation(500_000, 20)).toBe(100_000)
  })

  it('redondea a 2 decimales', () => {
    expect(calcParticipation(333_333, 33.33)).toBe(111_099.89)
  })

  it('0% da 0', () => {
    expect(calcParticipation(500_000, 0)).toBe(0)
  })

  it('tipo fijo devuelve el monto fijo, ignora el %', () => {
    expect(calcParticipation(500_000, 20, { type: 'fixed', fixedValue: 150_000 })).toBe(150_000)
  })
})

describe('formatPaymentOrder', () => {
  it('formatea OP-YYYYMM-NNNNNN', () => {
    expect(formatPaymentOrder(2026, 8, 3)).toBe('OP-202608-000003')
  })
})

describe('excelSerialToISO', () => {
  it('convierte el serial de Excel a fecha', () => {
    expect(excelSerialToISO(46204.51393518518)).toBe('2026-07-01')
  })
  it('null si no es válido', () => {
    expect(excelSerialToISO(0)).toBeNull()
  })
})

describe('extractInvoiceRef', () => {
  it('extrae el FV de un texto libre', () => {
    expect(extractInvoiceRef('Pago participación FV-4-9001 cuota 1')).toBe('FV-4-9001')
    expect(extractInvoiceRef('FV-58964')).toBe('FV-58964')
  })
  it('null si no hay factura', () => {
    expect(extractInvoiceRef('Traslado Fiducuenta')).toBe(null)
  })
})

describe('validateThirdPartyInvoice', () => {
  it('ok cuando el valor coincide con lo causado', () => {
    expect(validateThirdPartyInvoice(100_000, { number: 'T-1', value: 100_000 }).ok).toBe(true)
  })
  it('falla si no coincide', () => {
    const r = validateThirdPartyInvoice(100_000, { number: 'T-1', value: 90_000 })
    expect(r.ok).toBe(false)
    expect(r.reasons[0]).toContain('no coincide')
  })
  it('falla si no hay factura del tercero', () => {
    expect(validateThirdPartyInvoice(100_000, { number: null, value: null }).ok).toBe(false)
  })
})

describe('parseColombianNumber (reporte consolidado)', () => {
  it('punto = miles y coma = decimal', () => {
    expect(parseColombianNumber('$33.823.175,51')).toBe(33_823_175.51)
    expect(parseColombianNumber('$8.176.579,56')).toBe(8_176_579.56)
    expect(parseColombianNumber('$0,00')).toBe(0)
  })
  it('entero sin separadores se toma tal cual (IDs)', () => {
    expect(parseColombianNumber('11200501')).toBe(11_200_501)
    expect(parseColombianNumber('447')).toBe(447)
  })
  it('tolera espacios, símbolo y vacío', () => {
    expect(parseColombianNumber(' $ 1.234,50 ')).toBe(1_234.5)
    expect(parseColombianNumber('')).toBe(0)
    expect(parseColombianNumber(null)).toBe(0)
    expect(parseColombianNumber('n/a')).toBe(0)
  })
})

describe('deriveInvoiceStatus (estados del spec)', () => {
  it('OC del mes sin FV → pendiente de factura', () => {
    expect(deriveInvoiceStatus({ finto_invoice: null, finto_invoice_value: 500_000, collected: 0 })).toBe('pending_invoice')
  })
  it('FV con participación, sin factura del tercero → pendiente factura tercero', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, collected: 500_000 })).toBe('pending_third_invoice')
  })
  it('el recaudo NO cambia el estado (sigue pendiente factura tercero)', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, collected: 0 })).toBe('pending_third_invoice')
  })
  it('FC del tercero con valor distinto al causado → diferencia de valor', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 170_000 })).toBe('value_difference')
  })
  it('FC coincide, sin egreso → pendiente de pago', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 150_000 })).toBe('pending_payment')
  })
  it('FC coincide y con egreso → completa', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 150_000, egress_voucher: 'RP-1' })).toBe('complete')
  })
})

describe('availableParticipation (proporcional al recaudo)', () => {
  it('porcentaje: proporcional al % recaudado', () => {
    expect(availableParticipation({ type: 'percentage', participationValue: 100_000, invoiceValue: 500_000, collected: 250_000 })).toBe(50_000)
  })
  it('porcentaje: recaudo total libera todo', () => {
    expect(availableParticipation({ type: 'percentage', participationValue: 100_000, invoiceValue: 500_000, collected: 500_000 })).toBe(100_000)
  })
  it('porcentaje: sin recaudo, $0', () => {
    expect(availableParticipation({ type: 'percentage', participationValue: 100_000, invoiceValue: 500_000, collected: 0 })).toBe(0)
  })
  it('fijo: $0 hasta recaudo total, luego completo', () => {
    expect(availableParticipation({ type: 'fixed', participationValue: 150_000, invoiceValue: 500_000, collected: 250_000 })).toBe(0)
    expect(availableParticipation({ type: 'fixed', participationValue: 150_000, invoiceValue: 500_000, collected: 500_000 })).toBe(150_000)
  })
})

describe('formatPurchaseOrder', () => {
  it('formatea OC-YYYYMM-NNNNNN', () => {
    expect(formatPurchaseOrder(2026, 7, 1)).toBe('OC-202607-000001')
  })
  it('rellena mes y secuencia', () => {
    expect(formatPurchaseOrder(2026, 12, 123)).toBe('OC-202612-000123')
  })
})

describe('normalizeInvoiceNumber', () => {
  it('ignora espacios, guiones y puntos, y no distingue mayúsculas', () => {
    expect(normalizeInvoiceNumber('F-001')).toBe(normalizeInvoiceNumber('f 001'))
    expect(normalizeInvoiceNumber('FE.123')).toBe('FE123')
  })
})

describe('conciliación SIIGO', () => {
  it('normalizeSiigoInvoice quita el sufijo de cuota', () => {
    expect(normalizeSiigoInvoice('FV-4-4663-1')).toBe('FV-4-4663')
    expect(normalizeSiigoInvoice('FV-4-4833')).toBe('FV-4-4833')
    expect(normalizeSiigoInvoice('fv-4-4663-2')).toBe('FV-4-4663')
  })

  it('el recibo enlaza con la venta por número de factura normalizado', () => {
    expect(normalizeSiigoInvoice('FV-4-4663-1')).toBe(normalizeSiigoInvoice('FV-4-4663'))
  })

  it('nitMatch tolera puntos, guiones y dígito de verificación', () => {
    expect(nitMatch('900.062.985-1', '900062985')).toBe(true)
    expect(nitMatch('901723460', '901723460')).toBe(true)
    expect(nitMatch('900062985', '860075214')).toBe(false)
    expect(nitMatch('', '900062985')).toBe(false)
  })

  it('parseSiigoDate interpreta dd/mm/yyyy', () => {
    expect(parseSiigoDate('17/07/2026')).toEqual({ iso: '2026-07-17', year: 2026, month: 7 })
    expect(parseSiigoDate('01/07/2026')).toEqual({ iso: '2026-07-01', year: 2026, month: 7 })
    expect(parseSiigoDate('basura')).toBeNull()
  })

  it('parseSiigoDate interpreta el serial de Excel', () => {
    // 46235 = 2026-08-01 ; 46218 = 2026-07-15
    expect(parseSiigoDate('46235')).toEqual({ iso: '2026-08-01', year: 2026, month: 8 })
    expect(parseSiigoDate('46218')).toEqual({ iso: '2026-07-15', year: 2026, month: 7 })
    expect(parseSiigoDate('123')).toBeNull()   // fuera de rango de fecha
  })
})

describe('parseAccountingMovement (reporte Movimiento por cuenta contable)', () => {
  // Layout con columnas nuevas: Crédito antes de Descripción, + Valor base y Nombre tercero
  const header = ['Código cuentas contables', 'Identificación tercero', 'Comprobante', 'Fecha elaboración', 'Crédito', 'Descripción', 'Valor base', 'Nombre tercero', 'Fecha vencimiento']
  const rows: string[][] = [
    ['RC Finto'], ['RAD SERVICES SAS'], ['901954048'], ['De julio 01 2026 a julio 31 2026'],
    header,
    // Venta servicio (cuenta 41, FV) — Sukot
    ['41800101', '901178069', 'FV-2-77', '7/6/26', '2,500,000.00', 'Acompañamiento SGSST', '', 'Sukot Roofing SAS', ''],
    ['13050501', '901178069', 'FV-2-77', '7/6/26', '', 'Clientes nacionales', '', 'Sukot Roofing SAS', '7/15/26'],
    // Venta mandato (cuenta 41 ingreso + 28150601 porción del mandante) — mismo FV
    ['41555005', '900139876', 'FV-4-4864', '7/1/26', '1,561,700.00', 'Honorarios', '', 'Colcharter', ''],
    ['28150601', '900139876', 'FV-4-4864', '7/1/26', '1,154,300.00', 'Contrato mandato Eugenia', '', 'Colcharter', ''],
    // Recaudo (cuenta 13050501, RC) con FV en descripción
    ['13050501', '901178069', 'RC-1-53', '7/3/26', '2,678,350.00', 'FV-2-70 Cuota: 1  Fecha: 17/06/2026', '', 'Sukot Roofing SAS', ''],
    // Nota crédito (cuenta 13050501, NC)
    ['13050501', '901163686', 'NC-2-7', '7/15/26', '5,125,848.75', '', '', 'RAD Estrategias', ''],
    // Nota crédito con FV en la descripción → liga a esa factura
    ['13050501', '901178069', 'NC-1-15', '7/10/26', '250,000.00', 'Ajuste FV-2-77', '', 'Sukot Roofing SAS', ''],
    // Factura del tercero (cuenta 2335, FC)
    ['23359501', '901390501', 'FC-1-40', '7/28/26', '1,339,175.00', 'Otros', '', 'SIG Consultoria', ''],
    // Pago al tercero (banco 1120, RP)
    ['11200501', '901390501', 'RP-1-114', '7/14/26', '1,339,175.00', 'Pago SIGC-22 SIG Consultoria', '', 'SIG Consultoria', ''],
    // Nómina (banco 1120, RP) — otro tercero; el servicio filtra por config
    ['11200501', '5328174', 'RP-1-99', '7/3/26', '970,000.00', 'Pago Nomina', '', 'X', ''],
  ]

  it('venta servicio: ingreso de la cuenta 41, base de la participación', () => {
    const m = parseAccountingMovement(rows)
    const sukot = m.sales.find(s => s.fv === 'FV-2-77')!
    expect(sukot.income).toBe(2_500_000)
    expect(sukot.mandate).toBe(0)
    expect(sukot.clientNit).toBe('901178069')
    expect(sukot.clientName).toBe('Sukot Roofing SAS')
  })

  it('venta mandato: separa ingreso (41) y porción del mandante (28150601)', () => {
    const m = parseAccountingMovement(rows)
    const man = m.sales.find(s => s.fv === 'FV-4-4864')!
    expect(man.income).toBe(1_561_700)
    expect(man.mandate).toBe(1_154_300)
    expect(man.base).toBe(2_716_000)
  })

  it('recaudo: RC de la cuenta 13050501, por FV', () => {
    const m = parseAccountingMovement(rows)
    expect(m.collections).toEqual([{ fv: 'FV-2-70', collected: 2_678_350, receipts: ['RC-1-53'], iso: '2026-07-03' }])
  })

  it('nota crédito: NC de la cuenta 13050501, con FV si viene en la descripción', () => {
    const m = parseAccountingMovement(rows)
    expect(m.creditNotes).toHaveLength(2)
    expect(m.creditNotes.find(n => n.comprobante === 'NC-2-7')!).toMatchObject({ clientNit: '901163686', amount: 5_125_848.75, fvRef: null })
    expect(m.creditNotes.find(n => n.comprobante === 'NC-1-15')!).toMatchObject({ amount: 250_000, fvRef: 'FV-2-77' })
  })

  it('factura del tercero (FC/2335) y pago (RP/banco)', () => {
    const m = parseAccountingMovement(rows)
    expect(m.thirdInvoices).toEqual([{ terceroNit: '901390501', terceroName: 'SIG Consultoria', doc: 'FC-1-40', iso: '2026-07-28', amount: 1_339_175, fvRef: null }])
    expect(m.payments.map(p => p.rp)).toEqual(['RP-1-114', 'RP-1-99'])
    expect(m.payments.find(p => p.rp === 'RP-1-114')!.amount).toBe(1_339_175)
  })

  it('devuelve estructura vacía si no hay encabezado', () => {
    expect(parseAccountingMovement([['foo', 'bar']])).toEqual({ sales: [], creditNotes: [], debitNotes: [], collections: [], thirdInvoices: [], payments: [] })
  })

  it('base = Valor base del IVA (no la de retención); mandato desde 28051001', () => {
    // FV-2-80 real: servicio en 41 + IVA, y honorarios de mandato (Freddy) en 28051001.
    // El IVA reporta Valor base 1.125.452 (servicio); la retención 2.525.452 (total).
    const split: string[][] = [
      header,
      ['41800101', '901769961', 'FV-2-80', '7/6/26', '875,452.50', 'Gestión comercial', '', 'WIP COLOMBIA', ''],
      ['41800101', '901769961', 'FV-2-80', '7/6/26', '250,000.00', 'Tesorería', '', 'WIP COLOMBIA', ''],
      ['28051001', '901769961', 'FV-2-80', '7/6/26', '1,400,000.00', 'Contrato de Mandato Freddy Leon', '', 'WIP COLOMBIA', ''],
      ['24080601', '901769961', 'FV-2-80', '7/6/26', '213,835.98', 'IVA 19%', '1,125,452.50', 'WIP COLOMBIA', ''],
      ['13551509', '901769961', 'FV-2-80', '7/6/26', '', 'Retefuente 11%', '2,525,452.50', 'WIP COLOMBIA', ''],
    ]
    const s = parseAccountingMovement(split).sales[0]!
    expect(s.fv).toBe('FV-2-80')
    expect(s.income).toBe(1_125_452.5)    // cuenta 41 (Gestión + Tesorería)
    expect(s.taxBase).toBe(1_125_452.5)   // base del IVA (NO la de retención 2.525.452)
    expect(s.mandate).toBe(1_400_000)     // porción de mandato (cuenta 28051001)
  })

  it('respeta cuentas configurables (override de prefijos)', () => {
    const custom: string[][] = [
      header,
      ['70010101', '901', 'FV-9-1', '7/1/26', '1,000,000.00', 'Venta', '', 'Cliente X', ''],
    ]
    // Con income por defecto (41) no reconoce la venta en 7001…
    expect(parseAccountingMovement(custom).sales).toHaveLength(0)
    // Con override income='7001' sí
    const m = parseAccountingMovement(custom, { income: '7001' })
    expect(m.sales).toHaveLength(1)
    expect(m.sales[0]!.income).toBe(1_000_000)
  })
})
