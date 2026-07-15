import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requireRole } from '../../middleware/requireRole.js'
import { supabase }   from '../../lib/supabase.js'
import { auditAsync } from '../../lib/audit.js'
import { AccountingService } from './accounting.service.js'
import { masterItemSchema, updateMasterItemSchema, updateEntrySchema } from './accounting.schema.js'

const app = new Hono()

// Solo admin, rs_admin y contador (MODULE_PERMISSIONS.accounting)
app.use('/*', authMiddleware, requireModule('accounting'))

// ── Plantilla maestra (modificación solo Super Admin) ────────────────────────

// GET /api/accounting/master
app.get('/master', async (c) => {
  const data = await AccountingService.listMaster()
  return c.json(data)
})

// POST /api/accounting/master — agrega tarea y la propaga a todas las fichas
app.post('/master',
  requireRole('admin'),
  zValidator('json', masterItemSchema),
  async (c) => {
    const user = c.get('user')
    const data = await AccountingService.createMaster(c.req.valid('json'))
    auditAsync({ action: 'create', resource: 'tax_calendar_master', resource_id: data.id, metadata: { title: data.title, is_mandatory: data.is_mandatory, propagated_to: data.propagated_to }, user, c })
    return c.json(data, 201)
  },
)

// PATCH /api/accounting/master/:id
app.patch('/master/:id',
  requireRole('admin'),
  zValidator('json', updateMasterItemSchema),
  async (c) => {
    const user = c.get('user')
    const data = await AccountingService.updateMaster(c.req.param('id')!, c.req.valid('json'))
    auditAsync({ action: 'update', resource: 'tax_calendar_master', resource_id: data.id, metadata: c.req.valid('json'), user, c })
    return c.json(data)
  },
)

// DELETE /api/accounting/master/:id — elimina también las entradas en las fichas
app.delete('/master/:id',
  requireRole('admin'),
  async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')!
    const result = await AccountingService.deleteMaster(id)
    auditAsync({ action: 'delete', resource: 'tax_calendar_master', resource_id: id, metadata: result, user, c })
    return c.json({ ok: true, ...result })
  },
)

// ── Fichas y calendarios por empresa ─────────────────────────────────────────

// GET /api/accounting/companies — análisis: estado del calendario por empresa
app.get('/companies', async (c) => {
  const data = await AccountingService.getCompanies()
  return c.json(data)
})

// GET /api/accounting/companies/:companyId — calendario de una empresa
app.get('/companies/:companyId', async (c) => {
  const data = await AccountingService.getCompanyCalendar(c.req.param('companyId')!)
  return c.json(data)
})

// PATCH /api/accounting/entries/:id — modificar fecha/notas de una entrada
app.patch('/entries/:id',
  zValidator('json', updateEntrySchema),
  async (c) => {
    const user = c.get('user')
    const data = await AccountingService.updateEntry(c.req.param('id')!, c.req.valid('json'), user.id)
    auditAsync({ action: 'update', resource: 'company_tax_entries', resource_id: data.id, metadata: { company_id: data.company_id, due_date: data.due_date, title: data.master?.title }, user, c })
    return c.json(data)
  },
)

// ── Estadísticas del dashboard ────────────────────────────────────────────────

// GET /api/accounting/stats
app.get('/stats', async (c) => {
  const data = await AccountingService.stats()
  return c.json(data)
})

// ── Operaciones administrativas ───────────────────────────────────────────────

// POST /api/accounting/backfill — genera fichas para empresas existentes con contabilidad
app.post('/backfill',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const result = await AccountingService.backfill()
    return c.json(result)
  },
)

// POST /api/accounting/run-cron — disparo manual del cron de calendario tributario
app.post('/run-cron',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const start = Date.now()
    try {
      const result = await AccountingService.generateTaxTasks()
      await supabase.from('cron_logs').insert({
        job_name:    'tax-calendar-tasks-manual',
        status:      'success',
        result,
        duration_ms: Date.now() - start,
      })
      return c.json(result)
    } catch (err) {
      await supabase.from('cron_logs').insert({
        job_name:    'tax-calendar-tasks-manual',
        status:      'failed',
        result:      {},
        error:       err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      })
      throw err
    }
  },
)

export const accountingRoutes = app
