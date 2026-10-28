import { describe, it, expect } from 'vitest'
import {
  consecutivosFaltantesRC,
  crearRangosMensuales,
  expandirMovimientosVoucher,
  fusionarListaVouchers,
  newResolutionState,
  nombresRCPorCatalogo,
  registrarAplicacionesFactura,
  type CollectionInvoiceLookup,
} from '../src/modules/siigo/siigo.collections.js'

const noInvoices: CollectionInvoiceLookup = { getInvoiceTotal: async () => 0 }

describe('expandirMovimientosVoucher', () => {
  it('usa items[].value con due y no suma retenciones, impuestos ni la contrapartida del pago', async () => {
    const voucher = {
      name: 'RC-1-40',
      items: [
        {
          account: { code: '13050501' },
          description: 'FV-2-43',
          value: 1_000_000,
          due: { prefix: 'FV-2', consecutive: 43, quote: 1, date: '2026-03-31' },
          taxes: [{ name: 'ReteFuente', value: 110_000 }],
        },
        { account: { code: '13551501' }, description: 'ReteFuente 11%', value: 110_000 },
        { account: { code: '11100501' }, description: 'Pago', value: 890_000 },
      ],
    }

    const movs = await expandirMovimientosVoucher(voucher, newResolutionState(), '901655024', noInvoices)
    expect(movs).toHaveLength(1)
    expect(movs[0]).toMatchObject({ clase: 'ITEM', documentoBase: 'FV-2-43', quote: 1, dueDate: '2026-03-31', valor: 1_000_000 })
  })

  it('usa payment.value una sola vez cuando el voucher no trae items (anticipo)', async () => {
    const voucher = { name: 'RC-1-41', type: 'AdvancePayment', items: [], payment: { value: 500_000, name: 'Transferencia' } }
    const movs = await expandirMovimientosVoucher(voucher, newResolutionState(), '900', noInvoices)
    expect(movs).toHaveLength(1)
    expect(movs[0]).toMatchObject({ clase: 'ANTICIPO', documentoBase: 'RC-1-41', valor: 500_000 })
  })

  it('resuelve un abono sin due a la factura mencionada con la misma serie FV', async () => {
    const voucher = {
      name: 'RC-1-42',
      items: [
        { account: '13050501', value: 300_000, due: 'FV-2-30-1' },
        { account: '13050501', value: 200_000, description: 'Abono factura 31' },
      ],
    }
    const movs = await expandirMovimientosVoucher(voucher, newResolutionState(), '900', noInvoices)
    expect(movs.map(m => [m.documentoBase, m.valor])).toEqual([
      ['FV-2-30', 300_000],
      ['FV-2-31', 200_000],
    ])
  })

  it('relaciona un saldo a favor (2805) con el RC que lo originó', async () => {
    const estado = newResolutionState()
    const origen = { name: 'RC-1-10', items: [{ account: '28050501', value: 200_000, description: 'Anticipo cliente' }] }
    const uso = { name: 'RC-1-12', items: [{ account: '28050501', value: 200_000, description: 'De clientes' }] }

    const m1 = await expandirMovimientosVoucher(origen, estado, '900', noInvoices)
    const m2 = await expandirMovimientosVoucher(uso, estado, '900', noInvoices)
    expect(m1[0]!.vencimiento).toBe('RC-10-1')
    expect(m2[0]!.vencimiento).toBe('RC-10-1')
  })

  it('asigna un pago sin due al saldo pendiente de una factura anterior del cliente', async () => {
    const estado = newResolutionState()
    const lookup: CollectionInvoiceLookup = { getInvoiceTotal: async ref => (ref === 'FV-2-50' ? 1_000_000 : 0) }

    const primero = { name: 'RC-1-20', items: [{ account: '13050501', value: 600_000, due: { prefix: 'FV-2', consecutive: 50, quote: 1 } }] }
    const m1 = await expandirMovimientosVoucher(primero, estado, '800', lookup)
    registrarAplicacionesFactura(estado, '800', m1)

    const segundo = { name: 'RC-1-25', items: [{ account: '13050501', value: 400_000, description: 'Clientes nacionales' }] }
    const m2 = await expandirMovimientosVoucher(segundo, estado, '800', lookup)
    expect(m2[0]).toMatchObject({ documentoBase: 'FV-2-50', valor: 400_000 })
  })

  it('sin referencia suficiente conserva el RC como documento base', async () => {
    const voucher = { name: 'RC-1-30', items: [{ account: '13050501', value: 75_000, description: 'Clientes nacionales' }] }
    const movs = await expandirMovimientosVoucher(voucher, newResolutionState(), '700', noInvoices)
    expect(movs[0]).toMatchObject({ documentoBase: 'RC-1-30', valor: 75_000 })
  })
})

describe('fusionarListaVouchers', () => {
  it('une respuestas del mismo voucher sin duplicar ni perder items', () => {
    const a = { id: 'u1', name: 'RC-1-5', items: [{ value: 100, due: 'FV-2-1-1' }] }
    const b = { id: 'u1', name: 'RC-1-5', date: '2026-02-01', items: [{ value: 100, due: 'FV-2-1-1' }, { value: 50, due: 'FV-2-2-1' }] }
    const [v] = fusionarListaVouchers([a, b])
    expect(v!.date).toBe('2026-02-01')
    expect(v!.items).toHaveLength(2)
  })
})

describe('consecutivos RC', () => {
  it('detecta huecos internos por serie', () => {
    const docs = [{ name: 'RC-1-3' }, { name: 'RC-1-6' }, { name: 'RC-2-1' }]
    expect(consecutivosFaltantesRC(docs)).toEqual(['RC-1-4', 'RC-1-5'])
  })

  it('verifica hasta el consecutivo anterior al próximo del catálogo', () => {
    const docs = [{ name: 'RC-1-1' }, { name: 'RC-1-3' }]
    expect(nombresRCPorCatalogo(docs, [{ code: 1, consecutive: 5 }, { code: 9, consecutive: 1, active: true }])).toEqual([
      'RC-1-2',
      'RC-1-4',
    ])
  })
})

describe('crearRangosMensuales', () => {
  it('parte el periodo en meses respetando los extremos', () => {
    expect(crearRangosMensuales('2026-01-15', '2026-03-10')).toEqual([
      { inicio: '2026-01-15', fin: '2026-01-31' },
      { inicio: '2026-02-01', fin: '2026-02-28' },
      { inicio: '2026-03-01', fin: '2026-03-10' },
    ])
  })
})
