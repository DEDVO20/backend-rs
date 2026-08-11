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

describe('deriveInvoiceStatus', () => {
  it('OC del mes sin FV → Pendiente de factura', () => {
    expect(deriveInvoiceStatus({ finto_invoice: null, finto_invoice_value: 500_000, collected: 0 })).toBe('pending_invoice')
  })
  it('FV presente sin recaudo → Facturada (no pendiente)', () => {
    expect(deriveInvoiceStatus({ finto_invoice: 'FV-4-1', finto_invoice_value: 500_000, collected: 0 })).toBe('invoiced')
  })
  it('sin recaudo → Facturada', () => {
    expect(deriveInvoiceStatus({ finto_invoice_value: 500_000, collected: 0 })).toBe('invoiced')
  })
  it('recaudo parcial', () => {
    expect(deriveInvoiceStatus({ finto_invoice_value: 500_000, collected: 200_000 })).toBe('partial_collection')
  })
  it('recaudo total → Disponible para pago', () => {
    expect(deriveInvoiceStatus({ finto_invoice_value: 500_000, collected: 500_000 })).toBe('available')
  })
  it('con orden de pago → Pago en proceso', () => {
    expect(deriveInvoiceStatus({ finto_invoice_value: 500_000, collected: 500_000, payment_order: 'OP-1' })).toBe('payment_in_process')
  })
  it('egreso completo → Cerrada', () => {
    expect(deriveInvoiceStatus({ finto_invoice_value: 500_000, collected: 500_000, available_for_payment: 100_000, egress_voucher: 'CE-1', egress_voucher_value: 100_000 })).toBe('closed')
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
