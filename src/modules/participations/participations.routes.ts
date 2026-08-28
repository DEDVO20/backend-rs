import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requireRole, requirePermission } from '../../middleware/requireRole.js'
import { auditAsync } from '../../lib/audit.js'
import { ParticipationsService } from './participations.service.js'
import {
  thirdPartySchema, updateThirdPartySchema,
  upsertParticipationSchema,
  thirdPartyInvoiceSchema, egressSchema,
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
  requirePermission('participations', 'create'),
  zValidator('json', thirdPartySchema),
  async (c) => {
    const user = c.get('user')
    const data = await ParticipationsService.createThirdParty(c.req.valid('json'))
    auditAsync({ action: 'create', resource: 'third_parties', resource_id: data.id, metadata: { name: data.name }, user, c })
    return c.json(data, 201)
  },
)

app.patch('/third-parties/:id',
  requirePermission('participations', 'update'),
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
  requirePermission('participations', 'update'),
  zValidator('json', upsertParticipationSchema),
  async (c) => {
    const user = c.get('user')
    const data = await ParticipationsService.upsertParticipation(c.req.valid('json'))
    auditAsync({ action: 'update', resource: 'service_participations', resource_id: c.req.valid('json').company_service_id, metadata: { has_third_party: c.req.valid('json').has_third_party }, user, c })
    return c.json(data)
  },
)

// ── Participaciones por factura ──────────────────────────────────────────────

// GET /api/participations/invoices — participaciones por factura
app.get('/invoices', async (c) => {
  const q = c.req.query()
  const data = await ParticipationsService.listInvoiceParticipations({
    status:     q.status || undefined,
    company_id: q.company_id || undefined,
    period:     q.period || undefined,
    year:       q.year || undefined,
    from:       q.from || undefined,
    to:         q.to || undefined,
    page:  Math.max(1, Number(q.page ?? 1) || 1),
    limit: Math.min(Math.max(1, Number(q.limit ?? 20) || 20), 100),
  })
  return c.json(data)
})

// GET /api/participations/invoice-stats
app.get('/invoice-stats', async (c) => {
  const data = await ParticipationsService.invoiceStats({
    company_id: c.req.query('company_id') || undefined,
    period:     c.req.query('period') || undefined,
    year:       c.req.query('year') || undefined,
    from:       c.req.query('from') || undefined,
    to:         c.req.query('to') || undefined,
  })
  return c.json(data)
})

// GET /api/participations/balances — panel de saldos: CxC (nos deben) y CxP
// (debemos, por tercero). Filtros opcionales: ?period=YYYY-MM&company_id=
app.get('/balances', async (c) => {
  const data = await ParticipationsService.balances({
    period:     c.req.query('period') || undefined,
    company_id: c.req.query('company_id') || undefined,
    year:       c.req.query('year') || undefined,
    from:       c.req.query('from') || undefined,
    to:         c.req.query('to') || undefined,
  })
  return c.json(data)
})

// GET /api/participations/conciliation — vista maestra (una fila por OC con las
// 5 etapas). Filtros opcionales: ?period=YYYY-MM&company_id=
app.get('/conciliation', async (c) => {
  const data = await ParticipationsService.conciliation({
    period:     c.req.query('period') || undefined,
    company_id: c.req.query('company_id') || undefined,
    year:       c.req.query('year') || undefined,
    from:       c.req.query('from') || undefined,
    to:         c.req.query('to') || undefined,
  })
  return c.json(data)
})

// GET /api/participations/conciliation/export — descarga la conciliación en Excel
app.get('/conciliation/export', async (c) => {
  const period = c.req.query('period') || undefined
  const year = c.req.query('year') || undefined
  const from = c.req.query('from') || undefined
  const to = c.req.query('to') || undefined
  const rows = await ParticipationsService.conciliation({
    period, year, from, to,
    company_id: c.req.query('company_id') || undefined,
  })

  const header = [
    'Mes', 'Cliente', 'NIT cliente', 'Venta', 'OC', 'Tercero', 'NIT tercero', 'Participación',
    '# F venta', '$ F venta', 'RC', '$ Recaudo',
    '# F compra', '$ F compra', 'RP', '$ Pago', 'Estado',
  ]
  const aoa: (string | number)[][] = [header, ...rows.map((r: any) => [
    r.mes ?? '', r.cliente ?? '', r.nit_cliente ?? '', r.venta ?? 0, r.oc ?? '', r.tercero ?? '', r.nit_tercero ?? '', r.participacion ?? 0,
    r.f_venta ?? '', r.f_venta_valor ?? 0, r.rc ?? '', r.recaudo ?? 0,
    r.f_compra ?? '', r.f_compra_valor ?? 0, r.rp ?? '', r.pago ?? 0, r.estado ?? '',
  ])]

  const { utils, write } = await import('xlsx')
  const ws = utils.aoa_to_sheet(aoa)
  const wb = utils.book_new()
  utils.book_append_sheet(wb, ws, 'Conciliación')
  const buf = write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const body = new Uint8Array(buf)

  const fname = `conciliacion${period ? '-' + period : ''}.xlsx`
  return c.body(body, 200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${fname}"`,
  })
})

