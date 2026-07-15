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
  RS_TEAM_EMAIL:             z.string().email(),
  PLATFORM_URL:              z.string().url(),
  REDIS_URL:                 z.string().url(),
  PORT:                      z.coerce.number().int().positive().default(3000),
  NODE_ENV:                  z.enum(['development', 'production', 'test']).default('development'),
})

const result = envSchema.safeParse(process.env)

if (!result.success) {
  const missing = result.error.errors.map(e => `  • ${e.path.join('.')}: ${e.message}`)
  console.error('❌ Variables de entorno inválidas o faltantes:\n' + missing.join('\n'))
  process.exit(1)
}

export const env = result.data
