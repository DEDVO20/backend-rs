import type { Context, Next } from 'hono'

// Rate limiter en memoria — suficiente para empezar.
// En producción con múltiples instancias, migrar a Redis.
const counters = new Map<string, { count: number; resetAt: number }>()

type Options = {
  windowMs:  number   // ventana de tiempo en ms
  max:       number   // máximo de requests por ventana
  keyPrefix?: string  // prefijo para separar contadores por ruta
}

function getIp(c: Context) {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? c.req.header('x-real-ip')
    ?? 'unknown'
}

export function rateLimiter(opts: Options) {
  const { windowMs, max, keyPrefix = '' } = opts

  return async (c: Context, next: Next) => {
    const key = `${keyPrefix}:${getIp(c)}`
    const now = Date.now()

    let entry = counters.get(key)

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      counters.set(key, entry)
    }

    entry.count++

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      c.header('Retry-After', String(retryAfter))
      return c.json(
        { error: 'Demasiadas solicitudes — intenta más tarde', retryAfter },
        429,
      )
    }

    await next()
  }
}

// Limpiar entradas expiradas cada 5 minutos
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of counters.entries()) {
    if (now > entry.resetAt) counters.delete(key)
  }
}, 5 * 60 * 1000)
