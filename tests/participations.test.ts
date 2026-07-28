import { describe, it, expect } from 'vitest'
import {
  calcParticipation,
  formatPurchaseOrder,
  validateInvoicing,
  calcReceivable,
  calcPayable,
  deriveStatus,
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
})

describe('formatPurchaseOrder', () => {
  it('formatea OC-YYYYMM-NNNNNN', () => {
    expect(formatPurchaseOrder(2026, 7, 1)).toBe('OC-202607-000001')
  })
  it('rellena mes y secuencia', () => {
    expect(formatPurchaseOrder(2026, 12, 123)).toBe('OC-202612-000123')
  })
})

describe('validateInvoicing', () => {
  const monthly = { service_value: 500_000, participation_value: 100_000 }

  it('validated cuando ambas facturas existen y los valores coinciden', () => {
    const r = validateInvoicing(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
    })
    expect(r.status).toBe('validated')
    expect(r.reasons).toHaveLength(0)
  })

  it('review si falta la factura del tercero', () => {
    const r = validateInvoicing(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: null, third_party_invoice_value: null,
    })
    expect(r.status).toBe('review')
    expect(r.reasons).toContain('No existe factura del tercero')
  })

  it('review si el valor de Finto no coincide', () => {
    const r = validateInvoicing(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 480_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
    })
    expect(r.status).toBe('review')
    expect(r.reasons.some(x => x.includes('Finto'))).toBe(true)
  })

  it('review si el valor del tercero no coincide con lo calculado', () => {
    const r = validateInvoicing(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 90_000,
    })
    expect(r.status).toBe('review')
    expect(r.reasons.some(x => x.includes('tercero'))).toBe(true)
  })

  it('review con dos motivos cuando no hay ninguna factura', () => {
    const r = validateInvoicing(monthly, null)
    expect(r.status).toBe('review')
    expect(r.reasons).toHaveLength(2)
  })

  it('review si el recaudo no coincide con lo facturado por Finto', () => {
    const r = validateInvoicing(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
      cash_receipt: 'RC-1', cash_receipt_value: 400_000,
    })
    expect(r.status).toBe('review')
    expect(r.reasons.some(x => x.includes('recaudo'))).toBe(true)
  })

  it('review si el pago al tercero no coincide con la participación', () => {
    const r = validateInvoicing(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
      egress_voucher: 'CE-1', egress_voucher_value: 80_000,
    })
    expect(r.status).toBe('review')
    expect(r.reasons.some(x => x.includes('pago al tercero'))).toBe(true)
  })

  it('no exige recaudo ni pago si aún no se registraron', () => {
    const r = validateInvoicing(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
    })
    expect(r.status).toBe('validated')
  })
})

describe('CxC Clientes / CxP Terceros', () => {
  it('CxC = facturado por Finto − recaudado', () => {
    expect(calcReceivable({ finto_invoice_value: 500_000, cash_receipt_value: 200_000 })).toBe(300_000)
  })

  it('CxC completo cuando no hay recaudo', () => {
    expect(calcReceivable({ finto_invoice_value: 500_000 })).toBe(500_000)
  })

  it('CxP = facturado por el tercero − pagado', () => {
    expect(calcPayable({ third_party_invoice_value: 100_000, egress_voucher_value: 100_000 })).toBe(0)
  })

  it('sin datos ambos saldos son 0', () => {
    expect(calcReceivable(null)).toBe(0)
    expect(calcPayable(null)).toBe(0)
  })
})

describe('deriveStatus', () => {
  const monthly = { service_value: 500_000, participation_value: 100_000 }

  it('pending cuando no se ha registrado nada', () => {
    expect(deriveStatus(monthly, null).status).toBe('pending')
  })

  it('validated con facturas correctas pero sin recaudar ni pagar', () => {
    const r = deriveStatus(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
    })
    expect(r.status).toBe('validated')
    expect(r.receivable).toBe(500_000)
    expect(r.payable).toBe(100_000)
  })

  it('closed cuando además se recaudó y se pagó completo', () => {
    const r = deriveStatus(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
      cash_receipt: 'RC-1', cash_receipt_value: 500_000,
      egress_voucher: 'CE-1', egress_voucher_value: 100_000,
    })
    expect(r.status).toBe('closed')
    expect(r.receivable).toBe(0)
    expect(r.payable).toBe(0)
  })

  it('sigue validated si solo se recaudó pero no se pagó al tercero', () => {
    const r = deriveStatus(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 500_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
      cash_receipt: 'RC-1', cash_receipt_value: 500_000,
    })
    expect(r.status).toBe('validated')
    expect(r.receivable).toBe(0)
    expect(r.payable).toBe(100_000)
  })

  it('review manda sobre cerrada si hay inconsistencia', () => {
    const r = deriveStatus(monthly, {
      finto_invoice: 'F-1', finto_invoice_value: 480_000,
      third_party_invoice: 'T-1', third_party_invoice_value: 100_000,
      cash_receipt: 'RC-1', cash_receipt_value: 480_000,
      egress_voucher: 'CE-1', egress_voucher_value: 100_000,
    })
    expect(r.status).toBe('review')
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
})
