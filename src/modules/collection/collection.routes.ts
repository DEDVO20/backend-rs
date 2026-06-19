import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule }  from '../../middleware/requireRole.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { CollectionService } from './collection.service.js'
import {
  listDebtorsQuerySchema,
  updateDebtorSchema,
  createActionSchema,
  createAgreementSchema,
  createCampaignSchema,
  listActionsQuerySchema,
  createDebtorSchema,
  createDebtSchema,
  createTemplateSchema,
  createCollectionTaskSchema,
  updateCollectionTaskSchema,
  listMessagesQuerySchema,
} from './collection.schema.js'
import { z } from 'zod'

const STAFF_ROLES = ['admin', 'rs_admin', 'rs_staff'] as const

const app = new Hono()

app.use('/*', authMiddleware, requireModule('collection'))

// ── Diagnóstico temporal ───────────────────────────────────────────────────
app.get('/debug', async (c) => {
  const { supabase } = await import('../../lib/supabase.js')
  const user = c.get('user')

  // Simular exactamente lo que hace listDebtors
  const { data, error, count } = await supabase
    .from('collection_debtors')
    .select('*, collection_debts(outstanding_amount,overdue_1_30,overdue_31_60,overdue_61_90,overdue_91_plus,not_yet_due,total_balance,currency,due_date,siigo_document)', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(0, 19)

  return c.json({
    user_role: user.role,
    user_company_id: user.companyId,
    count,
    error: error?.message,
    error_details: error?.details,
    error_hint: error?.hint,
    sample: data?.slice(0, 3),
  })
})

// ── Stats ──────────────────────────────────────────────────────────────────

app.get('/stats', async (c) => {
  const { role, companyId: userCompanyId } = c.get('user')
  const queryCompanyId = c.req.query('company_id')
  const isStaff = ['admin','rs_admin','rs_staff'].includes(role)

  let companyId: string | null
  if (isStaff) {
    companyId = queryCompanyId ?? null
  } else {
    companyId = queryCompanyId ?? userCompanyId
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
  }

  const result = await CollectionService.getStats(companyId)
  return c.json(result)
})

// ── Debtors ────────────────────────────────────────────────────────────────

app.get('/debtors',
  zValidator('query', listDebtorsQuerySchema),
  async (c) => {
    const { role, companyId: userCompanyId } = c.get('user')
    const query = c.req.valid('query')
    const isStaff = ['admin','rs_admin','rs_staff'].includes(role)

    let companyId: string | null
    if (isStaff) {
      // Staff ve todas las empresas; solo filtra si seleccionó una en el dropdown
      companyId = query.company_id ?? null
    } else {
      // Cliente solo ve su propia empresa
      companyId = query.company_id ?? userCompanyId
      if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    }

    const result = await CollectionService.listDebtors(query, companyId)
    return c.json(result)
  },
)

app.get('/debtors/:id', async (c) => {
  const data = await CollectionService.getDebtor(c.req.param('id')!)
  return c.json(data)
})

app.patch('/debtors/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', updateDebtorSchema),
  async (c) => {
    const data = await CollectionService.updateDebtor(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// ── Actions ────────────────────────────────────────────────────────────────

app.get('/actions',
  zValidator('query', listActionsQuerySchema),
  async (c) => {
    const { companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const result = await CollectionService.listActions(c.req.valid('query'), companyId)
    return c.json(result)
  },
)

app.post('/actions',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createActionSchema),
  async (c) => {
    const { id, companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createAction(c.req.valid('json'), id, companyId)
    return c.json(data, 201)
  },
)

// ── Agreements ─────────────────────────────────────────────────────────────

app.get('/debtors/:id/agreements', async (c) => {
  const data = await CollectionService.listAgreements(c.req.param('id')!)
  return c.json(data)
})

app.post('/agreements',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createAgreementSchema),
  async (c) => {
    const { id, companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createAgreement(c.req.valid('json'), companyId, id)
    return c.json(data, 201)
  },
)

// ── Campaigns ──────────────────────────────────────────────────────────────

app.get('/campaigns', async (c) => {
  const { companyId } = c.get('user')
  if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
  const data = await CollectionService.listCampaigns(companyId)
  return c.json(data)
})

app.post('/campaigns',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createCampaignSchema),
  async (c) => {
    const { id, companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const input    = c.req.valid('json')
    const campaign = await CollectionService.createCampaign(input, companyId, id)
    // Enviar inmediatamente si viene con deudores y mensaje
    if ((input.debtor_ids?.length ?? 0) > 0 && input.message_template) {
      const result = await CollectionService.sendCampaign(campaign.id)
      return c.json({ ...campaign, sent: result.sent }, 201)
    }
    return c.json(campaign, 201)
  },
)

// POST /api/collection/campaigns/:id/send — disparo masivo
app.post('/campaigns/:id/send',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const data = await CollectionService.sendCampaign(c.req.param('id')!)
    return c.json(data)
  },
)

// ── Debtors — CSV import ──────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim()); cur = ''
    } else { cur += ch }
  }
  result.push(cur.trim())
  return result
}

