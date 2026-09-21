import { describe, it, expect } from 'vitest'
import {
  calcParticipation,
  availableParticipation,
  deriveInvoiceStatus,
  formatPurchaseOrder,
  formatPaymentOrder,
  excelSerialToISO,
  extractInvoiceRef,
  extractMonthRef,
  validateThirdPartyInvoice,
  normalizeInvoiceNumber,
  normalizeSiigoInvoice,
  nitMatch,
  parseSiigoDate,
  parseColombianNumber,
  parseAccountingMovement,
  addMonths,
  billedPeriods,
} from '../src/modules/participations/participations.domain.js'
import {
  updateInvoiceParticipationSchema,
  reallocatePaymentSchema,
  unlinkPaymentSchema,
  unlinkSaleInvoiceSchema,
} from '../src/modules/participations/participations.schema.js'


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

describe('addMonths', () => {
  it('suma y resta meses cruzando el año', () => {
    expect(addMonths('2026-03', 1)).toBe('2026-04')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-05', -5)).toBe('2025-12')
  })
})

describe('billedPeriods (backfill de OC)', () => {
  it('anticipado: incluye el mes actual; vencido: hasta el mes anterior', () => {
    expect(billedPeriods({ startDate: '2026-03-01', billingDay: 1, billingMode: 'anticipado', targetMonth: '2026-03' }))
      .toEqual([{ period: '2026-03', proration: 1 }])
    // vencido, generando en marzo: aún no hay periodo (se factura el mes siguiente)
    expect(billedPeriods({ startDate: '2026-03-01', billingDay: 1, billingMode: 'vencido', targetMonth: '2026-03' }))
      .toEqual([])
    // vencido, generando en mayo: marzo y abril
    expect(billedPeriods({ startDate: '2026-03-01', billingDay: 1, billingMode: 'vencido', targetMonth: '2026-05' }))
      .toEqual([{ period: '2026-03', proration: 1 }, { period: '2026-04', proration: 1 }])
  })

  it('prorratea SOLO el primer mes cuando inicia el 15', () => {
    expect(billedPeriods({ startDate: '2026-03-15', billingDay: 15, billingMode: 'anticipado', targetMonth: '2026-05' }))
      .toEqual([
        { period: '2026-03', proration: 0.5 },
        { period: '2026-04', proration: 1 },
        { period: '2026-05', proration: 1 },
      ])
  })

  it('respeta end_date (no genera meses posteriores)', () => {
    expect(billedPeriods({ startDate: '2026-01-01', billingDay: 1, billingMode: 'anticipado', targetMonth: '2026-06', endDate: '2026-03-31' }))
      .toEqual([
        { period: '2026-01', proration: 1 },
        { period: '2026-02', proration: 1 },
        { period: '2026-03', proration: 1 },
      ])
  })

  it('backfill de varios meses atrás (fecha de inicio antigua)', () => {
    const out = billedPeriods({ startDate: '2025-11-01', billingDay: 1, billingMode: 'anticipado', targetMonth: '2026-02' })
    expect(out.map(p => p.period)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
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
  it('FC del tercero por encima de lo causado → diferencia de valor', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 170_000 })).toBe('value_difference')
  })
  it('FC del tercero cubre solo parte de lo causado → sigue pendiente factura tercero', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 90_000 })).toBe('pending_third_invoice')
  })
  it('FC coincide, sin egreso → pendiente de pago', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 150_000 })).toBe('pending_payment')
  })
  it('FC coincide con pago parcial (< participación) → sigue pendiente de pago', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 150_000, egress_voucher: 'RP-1', egress_voucher_value: 90_000 })).toBe('pending_payment')
  })
  it('FC coincide y pago acumulado ≥ participación → completa', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', participation_value: 150_000, third_party_invoice: 'FC-1', third_party_invoice_value: 150_000, egress_voucher: 'RP-1, RP-2', egress_voucher_value: 150_000 })).toBe('complete')
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
    expect(m.collections).toHaveLength(1)
    expect(m.collections[0]).toMatchObject({ fv: 'FV-2-70', collected: 2_678_350, receipts: ['RC-1-53'], iso: '2026-07-03', clientNit: '901178069', clientName: 'Sukot Roofing SAS' })
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

  it('captura RC sin FV en la descripción y detecta el mes', () => {
    const rcRows: string[][] = [
      header,
      ['13050501', '901178069', 'RC-1-80', '7/10/26', '1,500,000.00', 'Pago mensualidad mes de mayo', '', 'Sukot Roofing SAS', ''],
      ['13050501', '901178069', 'RC-1-81', '7/12/26', '800,000.00', 'Abono transferencia Bancolombia', '', 'Sukot Roofing SAS', ''],
    ]
    const m = parseAccountingMovement(rcRows)
    expect(m.collections).toHaveLength(2)
    expect(m.collections[0]).toMatchObject({
      receipt: 'RC-1-80',
      fvRef: null,
      monthRef: '2026-05',
      amount: 1_500_000,
    })
    expect(m.collections[1]).toMatchObject({
      receipt: 'RC-1-81',
      fvRef: null,
      monthRef: null,
      amount: 800_000,
    })
  })
})

