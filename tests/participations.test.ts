import { describe, it, expect } from 'vitest'
import {
  calcParticipation,
  formatPurchaseOrder,
  validateInvoicing,
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
})
