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

// GET /api/participations/invoice-check?type=finto|third&number=F-001&exclude=<monthlyId>
// Alerta de factura ya registrada. Informativo: nunca bloquea el guardado.
app.get('/invoice-check', async (c) => {
  const type   = c.req.query('type') === 'third' ? 'third_party_invoice' : 'finto_invoice'
  const number = c.req.query('number') ?? ''
  if (!number.trim()) return c.json({ duplicate: null })

  const duplicate = await ParticipationsService.findDuplicateInvoice(type, number, c.req.query('exclude'))
  return c.json({ duplicate })
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

// ── Conciliación con reportes de SIIGO (lado CxC) ────────────────────────────
// multipart: file_sales (Ventas), file_receipts (Recibos), year, month, apply
app.post('/reconcile-siigo',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('multipart/form-data')) {
      return c.json({ error: 'Se requiere multipart/form-data con file_sales y file_receipts' }, 400)
    }
    const form  = await c.req.formData()
    const sales = form.get('file_sales')
    const rcs   = form.get('file_receipts')
    const year  = Number(form.get('year'))
    const month = Number(form.get('month'))
    const apply = String(form.get('apply') ?? '') === 'true'

    if (!(sales instanceof File) || !(rcs instanceof File))
      return c.json({ error: 'Faltan los archivos file_sales y file_receipts' }, 400)
    if (!year || !month)
      return c.json({ error: 'year y month son requeridos' }, 400)

    const { read, utils } = await import('xlsx')
    const readRows = async (f: File): Promise<string[][]> => {
      // CSV: leer como texto UTF-8 (evita mojibake en encabezados con tilde);
      // Excel: leer el binario tal cual.
      const isCsv = (f.name ?? '').toLowerCase().endsWith('.csv')
      const wb = isCsv
        ? read(await f.text(), { type: 'string' })
        : read(await f.arrayBuffer(), { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]!]!
      return utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' })
    }

    let salesRows: string[][], receiptRows: string[][]
    try {
      salesRows   = await readRows(sales)
      receiptRows = await readRows(rcs)
    } catch {
      return c.json({ error: 'No se pudieron leer los archivos Excel' }, 400)
    }

    const user = c.get('user')
    const result = await ParticipationsService.reconcileSiigo({ year, month, salesRows, receiptRows, apply, userId: user.id })
    if (apply) {
      auditAsync({ action: 'update', resource: 'monthly_participations', metadata: { source: 'siigo', year, month, applied: result.summary.applied }, user, c })
    }
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
