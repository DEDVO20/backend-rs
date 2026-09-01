import { z } from 'zod'

// ── Catálogo de terceros ─────────────────────────────────────────────────────
export const thirdPartySchema = z.object({
  name:           z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(200),
  identification: z.string().max(50).optional(),
  active:         z.boolean().default(true),
})

export const updateThirdPartySchema = thirdPartySchema.partial()

// ── Configuración de participación por servicio contratado ───────────────────
// service_value se guarda en company_services; el resto en service_participations
export const upsertParticipationSchema = z.object({
  company_service_id: z.string().uuid(),
  service_value:      z.number().nonnegative(),          // valor mensual antes de IVA
  has_third_party:    z.boolean(),                       // "Tiene tercero"
  third_party_id:     z.string().uuid().nullable().optional(),
  // "Tipo" de contrato: servicio (comisión) o mandato (porción del mandante desde
  // la cuenta 28150601 en SIIGO). Ver participations.domain.ContractType.
  contract_type:      z.enum(['servicio', 'mandato']).default('servicio'),
  participation_type: z.enum(['percentage', 'fixed']).default('percentage'),
  percentage:         z.number().min(0).max(100).optional(),
  fixed_value:        z.number().nonnegative().nullable().optional(),
  start_date:         z.string().date().optional(),
  end_date:           z.string().date().nullable().optional(),
  active:             z.boolean().default(true),
}).refine(
  v => !v.has_third_party || (!!v.third_party_id && !!v.start_date),
  { message: 'Con tercero se requiere tercero y fecha de inicio' },
).refine(
  v => {
    if (!v.has_third_party) return true
    // Mandato: el monto lo aporta SIIGO (cuenta 28150601); el % es la comisión de
    // la firma, informativa, y no se exige.
    if (v.contract_type === 'mandato') return true
    if (v.participation_type === 'fixed') return (v.fixed_value ?? 0) > 0
    return v.percentage !== undefined
  },
  { message: 'Indica el porcentaje, o el valor fijo si el tipo es fijo' },
)

export const generateParticipationsSchema = z.object({
  year:  z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})

// Cuentas contables del import (prefijos; admite varios separados por "|")
const acct = z.string().trim().min(1).max(120).regex(/^[0-9|]+$/, 'Solo dígitos y "|"')
export const accountSettingsSchema = z.object({
  income_account:        acct,
  mandate_account:       acct,
  receivable_account:    acct,
  third_invoice_account: acct,
  payment_account:       acct,
})
