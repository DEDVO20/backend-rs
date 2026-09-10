import { describe, it, expect } from 'vitest'
import {
  computeOperation, type TaxProfile, type WithholdingAgent, type OperationSettings,
} from '../src/modules/tax/tax.domain.js'

// Escenario de ejemplo de la matriz (spec §3). Parametrizado, no hardcodeado.
const SETTINGS: OperationSettings = {
  ivaRate:               0.19,
  incomeWithholdingRate: 0.11,
  icaWithholdingRate:    0.00866,
  ivaWithholdingRate:    0.15,
  commissionRate:        0.20,
  commissionIvaRate:     0.19,
}

// Receptor que es agente de todas las retenciones (escenario de la matriz).
const FULL_AGENT: WithholdingAgent = {
  incomeWithholdingAgent: true, icaWithholdingAgent: true, ivaWithholdingAgent: true,
}

const BASE = 600_000

describe('computeOperation — motor tributario', () => {
  it('Persona jurídica agente: retiene sobre factura y comisión (spec §4-§6)', () => {
    const emitter: TaxProfile = {
      personType: 'JURIDICA', taxRegime: 'ORDINARY', ivaResponsible: true, grandTaxpayer: false,
      incomeWithholding: { subject: true }, icaWithholding: { subject: true }, ivaWithholding: { subject: false },
      agentIncomeWithholding: true, agentIcaWithholding: true,   // es agente retenedor
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })

    expect(r.invoiceIva).toBe(114_000)          // 600.000 × 19%
    expect(r.invoiceTotal).toBe(714_000)
    expect(r.incomeWithholding.amount).toBe(66_000)   // 600.000 × 11%
    expect(r.icaWithholding.amount).toBe(5_196)       // 600.000 × 0,00866
    expect(r.ivaWithholding.amount).toBe(0)           // no sujeto a reteIVA
    expect(r.invoicePayment).toBe(642_804)            // 714.000 − 66.000 − 5.196

    expect(r.commission).toBe(120_000)                // 600.000 × 20%
    expect(r.commissionIva).toBe(22_800)              // 120.000 × 19%
    expect(r.commissionTotal).toBe(142_800)
    expect(r.commissionIncomeWithholding.amount).toBe(13_200)  // 120.000 × 11%
    expect(r.commissionIcaWithholding.amount).toBe(1_039.2)    // 120.000 × 0,00866
    expect(r.commissionNet).toBe(128_560.8)
    expect(r.finalTotal).toBe(514_243.2)              // 642.804 − 128.560,80
  })

  // Caso exacto de la hoja de cálculo del usuario (PN-Freddy).
  it('PN-Freddy: NO responsable de IVA, NO agente ⇒ giro 386.004 (Excel usuario)', () => {
    const emitter: TaxProfile = {
      personType: 'NATURAL', taxRegime: 'ORDINARY', ivaResponsible: false, grandTaxpayer: false,
      incomeWithholding: { subject: true }, icaWithholding: { subject: true }, ivaWithholding: { subject: false },
      agentIncomeWithholding: false, agentIcaWithholding: false,   // PN no es agente retenedor
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })

    // Bloque factura → Pago 528.804
    expect(r.invoiceIva).toBe(0)
    expect(r.invoiceTotal).toBe(600_000)
    expect(r.incomeWithholding.amount).toBe(66_000)   // 11%
    expect(r.icaWithholding.amount).toBe(5_196)       // 0,00866
    expect(r.invoicePayment).toBe(528_804)            // 600.000 − 66.000 − 5.196

    // Comisión: el PN no retiene sobre la comisión (0% en el Excel)
    expect(r.commissionIncomeWithholding.amount).toBe(0)
    expect(r.commissionIcaWithholding.amount).toBe(0)

    // Bloque giro → 386.004
    expect(r.finalTotal).toBe(386_004)   // 528.804 − 120.000 − 22.800
  })

  it('RS sin IVA-Giovanny: SIMPLE no sujeto a retenciones ⇒ giro = base', () => {
    const emitter: TaxProfile = {
      personType: 'NATURAL', taxRegime: 'SIMPLE', ivaResponsible: false, grandTaxpayer: false,
      incomeWithholding: { subject: false }, icaWithholding: { subject: false }, ivaWithholding: { subject: false },
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })

    expect(r.invoiceIva).toBe(0)
    expect(r.incomeWithholding.amount).toBe(0)
    expect(r.icaWithholding.amount).toBe(0)
    expect(r.invoicePayment).toBe(600_000)
  })

  // Los 4 perfiles de la matriz del usuario (bloque "Giro"/total final).
  it('RS sin IVA-Giovanny: SIMPLE sin IVA, sin retenciones ⇒ giro 457.200', () => {
    const emitter: TaxProfile = {
      personType: 'NATURAL', taxRegime: 'SIMPLE', ivaResponsible: false, grandTaxpayer: false,
      incomeWithholding: { subject: false }, icaWithholding: { subject: false }, ivaWithholding: { subject: false },
      agentIncomeWithholding: false, agentIcaWithholding: false,
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })
    expect(r.invoiceIva).toBe(0)
    expect(r.incomeWithholding.amount).toBe(0)
    expect(r.icaWithholding.amount).toBe(0)
    expect(r.finalTotal).toBe(457_200)   // 600.000 − 120.000 − 22.800
  })

  it('RS con IVA-Paola: SIMPLE responsable, sujeto a reteIVA ⇒ giro 554.100', () => {
    const emitter: TaxProfile = {
      personType: 'JURIDICA', taxRegime: 'SIMPLE', ivaResponsible: true, grandTaxpayer: false,
      incomeWithholding: { subject: false }, icaWithholding: { subject: false }, ivaWithholding: { subject: true },
      agentIncomeWithholding: false, agentIcaWithholding: false,
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })
    expect(r.invoiceIva).toBe(114_000)
    expect(r.incomeWithholding.amount).toBe(0)
    expect(r.icaWithholding.amount).toBe(0)
    expect(r.ivaWithholding.amount).toBe(17_100)      // 114.000 × 15%
    expect(r.invoicePayment).toBe(696_900)            // 714.000 − 17.100
    expect(r.finalTotal).toBe(554_100)                // 696.900 − 120.000 − 22.800
  })

  it('reteIVA: se calcula sobre el IVA generado cuando aplica (spec §5)', () => {
    const emitter: TaxProfile = {
      personType: 'JURIDICA', taxRegime: 'ORDINARY', ivaResponsible: true, grandTaxpayer: false,
      incomeWithholding: { subject: false }, icaWithholding: { subject: false }, ivaWithholding: { subject: true },
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })

    expect(r.invoiceIva).toBe(114_000)
    expect(r.ivaWithholding.amount).toBe(17_100)      // 114.000 × 15%
    expect(r.invoicePayment).toBe(696_900)            // 714.000 − 17.100
  })

  it('reteIVA no aplica si no hay IVA que retener', () => {
    const emitter: TaxProfile = {
      personType: 'NATURAL', taxRegime: 'ORDINARY', ivaResponsible: false, grandTaxpayer: false,
      ivaWithholding: { subject: true },
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })
    expect(r.ivaWithholding.applied).toBe(false)
    expect(r.ivaWithholding.amount).toBe(0)
  })

  it('una retención no se aplica si el receptor no es agente (spec §5)', () => {
    const emitter: TaxProfile = {
      personType: 'JURIDICA', taxRegime: 'ORDINARY', ivaResponsible: true, grandTaxpayer: false,
      incomeWithholding: { subject: true }, icaWithholding: { subject: true },
    }
    const noAgent: WithholdingAgent = {
      incomeWithholdingAgent: false, icaWithholdingAgent: false, ivaWithholdingAgent: false,
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: noAgent, settings: SETTINGS })
    expect(r.incomeWithholding.applied).toBe(false)
    expect(r.incomeWithholding.amount).toBe(0)
    expect(r.invoicePayment).toBe(714_000)            // sin retenciones
  })

  it('tarifa override del perfil tiene prioridad sobre la de la operación', () => {
    const emitter: TaxProfile = {
      personType: 'JURIDICA', taxRegime: 'ORDINARY', ivaResponsible: true, grandTaxpayer: false,
      incomeWithholding: { subject: true, rate: 0.04 },   // override 4%
    }
    const r = computeOperation({ invoiceValue: BASE, emitter, receiver: FULL_AGENT, settings: SETTINGS })
    expect(r.incomeWithholding.rate).toBe(0.04)
    expect(r.incomeWithholding.amount).toBe(24_000)   // 600.000 × 4%
  })
})
