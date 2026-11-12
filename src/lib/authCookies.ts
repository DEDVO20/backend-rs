import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'

// Los tokens de sesión viajan SOLO en cookies httpOnly: el JavaScript del
// navegador no puede leerlos (mitiga robo de sesión por XSS).
export const ACCESS_COOKIE  = 'rs_at'
export const REFRESH_COOKIE = 'rs_rt'

const isProd = process.env.NODE_ENV === 'production'

// Lax si frontend y API comparten sitio (app.x.com + api.x.com, o proxy en Vercel).
// None si están en sitios distintos (exige Secure; algunos navegadores bloquean
// cookies de terceros, por eso se recomienda mismo sitio).
function sameSite(): 'Lax' | 'Strict' | 'None' {
  const v = (process.env.COOKIE_SAMESITE ?? 'Lax').toLowerCase()
  if (v === 'none')   return 'None'
  if (v === 'strict') return 'Strict'
  return 'Lax'
}

function baseOptions(): CookieOptions {
  const ss = sameSite()
  return {
    httpOnly: true,
    secure:   isProd || ss === 'None',
    sameSite: ss,
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  }
}

// El refresh token solo se envía a /auth (refresh y logout), nunca a /api/*
const REFRESH_PATH = '/auth'
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30 // 30 días

export function setAuthCookies(
  c: Context,
  session: { access_token: string; refresh_token: string; expires_in?: number },
) {
  const opts = baseOptions()
  setCookie(c, ACCESS_COOKIE, session.access_token, {
    ...opts,
    path:   '/',
    maxAge: session.expires_in ?? 3600,
  })
  setCookie(c, REFRESH_COOKIE, session.refresh_token, {
    ...opts,
    path:   REFRESH_PATH,
    maxAge: REFRESH_MAX_AGE,
  })
}

export function clearAuthCookies(c: Context) {
  const opts = baseOptions()
  deleteCookie(c, ACCESS_COOKIE,  { ...opts, path: '/' })
  deleteCookie(c, REFRESH_COOKIE, { ...opts, path: REFRESH_PATH })
}

/** Token de acceso: cookie httpOnly; se acepta Bearer para clientes de API (curl, scripts). */
export function readAccessToken(c: Context): string | undefined {
  const fromCookie = getCookie(c, ACCESS_COOKIE)
  if (fromCookie) return fromCookie
  const header = c.req.header('Authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined
  return undefined
}

export function readRefreshToken(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE)
}
