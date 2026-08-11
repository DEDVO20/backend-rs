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
    if (v.participation_type === 'fixed') return (v.fixed_value ?? 0) > 0
    return v.percentage !== undefined
  },
  { message: 'Indica el porcentaje, o el valor fijo si el tipo es fijo' },
)

// Fase 3: factura del tercero y comprobante de egreso
export const thirdPartyInvoiceSchema = z.object({
  third_party_invoice:       z.string().min(1).max(60),
  third_party_invoice_date:  z.string().date().nullable().optional(),
  third_party_invoice_value: z.number().nonnegative(),
})

export const egressSchema = z.object({
  egress_voucher:       z.string().min(1).max(60),
  egress_voucher_date:  z.string().date().nullable().optional(),
  egress_voucher_value: z.number().nonnegative(),
})

export const generateParticipationsSchema = z.object({
  year:  z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})