function parseMoney(v: string): number {
  if (!v) return 0
  const clean = v.replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.')
  return parseFloat(clean) || 0
}

function mapSiigoRow(raw: Record<string, string>): Record<string, string> {
  if (!('Cliente identificacion' in raw)) return raw
  const rango = (raw['Rango vencimiento'] ?? '').trim()
  const saldo = parseMoney(raw['Saldo actual COP'] ?? raw['Saldo actual'] ?? '')
  const total = parseMoney(raw['Total factura original'] ?? '')
  const overdue: Record<string, string> = {
    overdue_1_30: '0', overdue_31_60: '0', overdue_61_90: '0', overdue_91_plus: '0', not_yet_due: '0',
  }
  if      (rango === '1-30')       overdue['overdue_1_30']    = String(saldo)
  else if (rango === '31-60')      overdue['overdue_31_60']   = String(saldo)
  else if (rango === '61-90')      overdue['overdue_61_90']   = String(saldo)
  else if (rango === '91+')        overdue['overdue_91_plus'] = String(saldo)
  else if (rango === 'No vencido') overdue['not_yet_due']     = String(saldo)
  return {
    debtor_document:    (raw['Cliente identificacion'] ?? '').trim(),
    debtor_name:        (raw['Cliente nombre'] ?? '').trim(),
    seller:             (raw['Nombre vendedor'] ?? '').trim(),
    siigo_document:     (raw['Numero'] ?? '').trim(),
    due_date:           (raw['Fecha factura'] ?? '').trim(),
    currency:           (raw['Moneda'] ?? 'COP').trim(),
    total_balance:      String(total),
    outstanding_amount: String(saldo),
    ...overdue,
  }
}

app.post('/debtors/import',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const { id: createdBy, companyId: userCompanyId } = c.get('user')

    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Se requiere multipart/form-data con un campo "file" CSV' }, 400)
    }

    const formData   = await c.req.formData()
    const file       = formData.get('file')
    const bodyCompId = formData.get('company_id')
    const companyId  = (typeof bodyCompId === 'string' && bodyCompId) ? bodyCompId : userCompanyId
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)

    if (!file || typeof file === 'string') {
      return c.json({ error: 'Campo "file" requerido' }, 400)
    }

    const text = await (file as File).text()
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')

    if (lines.length < 2) {
      return c.json({ error: 'El CSV debe tener al menos una fila de datos además del encabezado' }, 400)
    }

    const headers = parseCsvLine(lines[0]!)

    const rows: Array<Record<string, string>> = []
    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]!)
      const raw: Record<string, string> = {}
      headers.forEach((h, idx) => { raw[h] = values[idx] ?? '' })
      rows.push(mapSiigoRow(raw))
    }

    const result = await CollectionService.importDebtors(rows, companyId, createdBy)
    return c.json(result, result.errors.length > 0 ? 207 : 200)
  },
)

// ── Debtors — crear / importar ─────────────────────────────────────────────

app.post('/debtors',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createDebtorSchema),
  async (c) => {
    const { companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createDebtor(c.req.valid('json'), companyId)
    return c.json(data, 201)
  },
)

// POST /api/collection/debtors/:id/debts — agregar deuda a un deudor
app.post('/debtors/:id/debts',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createDebtSchema),
  async (c) => {
    const { companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createDebt(
      { ...c.req.valid('json'), debtor_id: c.req.param('id')! },
      companyId,
    )
    return c.json(data, 201)
  },
)

// ── Templates ──────────────────────────────────────────────────────────────

app.get('/templates', async (c) => {
  const { companyId } = c.get('user')
  if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
  const data = await CollectionService.listTemplates(companyId)
  return c.json(data)
})

app.post('/templates',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createTemplateSchema),
  async (c) => {
    const { companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createTemplate(c.req.valid('json'), companyId)
    return c.json(data, 201)
  },
)

app.patch('/templates/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createTemplateSchema.partial()),
  async (c) => {
    const data = await CollectionService.updateTemplate(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

app.delete('/templates/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const data = await CollectionService.deleteTemplate(c.req.param('id')!)
    return c.json(data)
  },
)

// ── Collection Tasks ────────────────────────────────────────────────────────

app.get('/tasks',
  zValidator('query', z.object({
    debtor_id: z.string().uuid().optional(),
    page:  z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
  })),
  async (c) => {
    const { companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.listCollectionTasks(companyId, c.req.valid('query'))
    return c.json(data)
  },
)

app.post('/tasks',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createCollectionTaskSchema),
  async (c) => {
    const { companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createCollectionTask(c.req.valid('json'), companyId)
    return c.json(data, 201)
  },
)

app.patch('/tasks/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', updateCollectionTaskSchema),
  async (c) => {
    const data = await CollectionService.updateCollectionTask(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// ── Inbound Messages ────────────────────────────────────────────────────────

app.get('/messages',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('query', listMessagesQuerySchema),
  async (c) => {
    const data = await CollectionService.listMessages(c.req.valid('query'))
    return c.json(data)
  },
)

app.patch('/messages/:id/read',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const data = await CollectionService.markMessageRead(c.req.param('id')!)
    return c.json(data)
  },
)

export const collectionRoutes = app
