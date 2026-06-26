import './lib/env.js'   // valida env vars antes de iniciar — falla rápido si falta alguna
import { serve }          from '@hono/node-server'
import { Hono }           from 'hono'
import { cors }           from 'hono/cors'
import { secureHeaders }  from 'hono/secure-headers'
import { logger }  from './lib/logger.js'
import { rateLimiter }       from './middleware/rateLimiter.js'
import { auditMiddleware }   from './middleware/auditMiddleware.js'
import { startNotificationWorker } from './notifications/queue/notificationQueue.js'
import { startTaskScheduler }     from './cron/taskScheduler.js'
import { supabase }          from './lib/supabase.js'
import { redis }             from './lib/redis.js'
import { zavuWebhook }       from './webhooks/zavu.webhook.js'

import { authRoutes }          from './modules/auth/auth.routes.js'
import { docsRoutes }          from './modules/docs/docs.routes.js'
import { invitationsRoutes }   from './modules/invitations/invitations.routes.js'
import { onboardingRoutes }    from './modules/onboarding/onboarding.routes.js'
import { servicesRoutes }        from './modules/services/services.routes.js'
import { policiesRoutes }        from './modules/policies/policies.routes.js'
import { requestTypesRoutes }    from './modules/request-types/request-types.routes.js'
import { profilesRoutes }        from './modules/profiles/profiles.routes.js'
import { dashboardsRoutes }      from './modules/dashboards/dashboards.routes.js'
import { companyServicesRoutes } from './modules/company-services/company-services.routes.js'
import { companiesRoutes }  from './modules/companies/companies.routes.js'
import { tasksRoutes }      from './modules/tasks/tasks.routes.js'
import { requestsRoutes }   from './modules/operational-requests/requests.routes.js'
import { collectionRoutes } from './modules/collection/collection.routes.js'
import { documentsRoutes }  from './modules/documents/documents.routes.js'
import { auditRoutes }      from './modules/audit/audit.routes.js'

const app = new Hono()

// ── Security headers ──────────────────────────────────────────────────────────
app.use('*', secureHeaders())

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map(o => o.trim())

app.use('*', cors({
  origin:       (origin) => allowedOrigins.includes(origin) ? origin : null,
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length'],
  maxAge:       600,
  credentials:  true,
}))

// ── Health check (público) ────────────────────────────────────────────────────
app.get('/health', async (c) => {
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {}

  // Supabase
  const t0 = Date.now()
  try {
    const { error } = await supabase.from('profiles').select('id').limit(1)
    checks.supabase = { ok: !error, latencyMs: Date.now() - t0, ...(error ? { error: error.message } : {}) }
  } catch (e: any) {
    checks.supabase = { ok: false, latencyMs: Date.now() - t0, error: e.message }
  }

  // Redis
  const t1 = Date.now()
  try {
    const pong = await redis.ping()
    checks.redis = { ok: pong === 'PONG', latencyMs: Date.now() - t1 }
  } catch (e: any) {
    checks.redis = { ok: false, latencyMs: Date.now() - t1, error: e.message }
  }

  const allOk  = Object.values(checks).every(c => c.ok)
  const status = allOk ? 200 : 503

  return c.json({ status: allOk ? 'ok' : 'degraded', ts: new Date().toISOString(), checks }, status)
})

// ── Docs (público — spec JSON + Scalar UI) ───────────────────────────────────
app.route('/', docsRoutes)

// ── Webhook Zavu (público — valida su propia firma) ───────────────────────────
app.route('/webhooks/zavu', zavuWebhook)

// ── Autenticación ─────────────────────────────────────────────────────────────
app.route('/auth', authRoutes)

// ── Invitaciones (públicas — no requieren JWT) ────────────────────────────────
app.route('/invitations', invitationsRoutes)
app.route('/auth/invitations', invitationsRoutes)

// ── Rutas protegidas — rate limiter + audit log ───────────────────────────────
app.use('/api/*', rateLimiter({ windowMs: 60_000, max: 100 }))
app.use('/api/*', auditMiddleware)

app.route('/api/onboarding',     onboardingRoutes)
app.route('/api/services',       servicesRoutes)
app.route('/api/policies',       policiesRoutes)
app.route('/api/request-types',    requestTypesRoutes)
app.route('/api/profiles',         profilesRoutes)
app.route('/api/dashboards',       dashboardsRoutes)
app.route('/api/company-services', companyServicesRoutes)
app.route('/api/companies',   companiesRoutes)
app.route('/api/tasks',       tasksRoutes)
app.route('/api/requests',    requestsRoutes)
app.route('/api/collection',  collectionRoutes)
app.route('/api/documents',   documentsRoutes)
app.route('/api/audit',       auditRoutes)

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Ruta no encontrada' }, 404))

// ── Error handler ─────────────────────────────────────────────────────────────────────────
app.onError((err, c) => {
  const statusCode = (err as any).statusCode ?? 500

  // Hono's onError creates a fresh response that bypasses the CORS middleware.
  // We must re-inject CORS headers manually so the browser can read the error body.
  const origin = c.req.header('origin') ?? ''
  if (allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Access-Control-Allow-Credentials', 'true')
    c.header('Vary', 'Origin')
  }

  if (statusCode < 500) {
    return c.json({ error: err.message }, statusCode)
  }
  logger.error({ err: err.message, path: c.req.path }, 'Error no manejado')
  const message = process.env.NODE_ENV === 'production'
    ? 'Error interno del servidor'
    : err.message
  return c.json({ error: message }, 500)
})

// ── Iniciar servidor ──────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3000)

const worker = startNotificationWorker()
const cronWorker = startTaskScheduler()

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  logger.info(`Servidor corriendo en http://localhost:${PORT}`)
})

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`${signal} recibido — cerrando servidor...`)

  await worker.close()
  await cronWorker.close()
  logger.info('Workers cerrados')

  await redis.quit()
  logger.info('Redis desconectado')

  server.close(() => {
    logger.info('Servidor HTTP cerrado')
    process.exit(0)
  })

  // Forzar salida si tarda más de 10 s
  setTimeout(() => {
    logger.error('Shutdown forzado por timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })

export default app
