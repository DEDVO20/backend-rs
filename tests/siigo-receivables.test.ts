import { describe, it, expect } from 'vitest'
import {
  agingOf,
  balanceInPesos,
  buildReceivables,
  customerControls,
  dueDateOf,
  findControl,
  toReceivableInvoice,
} from '../src/modules/siigo/siigo.receivables.js'
import type { TrialBalanceLine } from '../src/modules/siigo/siigo.trialBalance.js'

const CUT = '2026-11-03'

function tb(account_code: string, identification: string, final_balance: number, branch = '0', third_party_name = ''): TrialBalanceLine {
  return {
    period: '2026-11', year: 2026, month: 11, cut_date: CUT, cut_type: 'Actual diario', level: 'AUXILIAR',
    class_label: '', group_label: '', account_label: '', subaccount_label: '', auxiliary_label: '', subauxiliary_label: '',
    transactional: 'Sí', account_code, account_name: '', identification, branch, third_party_name,
    initial_balance: 0, debit: 0, credit: 0, final_balance,
  }
}

function invoice(over: Record<string, any>) {
  return toReceivableInvoice({
    id: over.id,
    name: over.name,
    date: over.date ?? '2026-09-01',
    payments: over.due ? [{ due_date: over.due }] : [],
    customer: { id: 'c1', identification: over.nit ?? '900100200', branch_office: 0 },
    seller: 689,
    total: over.total ?? over.balance,
    balance: over.balance,
    currency: over.currency,
    annulled: over.annulled ?? false,
  })
}

describe('dueDateOf / agingOf', () => {
  it('toma el vencimiento más próximo y clasifica por días vencidos', () => {
    expect(dueDateOf([{ due_date: '2026-12-01' }, { due_date: '2026-10-15' }])).toBe('2026-10-15')
    expect(dueDateOf(null)).toBeNull()
    expect(agingOf('2026-11-10', CUT)).toEqual({ days: -7, bucket: 'No vencido' })
    expect(agingOf('2026-10-04', CUT)).toEqual({ days: 30, bucket: '1-30' })
    expect(agingOf('2026-08-01', CUT)).toEqual({ days: 94, bucket: '91+' })
    expect(agingOf(null, CUT)).toEqual({ days: null, bucket: 'Sin vencimiento' })
  })
})

describe('balanceInPesos', () => {
  it('COP sin conversión y USD proporcional al total en pesos', () => {
    expect(balanceInPesos('COP', 1, 1000, 400, 1000)).toBe(400)
    // Factura USD 100 a 4.000 = $400.000; saldo USD 50 → $200.000
    expect(balanceInPesos('USD', 4000, 100, 50, 400_000)).toBe(200_000)
    // Saldo que ya viene en pesos (ratio > 1.2) se respeta, sin superar el total
    expect(balanceInPesos('USD', 4000, 100, 300_000, 400_000)).toBe(300_000)
    expect(balanceInPesos('USD', 4000, 100, 900_000, 400_000)).toBe(400_000)
  })
})

describe('customerControls', () => {
  it('usa la cuenta exacta o, si no hay, sus subcuentas; suma solo saldos positivos', () => {
    const controls = customerControls([
      tb('13050501', '900100200', 700, '0', 'CLIENTE UNO SAS'), // 130505 vía subcuenta
      tb('13051001', '900100200', 300),
      tb('130505', '800500600', 1000), // exacta: ignora la subcuenta
      tb('13050501', '800500600', 1000),
      tb('13051001', '800500600', -200), // negativo: no suma al control
      tb('2805', '900100200', 999), // otra cuenta
    ])
    const uno = controls.get('900100200||0')!
    expect(uno.byAccount).toEqual({ '130505': 700, '13051001': 300 })
    expect(uno.totalPositive).toBe(1000)
    expect(uno.name).toBe('CLIENTE UNO SAS')

    const dos = controls.get('800500600||0')!
    expect(dos.byAccount).toEqual({ '130505': 1000, '13051001': -200 })
    expect(dos.totalPositive).toBe(1000)
  })

  it('encuentra el control tolerando el dígito de verificación', () => {
    const controls = customerControls([tb('13050501', '9001002001', 500)])
    expect(findControl(controls, '900100200', 0)?.totalPositive).toBe(500)
    expect(findControl(controls, '900100200', 1)).toBeNull()
  })
})

describe('buildReceivables', () => {
  it('limita el saldo de cada cliente a su saldo contable descontando las facturas más antiguas', () => {
    const invoices = [
      invoice({ id: 'a', name: 'FV-1', due: '2026-07-01', balance: 400 }),
      invoice({ id: 'b', name: 'FV-2', due: '2026-09-01', balance: 500 }),
      invoice({ id: 'c', name: 'FV-3', due: '2026-12-01', balance: 300 }),
    ]
    // Facturas suman 1.200; contablemente debe 800 → se reducen 400 de la más antigua
    const lines = buildReceivables(invoices, customerControls([tb('13050501', '900100200', 800)]), CUT)
    expect(lines.map(l => [l.invoice_name, l.balance, l.control_reduction, l.aging_bucket])).toEqual([
      ['FV-2', 500, 0, '61-90'],
      ['FV-3', 300, 0, 'No vencido'],
    ])
    expect(lines.reduce((s, l) => s + l.balance, 0)).toBe(800)
  })

  it('reduce parcialmente una factura y deja intactas las que caben', () => {
    const invoices = [
      invoice({ id: 'a', name: 'FV-1', due: '2026-07-01', balance: 400 }),
      invoice({ id: 'b', name: 'FV-2', due: '2026-09-01', balance: 500 }),
    ]
    const lines = buildReceivables(invoices, customerControls([tb('130505', '900100200', 700)]), CUT)
    expect(lines.map(l => [l.invoice_name, l.balance, l.control_reduction])).toEqual([
      ['FV-1', 200, 200],
      ['FV-2', 500, 0],
    ])
  })

  it('omite anuladas, sin saldo, posteriores al corte y clientes sin saldo contable', () => {
    const invoices = [
      invoice({ id: 'a', name: 'FV-1', due: '2026-10-01', balance: 400, annulled: true }),
      invoice({ id: 'b', name: 'FV-2', due: '2026-10-01', balance: 0.5 }),
      invoice({ id: 'c', name: 'FV-3', date: '2026-11-20', due: '2026-12-20', balance: 300 }),
      invoice({ id: 'd', name: 'FV-4', due: '2026-10-01', balance: 300, nit: '111222333' }), // sin control
      invoice({ id: 'e', name: 'FV-5', due: '2026-10-01', balance: 250 }),
    ]
    const lines = buildReceivables(invoices, customerControls([tb('130505', '900100200', 5000)]), CUT)
    expect(lines.map(l => l.invoice_name)).toEqual(['FV-5'])
    expect(lines[0]!.balance).toBe(250)
    expect(lines[0]!.days_overdue).toBe(33)
  })
})
