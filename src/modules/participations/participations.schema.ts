import { z } from 'zod'

// ── Catálogo de terceros ─────────────────────────────────────────────────────
export const thirdPartySchema = z.object({
  name:           z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(200),
  identification: z.string().max(50).optional(),
  // Identidad y perfil tributario del tercero (módulo tax)
  person_type:    z.enum(['NATURAL', 'JURIDICA']).default('NATURAL'),
  tax_profile_id: z.string().uuid().nullable().optional(),
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
  // Facturación: día de inicio (1 o 15) y modo (vencido = mes anterior /
  // anticipado = mes actual). Ver participations.domain.billedPeriods.
  billing_day:        z.union([z.literal(1), z.literal(15)]).default(1),
  billing_mode:       z.enum(['vencido', 'anticipado']).default('vencido'),
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

export const applyManualPaymentSchema = z.object({
  comprobante: z.string().min(1, 'El comprobante es obligatorio'),
  client_nit:  z.string().min(1, 'El NIT del cliente es obligatorio'),
  allocations: z.array(z.object({
    invoice_id: z.string().uuid('ID de factura inválido'),
    amount:     z.number().positive('El monto debe ser positivo'),
  })).min(1, 'Debe asignar al menos una factura'),
})

export const updateInvoiceParticipationSchema = z.object({
  // Etapa 2: Venta
  finto_invoice:             z.string().trim().nullable().optional(),
  finto_invoice_date:        z.string().trim().nullable().optional(),
  finto_invoice_value:       z.number().min(0).optional(),
  // Etapa 3: Recaudo
  cash_receipts:             z.string().trim().nullable().optional(),
  cash_receipt_date:         z.string().trim().nullable().optional(),
  collected:                 z.number().min(0).optional(),
  // Etapa 4: Factura de compra tercero + OP
  third_party_invoice:       z.string().trim().nullable().optional(),
  third_party_invoice_date:  z.string().trim().nullable().optional(),
  third_party_invoice_value: z.number().min(0).nullable().optional(),
  payment_order:             z.string().trim().nullable().optional(),
  // Etapa 5: Pago al tercero (RP)
  egress_voucher:            z.string().trim().nullable().optional(),
  egress_voucher_date:       z.string().trim().nullable().optional(),
  egress_voucher_value:      z.number().min(0).nullable().optional(),
})

export const reallocatePaymentSchema = z.object({
  from_invoice_id: z.string().uuid('ID de factura origen inválido'),
  to_invoice_id:   z.string().uuid('ID de factura destino inválido'),
  amount:          z.number().positive('El monto a transferir debe ser positivo'),
  comprobante:     z.string().trim().optional(),
})

export const unlinkPaymentSchema = z.object({
  invoice_id:  z.string().uuid('ID de factura inválido'),
  amount:      z.number().positive('El monto a desvincular debe ser positivo'),
  comprobante: z.string().trim().min(1, 'El comprobante es obligatorio'),
})

export const unlinkSaleInvoiceSchema = z.object({
  invoice_id:      z.string().uuid('ID de factura inválido'),
  unlink_receipts: z.boolean().default(false),
})

