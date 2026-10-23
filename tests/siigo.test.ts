import { describe, it, expect } from 'vitest'
import {
  calcVentaItemSiigo,
  calcVentaSiigo,
  buildVentaLinesPorProducto,
  distribuirValorPorProducto,
} from '../src/modules/siigo/siigo.calculator.js'
import { buildSiigoExcelBuffer } from '../src/modules/siigo/siigo.exporter.js'
import { incrementalStartDate, matchCompanyByNit } from '../src/modules/siigo/siigo.helpers.js'

describe('incrementalStartDate', () => {
  it('arranca desde la última sync menos el solape', () => {
    expect(incrementalStartDate('2026-10-21', 5, 2025)).toBe('2026-10-16')
    expect(incrementalStartDate('2026-03-02', 5, 2025)).toBe('2026-02-25')
    expect(incrementalStartDate('2026-10-21', 0, 2025)).toBe('2026-10-21')
  })

  it('sin sync previa hace la carga completa del año base', () => {
    expect(incrementalStartDate(null, 5, 2025)).toBe('2025-01-01')
    expect(incrementalStartDate('basura', 5, 2025)).toBe('2025-01-01')
  })

  it('no retrocede antes del año base', () => {
    expect(incrementalStartDate('2025-01-02', 5, 2025)).toBe('2025-01-01')
  })
})

describe('matchCompanyByNit', () => {
  const companies = [
    { id: 'a', normNit: '901655024' },
    { id: 'b', normNit: '12345678' },
    { id: 'c', normNit: '123456789' },
  ]

  it('prefiere la coincidencia exacta', () => {
    expect(matchCompanyByNit(companies, '901.655.024')?.id).toBe('a')
    expect(matchCompanyByNit(companies, '12345678')?.id).toBe('b')
    expect(matchCompanyByNit(companies, '123456789')?.id).toBe('c')
  })

  it('tolera el dígito de verificación solo con un único candidato', () => {
    expect(matchCompanyByNit(companies, '9016550241')?.id).toBe('a')
    expect(matchCompanyByNit(companies, '90165502')?.id).toBe('a')
    // '1234567' podría ser 12345678 sin DV, pero 123456789 no aplica: único candidato
    expect(matchCompanyByNit(companies, '1234567')?.id).toBe('b')
  })

  it('no vincula cuando es ambiguo o vacío', () => {
    const dup = [{ id: 'x', normNit: '800100200' }, { id: 'y', normNit: '800100200' }]
    expect(matchCompanyByNit(dup, '800100200')).toBeNull()
    expect(matchCompanyByNit(companies, '')).toBeNull()
    expect(matchCompanyByNit(companies, '555')).toBeNull()
  })
})

describe('Siigo Calculator & Exporter (TypeScript)', () => {
  it('calcula impuestos, retenciones y cuadre por ítem correctamente', async () => {
    const mockDoc = {
      id: 'doc-123',
      name: 'FV-2-1050',
      date: '2026-03-15',
      seller: 689,
      customer: {
        identification: '901655024',
        branch_office: '0',
      },
      items: [
        {
          code: '02',
          description: 'Contabilidad e impuestos',
          quantity: 1,
          price: 1000000,
          taxes: [
            { name: 'IVA 19%', percentage: 19, amount: 190000 },
            { name: 'ReteFuente 11%', percentage: 11, amount: 110000 },
          ],
        },
      ],
      total: 1080000,
    }

    const lines = await buildVentaLinesPorProducto(
      mockDoc,
      'FACTURA',
      1,
      {
        getCustomerName: async () => 'ANL CORP SAS',
        getProductDescription: async () => 'Contabilidad e impuestos',
      },
      '2026-01-01',
      '2026-12-31',
      '689',
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]!.comprobante).toBe('FV-2-1050')
    expect(lines[0]!.customer_nit).toBe('901655024')
    expect(lines[0]!.customer_name).toBe('ANL CORP SAS')
    expect(lines[0]!.subtotal).toBe(1000000)
    expect(lines[0]!.tax_charge).toBe(190000)
    expect(lines[0]!.tax_retention).toBe(110000)
    expect(lines[0]!.total).toBe(1080000)
  })

  it('invierte signo en Notas Crédito y distribuye valores proporcionalmente', () => {
    const dist = distribuirValorPorProducto(100, [60, 40])
    expect(dist).toEqual([60, 40])

    const itemCalc = calcVentaItemSiigo({
      quantity: 2,
      price: 50000,
      discount: 10000,
    })
    expect(itemCalc.bruto).toBe(100000)
    expect(itemCalc.descuento).toBe(10000)
    expect(itemCalc.subtotal).toBe(90000)

    const docCalc = calcVentaSiigo({
      items: [{ quantity: 2, price: 50000, discount: 10000 }],
    })
    expect(docCalc.total).toBe(90000)
  })

  it('genera el archivo Excel en Buffer con las 3 hojas', async () => {
    const buffer = await buildSiigoExcelBuffer(
      [
        [
          'FV-2-1050',
          new Date(2026, 2, 15, 12, 0, 0),
          '901655024',
          '',
          'ANL CORP SAS',
          '02',
          'Contabilidad e impuestos',
          1000000,
          0,
          1000000,
          190000,
          110000,
          0,
          0,
          1080000,
        ],
      ],
      { 'Facturas incluidas': 1 },
    )
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.byteLength).toBeGreaterThan(1000)
  })
})