// PATCH /api/participations/invoices/:id/third-party — factura del tercero (+OP)
app.patch('/invoices/:id/third-party',
  requireRole('admin', 'rs_admin', 'contador'),
  requirePermission('participations', 'update'),
  zValidator('json', thirdPartyInvoiceSchema),
  async (c) => {
    const user = c.get('user')
    const result = await ParticipationsService.registerThirdPartyInvoice(c.req.param('id')!, c.req.valid('json'))
    auditAsync({ action: 'update', resource: 'invoice_participations', resource_id: c.req.param('id')!, metadata: { third_party_invoice: c.req.valid('json').third_party_invoice, payment_order: result.payment_order }, user, c })
    return c.json(result)
  },
)

// PATCH /api/participations/invoices/:id/egress — comprobante de egreso (pago)
app.patch('/invoices/:id/egress',
  requireRole('admin', 'rs_admin', 'contador'),
  requirePermission('participations', 'update'),
  zValidator('json', egressSchema),
  async (c) => {
    const user = c.get('user')
    const result = await ParticipationsService.registerEgress(c.req.param('id')!, c.req.valid('json'))
    auditAsync({ action: 'update', resource: 'invoice_participations', resource_id: c.req.param('id')!, metadata: { egress_voucher: c.req.valid('json').egress_voucher }, user, c })
    return c.json(result)
  },
)

// POST /api/participations/process-siigo — crea participaciones por factura y
// aplica el recaudo. multipart: file_sales, file_receipts, apply
app.post('/process-siigo',
  requireRole('admin', 'rs_admin'),
  requirePermission('participations', 'create'),
  async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('multipart/form-data'))
      return c.json({ error: 'Se requiere multipart/form-data con file_sales y file_receipts' }, 400)

    const form  = await c.req.formData()
    const sales = form.get('file_sales')
    const rcs   = form.get('file_receipts')
    const apply = String(form.get('apply') ?? '') === 'true'
    if (!(sales instanceof File) || !(rcs instanceof File))
      return c.json({ error: 'Faltan los archivos file_sales y file_receipts' }, 400)

    const { read, utils } = await import('xlsx')
    const readRows = async (f: File): Promise<string[][]> => {
      const isCsv = (f.name ?? '').toLowerCase().endsWith('.csv')
      const wb = isCsv ? read(await f.text(), { type: 'string' }) : read(await f.arrayBuffer(), { type: 'array' })
      return utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: '' })
    }

    let salesRows: string[][], receiptRows: string[][]
    try {
      salesRows   = await readRows(sales)
      receiptRows = await readRows(rcs)
    } catch {
      return c.json({ error: 'No se pudieron leer los archivos' }, 400)
    }

    const user = c.get('user')
    const result = await ParticipationsService.processSiigo({ salesRows, receiptRows, apply })
    if (apply) auditAsync({ action: 'update', resource: 'invoice_participations', metadata: { source: 'siigo', ...result.summary }, user, c })
    return c.json(result)
  },
)

// POST /api/participations/import-egresos — importa pagos (RP) desde el reporte
// "Movimiento por cuenta contable". multipart: file, apply
app.post('/import-egresos',
  requireRole('admin', 'rs_admin', 'contador'),
  requirePermission('participations', 'update'),
  async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('multipart/form-data'))
      return c.json({ error: 'Se requiere multipart/form-data con el campo "file"' }, 400)
    const form  = await c.req.formData()
    const file  = form.get('file')
    const apply = String(form.get('apply') ?? '') === 'true'
    if (!(file instanceof File)) return c.json({ error: 'Falta el archivo' }, 400)

    const { read, utils } = await import('xlsx')
    let rows: string[][]
    try {
      const isCsv = (file.name ?? '').toLowerCase().endsWith('.csv')
      const wb = isCsv ? read(await file.text(), { type: 'string' }) : read(await file.arrayBuffer(), { type: 'array' })
      rows = utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: '' })
    } catch {
      return c.json({ error: 'No se pudo leer el archivo' }, 400)
    }

    const user = c.get('user')
    const result = await ParticipationsService.importEgresos(rows, apply)
    if (apply) auditAsync({ action: 'update', resource: 'invoice_participations', metadata: { source: 'siigo-egresos', ...result.summary }, user, c })
    return c.json(result)
  },
)