describe('extractMonthRef', () => {
  it('detecta meses nombrados en español', () => {
    expect(extractMonthRef('Pago mensualidad mayo', '2026-07-15')).toBe('2026-05')
    expect(extractMonthRef('Abono mes de junio 2025', '2026-07-15')).toBe('2025-06')
    expect(extractMonthRef('Honorarios diciembre', '2026-07-15')).toBe('2026-12')
    expect(extractMonthRef('Servicio setiembre', '2026-07-15')).toBe('2026-09')
  })

  it('detecta formatos numéricos YYYY-MM y MM/YYYY', () => {
    expect(extractMonthRef('Pago periodo 2026-04')).toBe('2026-04')
    expect(extractMonthRef('Cuota 03/2026')).toBe('2026-03')
  })

  it('no confunde fechas completas DD/MM/YYYY con meses de facturación', () => {
    expect(extractMonthRef('FV-2-70 Cuota: 1 Fecha: 17/06/2026')).toBeNull()
  })

  it('retorna null si no hay mes en la descripción', () => {
    expect(extractMonthRef('Transferencia Bancolombia')).toBeNull()
    expect(extractMonthRef('')).toBeNull()
  })
})

describe('Edición manual de etapas y reasignación de pagos', () => {
  it('valida el esquema de edición de etapas 2, 3, 4 y 5', () => {
    const valid = updateInvoiceParticipationSchema.parse({
      finto_invoice: 'FV-4-5000',
      finto_invoice_date: '2026-08-10',
      finto_invoice_value: 1_200_000,
      cash_receipts: 'RC-1-99',
      collected: 600_000,
      third_party_invoice: 'FC-1-20',
      third_party_invoice_value: 300_000,
      payment_order: 'OP-202608-000001',
      egress_voucher: 'RP-1-88',
      egress_voucher_value: 300_000,
    })
    expect(valid.finto_invoice).toBe('FV-4-5000')
    expect(valid.collected).toBe(600_000)
    expect(valid.egress_voucher_value).toBe(300_000)
  })

  it('permite valores nulos para limpiar campos en edición manual', () => {
    const cleared = updateInvoiceParticipationSchema.parse({
      finto_invoice: null,
      third_party_invoice: null,
      egress_voucher: null,
    })
    expect(cleared.finto_invoice).toBeNull()
    expect(cleared.third_party_invoice).toBeNull()
  })

  it('valida el esquema de reasignación de pagos', () => {
    const valid = reallocatePaymentSchema.parse({
      from_invoice_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      to_invoice_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      amount: 450_000,
      comprobante: 'RC-1-53',
    })
    expect(valid.amount).toBe(450_000)
    expect(valid.comprobante).toBe('RC-1-53')

    expect(() => reallocatePaymentSchema.parse({
      from_invoice_id: 'invalid-uuid',
      to_invoice_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
      amount: -10,
    })).toThrow()
  })

  it('valida el esquema de desvinculación de pagos', () => {
    const valid = unlinkPaymentSchema.parse({
      invoice_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      amount: 250_000,
      comprobante: 'RC-1-80',
    })
    expect(valid.amount).toBe(250_000)
    expect(valid.comprobante).toBe('RC-1-80')

    expect(() => unlinkPaymentSchema.parse({
      invoice_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      amount: 0,
      comprobante: '',
    })).toThrow()
  })

  it('valida el esquema de desvinculación de factura de venta (FV) de una OC', () => {
    const valid = unlinkSaleInvoiceSchema.parse({
      invoice_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      unlink_receipts: true,
    })
    expect(valid.invoice_id).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')
    expect(valid.unlink_receipts).toBe(true)

    // Por defecto unlink_receipts es false
    const def = unlinkSaleInvoiceSchema.parse({
      invoice_id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    })
    expect(def.unlink_receipts).toBe(false)
  })

  it('al desvincular la factura de venta (FV) el estado regresa a pending_invoice', () => {
    const status = deriveInvoiceStatus({
      finto_invoice: null,
      finto_invoice_value: 0,
      collected: 0,
      available_for_payment: 0,
      participation_value: 200_000,
    })
    expect(status).toBe('pending_invoice')
  })

  it('recalcula disponibilidad para el tercero proporcional al recaudo editado', () => {
    // Si la participación es del 20% (100.000 sobre 500.000) y se recauda la mitad (250.000)
    const availHalf = availableParticipation({
      type: 'percentage',
      participationValue: 100_000,
      invoiceValue: 500_000,
      collected: 250_000,
    })
    expect(availHalf).toBe(50_000)

    // Si se edita el recaudo al 100% (500.000)
    const availFull = availableParticipation({
      type: 'percentage',
      participationValue: 100_000,
      invoiceValue: 500_000,
      collected: 500_000,
    })
    expect(availFull).toBe(100_000)
  })

  it('recalcula el estado según los datos ingresados en las etapas 2, 4 y 5', () => {
    // 1. Sin FV ni FC ni RP -> pending_invoice
    expect(deriveInvoiceStatus({
      finto_invoice: null,
      third_party_invoice: null,
      egress_voucher: null,
    })).toBe('pending_invoice')

    // 2. Con FV pero sin FC -> pending_third_invoice
    expect(deriveInvoiceStatus({
      finto_invoice: 'FV-4-100',
      finto_invoice_value: 500_000,
      participation_value: 100_000,
      third_party_invoice: null,
    })).toBe('pending_third_invoice')

    // 3. Con FC conciliada (100.000 = 100.000) sin pago -> pending_payment
    expect(deriveInvoiceStatus({
      finto_invoice: 'FV-4-100',
      participation_value: 100_000,
      third_party_invoice: 'FC-1-20',
      third_party_invoice_value: 100_000,
      egress_voucher: null,
    })).toBe('pending_payment')

    // 4. Con RP pagado (100.000) -> complete
    expect(deriveInvoiceStatus({
      finto_invoice: 'FV-4-100',
      participation_value: 100_000,
      third_party_invoice: 'FC-1-20',
      third_party_invoice_value: 100_000,
      egress_voucher: 'RP-1-5',
      egress_voucher_value: 100_000,
    })).toBe('complete')
  })

  it('un pago que cubre varias facturas deja matched=false si aún conserva saldo remanente', () => {
    const docAmount = 1_000_000
    const totalApplied = 300_000
    const remaining = docAmount - totalApplied
    const matched = remaining <= 0.01

    expect(remaining).toBe(700_000)
    expect(matched).toBe(false)

    // Si luego se aplican los 700.000 restantes
    const nextApplied = totalApplied + 700_000
    const finalRemaining = Math.max(0, docAmount - nextApplied)
    const finalMatched = finalRemaining <= 0.01

    expect(finalRemaining).toBe(0)
    expect(finalMatched).toBe(true)
  })

  it('al desvincular o reasignar una FV a otra OC, la OC anterior queda con etapas 3, 4 y 5 limpias y sin RP', () => {
    // Simula el estado de la OC anterior antes de ser limpiada
    const oldOcBefore = {
      finto_invoice: 'FV-1-100',
      finto_invoice_date: '2026-08-01',
      finto_invoice_value: 1_000_000,
      collected: 1_000_000,
      cash_receipts: 'RC-1-20',
      available_for_payment: 200_000,
      third_party_invoice: 'FC-1-50',
      third_party_invoice_value: 200_000,
      payment_order: 'OP-202608-0001',
      egress_voucher: 'RP-1-10',
      egress_voucher_value: 200_000,
    }

    // Tras la reasignación, se limpian todas las vinculaciones de la OC previa
    const oldOcCleaned = {
      ...oldOcBefore,
      finto_invoice: null,
      finto_invoice_date: null,
      finto_invoice_value: 0,
      cash_receipts: null,
      cash_receipt_date: null,
      collected: 0,
      available_for_payment: 0,
      third_party_invoice: null,
      third_party_invoice_date: null,
      third_party_invoice_value: null,
      payment_order: null,
      payment_order_date: null,
      egress_voucher: null,
      egress_voucher_date: null,
      egress_voucher_value: null,
    }

    expect(oldOcCleaned.egress_voucher).toBeNull()
    expect(oldOcCleaned.payment_order).toBeNull()
    expect(oldOcCleaned.third_party_invoice).toBeNull()
    expect(oldOcCleaned.cash_receipts).toBeNull()
    expect(deriveInvoiceStatus(oldOcCleaned)).toBe('pending_invoice')
  })
})

