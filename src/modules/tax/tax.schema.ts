import { z } from 'zod'

const rate = z.number().min(0).max(1)   // tarifas como fracción (0.19 = 19%)

// ── Perfil tributario del catálogo (spec §1, §2) ─────────────────────────────
export const createTaxProfileSchema = z.object({
  name:        z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(200),
  description: z.string().max(500).nullable().optional(),

  tax_regime:      z.enum(['ORDINARY', 'SIMPLE']).default('ORDINARY'),
  iva_responsible: z.boolean().default(false),
  grand_taxpayer:  z.boolean().default(false),
  self_withholder: z.boolean().default(false),

  subject_income_withholding: z.boolean().default(false),
  subject_ica_withholding:    z.boolean().default(false),
  subject_iva_withholding:    z.boolean().default(false),

  agent_income_withholding: z.boolean().default(false),
  agent_ica_withholding:    z.boolean().default(false),
  agent_iva_withholding:    z.boolean().default(false),

  iva_rate:                z.union([rate, z.null()]).optional(),
  income_withholding_rate: z.union([rate, z.null()]).optional(),
  ica_withholding_rate:    z.union([rate, z.null()]).optional(),
  iva_withholding_rate:    z.union([rate, z.null()]).optional(),

  active: z.boolean().default(true),
})

export const updateTaxProfileSchema = createTaxProfileSchema.partial()
  .refine(v => Object.keys(v).length > 0, { message: 'Nada que actualizar' })

// ── Parámetros por defecto de la operación (spec §3, §10) ────────────────────
export const updateSettingsSchema = z.object({
  iva_rate:                rate.optional(),
  income_withholding_rate: rate.optional(),
  ica_withholding_rate:    rate.optional(),
  iva_withholding_rate:    rate.optional(),
  commission_rate:         rate.optional(),
  commission_iva_rate:     rate.optional(),
  default_invoice_value:   z.number().nonnegative().optional(),
}).refine(v => Object.keys(v).length > 0, { message: 'Nada que actualizar' })

// ── Matriz comparativa (spec §8) ─────────────────────────────────────────────
export const matrixQuerySchema = z.object({
  invoice_value: z.coerce.number().nonnegative().optional(),
})

// El receptor por defecto es agente de todas las retenciones (escenario matriz).
const receiverSchema = z.object({
  incomeWithholdingAgent: z.boolean().default(true),
  icaWithholdingAgent:    z.boolean().default(true),
  ivaWithholdingAgent:    z.boolean().default(true),
}).default({ incomeWithholdingAgent: true, icaWithholdingAgent: true, ivaWithholdingAgent: true })

// ── Cálculo ad-hoc de una operación con un tercero concreto ──────────────────
export const computeSchema = z.object({
  invoice_value:  z.number().nonnegative(),
  third_party_id: z.string().uuid().optional(),
  tax_profile_id: z.string().uuid().optional(),
  receiver:       receiverSchema.optional(),
}).refine(v => v.third_party_id || v.tax_profile_id, {
  message: 'Indica un tercero o un perfil tributario',
})
