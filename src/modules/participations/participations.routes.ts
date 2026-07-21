import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requireRole } from '../../middleware/requireRole.js'
import { supabase }   from '../../lib/supabase.js'
import { auditAsync } from '../../lib/audit.js'
import { ParticipationsService } from './participations.service.js'
import {
  thirdPartySchema, updateThirdPartySchema,
  upsertParticipationSchema, invoicingSchema, generateParticipationsSchema,
} from './participations.schema.js'

const app = new Hono()

// admin, rs_admin y contador (MODULE_PERMISSIONS.participations)
app.use('/*', authMiddleware, requireModule('participations'))

// ── Terceros ─────────────────────────────────────────────────────────────────

app.get('/third-parties', async (c) => {
  const data = await ParticipationsService.listThirdParties()
  return c.json(data)
})

app.post('/third-parties',
  zValidator('json', thirdPartySchema),
  async (c) => {
    const user = c.get('user')
    const data = await ParticipationsService.createThirdParty(c.req.valid('json'))
    auditAsync({ action: 'create', resource: 'third_parties', resource_id: data.id, metadata: { name: data.name }, user, c })
    return c.json(data, 201)
  },
)

app.patch('/third-parties/:id',
  zValidator('json', updateThirdPartySchema),
  async (c) => {
    const data = await ParticipationsService.updateThirdParty(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// ── Configuración por servicio (perfil del cliente) ──────────────────────────

app.get('/company/:companyId', async (c) => {
  const data = await ParticipationsService.listCompanyParticipations(c.req.param('companyId')!)
  return c.json(data)
})

app.put('/config',
  zValidator('json', upsertParticipationSchema),
  async (c) => {
    const user = c.get('user')
    const data = await ParticipationsService.upsertParticipation(c.req.valid('json'))
    auditAsync({ action: 'update', resource: 'service_participations', resource_id: c.req.valid('json').company_service_id, metadata: { has_third_party: c.req.valid('json').has_third_party }, user, c })
    return c.json(data)
  },
)

// ── Participaciones mensuales ─────────────────────────────────────────────────

app.get('/monthly', async (c) => {
  const q = c.req.query()
  const data = await ParticipationsService.listMonthly({
    year:   q.year ? Number(q.year) : undefined,
    month:  q.month ? Number(q.month) : undefined,
    status: q.status || undefined,
    page:   Math.max(1, Number(q.page ?? 1) || 1),
    limit:  Math.min(Math.max(1, Number(q.limit ?? 20) || 20), 100),
  })
  return c.json(data)
})

app.patch('/monthly/:id/invoicing',
  zValidator('json', invoicingSchema),
  async (c) => {
    const user = c.get('user')
    const result = await ParticipationsService.upsertInvoicing(c.req.param('id')!, c.req.valid('json'), user.id)
    auditAsync({ action: 'update', resource: 'participation_invoicing', resource_id: c.req.param('id')!, metadata: { status: result.status }, user, c })
    return c.json(result)
  },
)

// ── Estadísticas ──────────────────────────────────────────────────────────────

app.get('/stats', async (c) => {
  const q = c.req.query()
  const data = await ParticipationsService.stats(
    q.year ? Number(q.year) : undefined,
    q.month ? Number(q.month) : undefined,
  )
  return c.json(data)
})

// ── Generación manual (cron a demanda) ────────────────────────────────────────

app.post('/generate',
  requireRole('admin', 'rs_admin'),
  zValidator('json', generateParticipationsSchema),
  async (c) => {
    const start = Date.now()
    const body  = c.req.valid('json')
    try {
      const result = await ParticipationsService.generateMonthly(body)
      await supabase.from('cron_logs').insert({
        job_name:    'participations-generate-manual',
        status:      'success',
        result,
        duration_ms: Date.now() - start,
      })
      return c.json(result, 201)
    } catch (err) {
      await supabase.from('cron_logs').insert({
        job_name:    'participations-generate-manual',
        status:      'failed',
        result:      {},
        error:       err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      })
      throw err
    }
  },
)

export const participationsRoutes = app