// POST /api/participations/import-purchases — importa facturas de compra (del
// tercero) y las concilia por OC (+OP). multipart: file, apply
app.post('/import-purchases',
  requireRole('admin', 'rs_admin', 'contador'),
  requirePermission('participations', 'update'),
  async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('multipart/form-data'))
      return c.json({ error: 'Se requiere multipart/form-data con el campo "file"' }, 400)
    const form  = await c.req.formData()
    const file  = form.get('file')
    const apply = String(form.get('apply') ?? '') === 'true'
    if (!(file instanceof File)) return c.json({ error: 'Falta el archivo' }, 400)

    const { read, utils } = await import('xlsx')
    let rows: string[][]
    try {
      const isCsv = (file.name ?? '').toLowerCase().endsWith('.csv')
      const wb = isCsv ? read(await file.text(), { type: 'string' }) : read(await file.arrayBuffer(), { type: 'array' })
      rows = utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: '' })
    } catch {
      return c.json({ error: 'No se pudo leer el archivo' }, 400)
    }

    const user = c.get('user')
    const result = await ParticipationsService.importPurchases(rows, apply)
    if (apply) auditAsync({ action: 'update', resource: 'invoice_participations', metadata: { source: 'siigo-compras', ...result.summary }, user, c })
    return c.json(result)
  },
)

// POST /api/participations/import-consolidado — importa el reporte consolidado
// (un solo archivo): ventas + recaudo + pagos al tercero ya cruzados. Reemplaza
// la necesidad de subir varios archivos. multipart: file, apply
app.post('/import-consolidado',
  requireRole('admin', 'rs_admin', 'contador'),
  requirePermission('participations', 'update'),
  async (c) => {
    const ct = c.req.header('content-type') ?? ''
    if (!ct.includes('multipart/form-data'))
      return c.json({ error: 'Se requiere multipart/form-data con el campo "file"' }, 400)
    const form  = await c.req.formData()
    const file  = form.get('file')
    const apply = String(form.get('apply') ?? '') === 'true'
    if (!(file instanceof File)) return c.json({ error: 'Falta el archivo' }, 400)

    const { read, utils } = await import('xlsx')
    let rows: string[][]
    try {
      const isCsv = (file.name ?? '').toLowerCase().endsWith('.csv')
      // raw:true en CSV conserva el texto original (fechas ISO y montos en formato
      // colombiano "$1.234,56"); si no, el lector coacciona algunas celdas y rompe
      // el parseo. En xlsx los valores ya vienen tipados (parseColombianNumber y
      // toISODate manejan number/serial).
      const wb = isCsv ? read(await file.text(), { type: 'string', raw: true }) : read(await file.arrayBuffer(), { type: 'array' })
      rows = utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: '' })
    } catch {
      return c.json({ error: 'No se pudo leer el archivo' }, 400)
    }

    const user = c.get('user')
    const result = await ParticipationsService.importConsolidated(rows, apply)
    if (apply) auditAsync({ action: 'update', resource: 'invoice_participations', metadata: { source: 'siigo-consolidado', ...result.summary }, user, c })
    return c.json(result)
  },
)

// POST /api/participations/generate-monthly — genera la OC del mes para cada
// servicio contratado con tercero. Body opcional: { period: "YYYY-MM" }.
app.post('/generate-monthly',
  requireRole('admin', 'rs_admin'),
  requirePermission('participations', 'create'),
  async (c) => {
    let period: string | undefined
    try {
      const body = await c.req.json<{ period?: string }>()
      period = body?.period
    } catch { /* sin body → periodo actual */ }
    const user = c.get('user')
    const result = await ParticipationsService.generateMonthlyOCs(period)
    auditAsync({ action: 'create', resource: 'invoice_participations', metadata: { source: 'monthly-oc', period: result.period, created: result.created }, user, c })
    return c.json(result)
  },
)

export const participationsRoutes = app
