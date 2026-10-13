import { supabase } from '../lib/supabase.js'
import { logger }   from '../lib/logger.js'

export type EmailProvider = 'zavu' | 'resend'

export type EmailSettings = {
  provider: EmailProvider
  bcc:      string[]
}

// "a@x.com, b@x.com" → ['a@x.com', 'b@x.com']
function parseList(value?: string): string[] {
  return (value ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/** Valores del entorno — se usan mientras no se haya guardado nada desde la plataforma */
function envDefaults(): EmailSettings {
  return {
    provider: process.env.EMAIL_PROVIDER?.trim().toLowerCase() === 'resend' ? 'resend' : 'zavu',
    bcc:      parseList(process.env.EMAIL_BCC),
  }
}

/** ¿Están las credenciales de Resend en el entorno? */
export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM)
}

// ── Capa cacheada sobre la base de datos (tabla email_settings, fila id=1) ────
const CACHE_TTL = 60_000
let cache: { value: EmailSettings; expires: number } | null = null

export function invalidateEmailSettings(): void {
  cache = null
}

export async function getEmailSettings(): Promise<EmailSettings> {
  if (cache && cache.expires > Date.now()) return cache.value

  let value = envDefaults()
  try {
    const { data, error } = await supabase
      .from('email_settings')
      .select('provider, bcc')
      .eq('id', 1)
      .maybeSingle()

    if (error) throw error
    if (data) {
      value = {
        provider: data.provider === 'resend' ? 'resend' : 'zavu',
        bcc:      Array.isArray(data.bcc) ? data.bcc : [],
      }
    }
  } catch (err) {
    // Un fallo leyendo el ajuste no debe tumbar el envío — se usa el entorno
    logger.warn({ err: err instanceof Error ? err.message : err }, 'No se pudo leer email_settings — usando variables de entorno')
  }

  cache = { value, expires: Date.now() + CACHE_TTL }
  return value
}

export async function saveEmailSettings(settings: EmailSettings, userId: string): Promise<EmailSettings> {
  const { error } = await supabase
    .from('email_settings')
    .upsert({
      id:         1,
      provider:   settings.provider,
      bcc:        settings.bcc,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    })

  if (error) throw error
  invalidateEmailSettings()
  return settings
}
