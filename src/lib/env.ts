import { z } from 'zod'

const envSchema = z.object({
  SUPABASE_URL:              z.string().url(),
  SUPABASE_ANON_KEY:         z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
  ZAVU_API_KEY:              z.string().min(1),
  ZAVU_WEBHOOK_SECRET:       z.string().min(1),
  // Plantilla de WhatsApp aprobada por Meta para campañas de cobranza
  // (fuera de la ventana de 24h solo se pueden enviar plantillas)
  ZAVU_WA_TEMPLATE_ID:       z.string().optional(),
  // Proveedor de email: 'zavu' (por defecto) o 'resend'. SMS y WhatsApp siempre van por Zavu.
  // Es el valor inicial: lo guardado en Configuración (tabla email_settings) tiene prioridad
  EMAIL_PROVIDER:            z.enum(['zavu', 'resend']).default('zavu'),
  RESEND_API_KEY:            z.string().optional(),
  // Remitente verificado en Resend, ej: "Finto <notificaciones@tudominio.com>"
  RESEND_FROM:               z.string().optional(),
  // Copias ocultas globales separadas por coma (solo con Resend)
  EMAIL_BCC:                 z.string().optional(),
  RS_TEAM_EMAIL:             z.string().email(),
  PLATFORM_URL:              z.string().url(),
  REDIS_URL:                 z.string().url(),
  PORT:                      z.coerce.number().int().positive().default(3000),
  NODE_ENV:                  z.enum(['development', 'production', 'test']).default('development'),
  // Integración API Siigo (Consultas de ventas / facturación)
  SIIGO_USERNAME:            z.string().optional(),
  SIIGO_ACCESS_KEY:          z.string().optional(),
  SIIGO_PARTNER_ID:          z.string().default('RSHUBS'),
  SELLER_ID_FILTER:          z.string().optional(),
  START_YEAR:                z.coerce.number().int().default(2025),
  SIIGO_SYNC_OVERLAP_DAYS:   z.coerce.number().int().min(0).default(5),
  SIIGO_COLLECTIONS_START_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  SLEEP_BETWEEN_DOCS_MS:     z.coerce.number().int().default(400),
  SLEEP_BETWEEN_PRODUCT_LOOKUPS_MS: z.coerce.number().int().default(250),
}).superRefine((v, ctx) => {
  if (v.EMAIL_PROVIDER !== 'resend') return
  for (const key of ['RESEND_API_KEY', 'RESEND_FROM'] as const) {
    if (!v[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Requerido cuando EMAIL_PROVIDER=resend' })
  }
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  const missing = result.error.errors.map(e => `  • ${e.path.join('.')}: ${e.message}`)
  console.error('❌ Variables de entorno inválidas o faltantes:\n' + missing.join('\n'))
  process.exit(1)
}

export const env = result.data
