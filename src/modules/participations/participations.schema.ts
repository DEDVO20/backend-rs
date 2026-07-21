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
  percentage:         z.number().min(0).max(100).optional(),
  start_date:         z.string().date().optional(),
  active:             z.boolean().default(true),
}).refine(
  v => !v.has_third_party || (!!v.third_party_id && v.percentage !== undefined && !!v.start_date),
  { message: 'Con tercero se requiere tercero, porcentaje y fecha de inicio' },
)

// ── Registro manual de facturación ───────────────────────────────────────────
export const invoicingSchema = z.object({
  finto_invoice:             z.string().max(60).nullable().optional(),
  finto_invoice_date:        z.string().date().nullable().optional(),
  finto_invoice_value:       z.number().nonnegative().nullable().optional(),
  third_party_invoice:       z.string().max(60).nullable().optional(),
  third_party_invoice_date:  z.string().date().nullable().optional(),
  third_party_invoice_value: z.number().nonnegative().nullable().optional(),
  observations:              z.string().max(1000).nullable().optional(),
})

export const generateParticipationsSchema = z.object({
  year:  z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})
