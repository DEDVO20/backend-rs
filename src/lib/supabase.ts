import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL             = process.env.SUPABASE_URL!
const SUPABASE_ANON_KEY        = process.env.SUPABASE_ANON_KEY!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Faltan variables de entorno de Supabase')
}

// Cliente con service_role — para operaciones internas del backend.
// NUNCA exponer al frontend ni incluir en respuestas.
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Cliente público — solo para validar JWTs de usuarios en el middleware de auth.
export const supabasePublic = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
