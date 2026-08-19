import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule }  from '../../middleware/requireRole.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { supabase } from '../../lib/supabase.js'
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

  const socio = c.req.query('socio') || null
  const result = await CollectionService.getStats(companyId, socio)
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

// Socios distintos para el filtro de cartera (debe ir antes de /debtors/:id)
app.get('/debtors/socios', async (c) => {
  const { role, companyId: userCompanyId } = c.get('user')
  const isStaff = ['admin', 'rs_admin', 'rs_staff'].includes(role)
  const companyId = isStaff ? (c.req.query('company_id') ?? null) : (c.req.query('company_id') ?? userCompanyId ?? null)
  const data = await CollectionService.listSocios(companyId)
  return c.json(data)
})

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
    const { companyId, role } = c.get('user')
    const isStaff = ['admin','rs_admin','rs_staff'].includes(role)
    // Staff can filter by debtor_id without a session companyId
    const effectiveCompanyId = companyId ?? (isStaff ? null : null)
    if (!effectiveCompanyId && !isStaff) return c.json({ error: 'Sin empresa' }, 400)
    if (!effectiveCompanyId) {
      // Staff: fetch actions directly filtered by debtor_id (no company restriction)
      const { debtor_id, page, limit } = c.req.valid('query')
      const from = ((page ?? 1) - 1) * (limit ?? 50)
      let q = supabase
        .from('collection_actions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + (limit ?? 50) - 1)
      if (debtor_id) q = q.eq('debtor_id', debtor_id)
      const { data, error, count } = await q
      if (error) return c.json({ error: error.message }, 500)
      return c.json({ data, total: count ?? 0, page: page ?? 1, limit: limit ?? 50 })
    }
    const result = await CollectionService.listActions(c.req.valid('query'), effectiveCompanyId)
    return c.json(result)
  },
)

app.post('/actions',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createActionSchema),
  async (c) => {
    const { id, companyId: sessionCompanyId } = c.get('user')
    const input = c.req.valid('json')
    // Derive companyId from the debtor when the staff user has no company in session
    let companyId = sessionCompanyId
    if (!companyId) {
      const { data: debtor } = await supabase
        .from('collection_debtors').select('company_id').eq('id', input.debtor_id).single()
      companyId = debtor?.company_id ?? null
    }
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createAction(input, id, companyId)
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
    const { id, companyId: sessionCompanyId } = c.get('user')
    const input = c.req.valid('json')
    // Derive companyId from the debtor when staff user has no company in session
    let companyId = sessionCompanyId
    if (!companyId) {
      const { data: debtor } = await supabase
        .from('collection_debtors').select('company_id').eq('id', input.debtor_id).single()
      companyId = debtor?.company_id ?? null
    }
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createAgreement(input, companyId, id)
    return c.json(data, 201)
  },
)

// ── Campaigns ──────────────────────────────────────────────────────────────

app.get('/campaigns', async (c) => {
  const { companyId, role } = c.get('user')
  const isStaff = ['admin', 'rs_admin', 'rs_staff'].includes(role)
  if (!companyId && !isStaff) return c.json({ error: 'Sin empresa' }, 400)

  const page  = Math.max(1, Number(c.req.query('page') ?? 1) || 1)
  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 10) || 10), 100)
  // Staff puede filtrar el historial por empresa
  const queryCompany = isStaff ? (c.req.query('company_id') || null) : null

  const data = await CollectionService.listCampaigns(companyId ?? queryCompany, page, limit)
  return c.json(data)
})

app.post('/campaigns',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createCampaignSchema),
  async (c) => {
    const { id, companyId: sessionCompanyId } = c.get('user')
    const input = c.req.valid('json')
    // Staff users have no companyId in session → accept it from the request body
    const companyId = sessionCompanyId ?? input.company_id ?? null
    if (!companyId) return c.json({ error: 'Sin empresa: selecciona una empresa en el filtro antes de enviar' }, 400)
    const campaign = await CollectionService.createCampaign(input, companyId, id)
    // Enviar en background — responder inmediatamente para evitar timeout/502
    if ((input.debtor_ids?.length ?? 0) > 0 && input.message_template) {
      const { logger } = await import('../../lib/logger.js')
      void CollectionService.sendCampaign(campaign.id)
        .then(r => logger.info({ campaignId: campaign.id, sent: r.sent }, 'Campaña enviada'))
        .catch(err => logger.error({ campaignId: campaign.id, err: err instanceof Error ? err.message : String(err) }, 'Error enviando campaña'))
    }
    return c.json({ ...campaign, sending: true }, 201)
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

/**
 * Monto que puede venir en dos formatos:
 *  - JS/plano con punto decimal:  "5199569.78"
 *  - colombiano con coma decimal: "$ 5.199.569,78"
 * Si trae coma, la coma es el decimal; si no, el punto lo es.
 */
function parseAmount(v: string): number {
  if (!v) return 0
  let s = v.replace(/[$\s]/g, '')
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  return parseFloat(s) || 0
}

// Rangos que NO son cartera por cobrar (pagos sin aplicar / saldos a favor):
// se ignoran en el import (no crean deudores).
const SKIP_RANGES = new Set(['Saldo a favor', 'Ingresos por identificar'])

/**
 * Formato SIIGO nuevo (pivote): [Identificacion,] Cliente, Socio, Creación,
 * Factura, Rango, Moneda, Suma de Total factura, Suma de Cuenta13_COP.
 * Si el reporte trae 'Identificacion' (NIT) se usa como clave del deudor;
 * si no, se cae al nombre del cliente. Devuelve null para filas a ignorar.
 */
function mapSiigoRowNew(raw: Record<string, string>): Record<string, string> | null {
  const rango = (raw['Rango'] ?? '').trim()
  if (SKIP_RANGES.has(rango)) return null

  const name = (raw['Cliente'] ?? '').trim()
  if (!name) return null

  // NIT si el reporte lo trae (con o sin tilde en el encabezado)
  const nit = (raw['Identificacion'] ?? raw['Identificación'] ?? '').trim()

  const saldo = parseAmount(raw['Suma de Cuenta13_COP'] ?? '')
  const total = parseAmount(raw['Suma de Total factura'] ?? '')

  const overdue: Record<string, string> = {
    overdue_1_30: '0', overdue_31_60: '0', overdue_61_90: '0', overdue_91_plus: '0', not_yet_due: '0',
  }
  if      (rango === '1-30')                          overdue['overdue_1_30']    = String(saldo)
  else if (rango === '31-60')                         overdue['overdue_31_60']   = String(saldo)
  else if (rango === '61-90')                         overdue['overdue_61_90']   = String(saldo)
  else if (rango === '>90' || rango === '91+')        overdue['overdue_91_plus'] = String(saldo)
  else if (rango === 'Por vencer' || rango === 'No vencido') overdue['not_yet_due'] = String(saldo)

  return {
    debtor_document:    nit || name,   // preferir NIT; si no viene, el nombre
    debtor_name:        name,
    socio:              (raw['Socio'] ?? '').trim(),
    seller:             '',
    siigo_document:     (raw['Factura'] ?? '').trim(),
    due_date:           parseSiigoDate(raw['Creación'] ?? raw['Creacion'] ?? '') || '',
    currency:           (raw['Moneda'] ?? 'COP').trim(),
    total_balance:      String(total),
    outstanding_amount: String(saldo),
    ...overdue,
  }
}

// Fecha en texto español: "16 jul 2026", "30 sept 2025" → yyyy-mm-dd
const MESES_ES: Record<string, string> = {
  ene: '01', feb: '02', mar: '03', abr: '04', may: '05', jun: '06',
  jul: '07', ago: '08', sep: '09', oct: '10', nov: '11', dic: '12',
}
function parseSpanishDate(val: string): string | null {
  if (!val) return null
  const m = val.trim().toLowerCase().match(/^(\d{1,2})\s+([a-záéíóú.]+)\s+(\d{4})$/)
  if (!m) return null
  const mm = MESES_ES[m[2]!.replace('.', '').slice(0, 3)]
  if (!mm) return null
  return `${m[3]}-${mm}-${m[1]!.padStart(2, '0')}`
}

// Rango de mora a partir del número de días vencidos
function bucketFromDays(days: number): string | null {
  if (days <= 0)  return 'not_yet_due'
  if (days <= 30) return 'overdue_1_30'
  if (days <= 60) return 'overdue_31_60'
  if (days <= 90) return 'overdue_61_90'
  return 'overdue_91_plus'
}

/**
 * Formato "Dashboard WIP": Cliente identificacion, Cliente nombre, Fecha
 * factura, Nombre factura, Dias vencidos, Balance original.
 * El tramo se calcula desde 'Dias vencidos' y la fecha viene en español.
 */
function mapSiigoRowWip(raw: Record<string, string>): Record<string, string> | null {
  const nit  = (raw['Cliente identificacion'] ?? '').trim()
  const name = (raw['Cliente nombre'] ?? '').trim()
  if (!nit && !name) return null

  const saldo = parseAmount(raw['Balance original'] ?? '')
  const days  = parseInt(String(raw['Dias vencidos'] ?? '').replace(/[^\d-]/g, ''), 10) || 0

  const overdue: Record<string, string> = {
    overdue_1_30: '0', overdue_31_60: '0', overdue_61_90: '0', overdue_91_plus: '0', not_yet_due: '0',
  }
  const bucket = bucketFromDays(days)
  if (bucket) overdue[bucket] = String(saldo)

  return {
    debtor_document:    nit || name,   // preferir NIT; si no viniera, el nombre
    debtor_name:        name,
    seller:             '',
    siigo_document:     (raw['Nombre factura'] ?? '').trim(),
    due_date:           parseSpanishDate(raw['Fecha factura'] ?? '') || '',
    currency:           'COP',
    total_balance:      String(saldo),
    outstanding_amount: String(saldo),
    ...overdue,
  }
}

function parseSiigoDate(val: string): string | null {
  if (!val) return null
  const clean = val.trim()
  
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return clean
  }
  
  const match = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (match) {
    const day = match[1]!.padStart(2, '0')
    const month = match[2]!.padStart(2, '0')
    const year = match[3]!
    return `${year}-${month}-${day}`
  }
  
  try {
    const d = new Date(clean)
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0]!
    }
  } catch {
    // Ignorar y retornar null
  }
  
  return null
}

function mapSiigoRow(raw: Record<string, string>): Record<string, string> {
  if (!('Cliente identificacion' in raw || 'Cliente ide' in raw)) return raw
  const rango = (raw['Rango vencimiento'] ?? raw['Rango ven'] ?? raw['Rango ver'] ?? '').trim()
  const saldo = parseMoney(raw['Saldo actual COP'] ?? raw['Saldo actual'] ?? raw['Saldo actu'] ?? '')
  const total = parseMoney(raw['Total facturas'] ?? raw['Total factura original'] ?? raw['Total factura'] ?? raw['Total'] ?? raw['Total fact'] ?? '')
  const overdue: Record<string, string> = {
    overdue_1_30: '0', overdue_31_60: '0', overdue_61_90: '0', overdue_91_plus: '0', not_yet_due: '0',
  }
  if      (rango === '1-30')       overdue['overdue_1_30']    = String(saldo)
  else if (rango === '31-60')      overdue['overdue_31_60']   = String(saldo)
  else if (rango === '61-90')      overdue['overdue_61_90']   = String(saldo)
  else if (rango === '91+')        overdue['overdue_91_plus'] = String(saldo)
  else if (rango === 'No vencido') overdue['not_yet_due']     = String(saldo)
  return {
    debtor_document:    (raw['Cliente identificacion'] ?? raw['Cliente ide'] ?? '').trim(),
    debtor_name:        (raw['Cliente nombre'] ?? '').trim(),
    seller:             (raw['Nombre vendedor'] ?? '').trim(),
    siigo_document:     (raw['Numero'] ?? '').trim(),
    due_date:           parseSiigoDate(raw['Fecha factura'] ?? raw['Fecha fact'] ?? '') || '',
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
    const accept = c.req.header('accept') ?? ''
    const useSSE = accept.includes('text/event-stream')

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
    // Cada formato se detecta por una columna que lo delata; así se ramifica
    // sin afectar a los otros:
    //   'Dias vencidos'     → Dashboard WIP (mapSiigoRowWip)
    //   'Rango'             → pivote nuevo   (mapSiigoRowNew)
    //   'Rango vencimiento' → formato viejo  (mapSiigoRow)
    const mapper = headers.includes('Dias vencidos') ? mapSiigoRowWip
                 : headers.includes('Rango')         ? mapSiigoRowNew
                 :                                      mapSiigoRow

    const rows: Array<Record<string, string>> = []
    let ignored = 0
    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]!)
      const raw: Record<string, string> = {}
      headers.forEach((h, idx) => { raw[h] = values[idx] ?? '' })
      const mapped = mapper(raw)
      if (mapped) rows.push(mapped)
      else ignored++
    }

    // SSE: stream progress
    if (useSSE) {
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (data: Record<string, unknown>) => {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`))
            }

            send({ type: 'progress', progress: 0, message: `Iniciando importación de ${rows.length} registros...` })

            const result = await CollectionService.importDebtors(rows, companyId, createdBy, (pct, msg) => {
              send({ type: 'progress', progress: pct, message: msg })
            })

            send({ type: 'progress', progress: 100, message: '¡Importación completada!' })
            send({ type: 'done', ...result, ignored })
            controller.close()
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        },
      )
    }

    // Fallback JSON normal
    const result = await CollectionService.importDebtors(rows, companyId, createdBy)
    return c.json({ ...result, ignored }, result.errors.length > 0 ? 207 : 200)
  },
)

// ── Contacts — Excel/CSV import (update phone/email on existing debtors) ──────
// Columnas: A=Empresa, B=NIT, C=Celular, D=Email tesorería, E=Teléfono

app.post('/contacts/import',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Se requiere multipart/form-data con un campo "file"' }, 400)
    }

    const formData = await c.req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return c.json({ error: 'Campo "file" requerido' }, 400)
    }

    const fileName = (file as File).name ?? ''
    const isCsv = fileName.toLowerCase().endsWith('.csv')

    // Parse file: xlsx can handle both .xlsx and .csv natively
    const buffer = await (file as File).arrayBuffer()
    let rows: string[][]

    try {
      const { read, utils } = await import('xlsx')
      const wb = read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]!]!
      rows = utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' })
    } catch {
      return c.json({ error: `No se pudo leer el archivo ${isCsv ? 'CSV' : 'Excel'}` }, 400)
    }

    if (rows.length < 2) {
      return c.json({ error: 'El archivo debe tener al menos una fila de datos' }, 400)
    }

    // Nueva estructura de columnas:
    // A (0) = Empresa, B (1) = NIT, C (2) = Celular, D (3) = Email tesorería, E (4) = Teléfono
    const dataRows = rows.slice(1).filter(r => String(r[1] ?? '').trim() !== '') // NIT en col B

    let updated = 0
    let notFound = 0
    const errors: string[] = []

    for (const row of dataRows) {
      const nit      = String(row[1] ?? '').trim().replace(/\D/g, '') // col B — NIT
      const celular  = String(row[2] ?? '').trim().replace(/\D/g, '') // col C — Celular
      const email    = String(row[3] ?? '').trim()                     // col D — Email tesorería
      const telefono = String(row[4] ?? '').trim().replace(/\D/g, '') // col E — Teléfono fijo

      if (!nit) continue

      const updateData: Record<string, string> = {}
      if (celular && /^3\d{9}$/.test(celular)) {
        updateData.phone    = celular
        updateData.whatsapp = celular
      } else if (celular) {
        updateData.phone = celular
      }
      if (email && email.includes('@')) updateData.email = email
      if (telefono) updateData.phone_alt = telefono

      if (Object.keys(updateData).length === 0) continue

      // Actualizar todos los deudores con este NIT
      const { data: matched, error } = await supabase
        .from('collection_debtors')
        .update(updateData)
        .eq('debtor_document', nit)
        .select('id')

      if (error) {
        errors.push(`NIT ${nit}: ${error.message}`)
        continue
      }

      if (matched && matched.length > 0) {
        updated += matched.length
      } else {
        notFound++
      }
    }

    return c.json({
      total: dataRows.length,
      updated,
      notFound,
      errors,
    })
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
  const { companyId, role } = c.get('user')
  const isStaff = ['admin', 'rs_admin', 'rs_staff'].includes(role)

  // Staff puede filtrar por empresa (?company_id=) para ver sus plantillas
  // personalizadas + las globales; sin filtro ve todas (panel de administración)
  const queryCompany = c.req.query('company_id') || null
  const effectiveCompany = isStaff ? queryCompany : companyId

  const localTemplates = await CollectionService.listTemplates(effectiveCompany)

  // Traer plantillas de Zavu en paralelo
  let zavuTemplates: any[] = []
  try {
    const res = await fetch('https://api.zavu.dev/v1/templates?limit=100', {
      headers: { 'Authorization': `Bearer ${process.env.ZAVU_API_KEY}` },
    })
    if (res.ok) {
      const json = await res.json() as { items: any[] }
      zavuTemplates = (json.items ?? [])
        .filter((t: any) => t.status === 'approved')
        .map((t: any) => ({
          id:         `zavu_${t.id}`,
          name:       t.name?.replace(/_/g, ' ') ?? t.id,
          channel:    'whatsapp',
          body:       t.body ?? t.whatsappBody ?? '',
          is_active:  true,
          is_global:  true,
          source:     'zavu',
          zavu_id:    t.id,
          category:   t.category,
          language:   t.language,
          variables:  t.variables ?? [],
          buttons:    t.buttons ?? [],
          status:     t.whatsapp?.status ?? t.status,
        }))
    }
  } catch {}

  return c.json([...localTemplates, ...zavuTemplates])
})

app.post('/templates',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createTemplateSchema),
  async (c) => {
    const { companyId } = c.get('user')
    const input = c.req.valid('json')
    // Staff elige la empresa en el body; vacío = plantilla global
    const targetCompany = input.company_id ?? companyId ?? null
    const data = await CollectionService.createTemplate(input, targetCompany)
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
    const { companyId: sessionCompanyId } = c.get('user')
    const input = c.req.valid('json')
    // Derive companyId from debtor when staff user has no company in session
    let companyId = sessionCompanyId
    if (!companyId && input.debtor_id) {
      const { data: debtor } = await supabase
        .from('collection_debtors').select('company_id').eq('id', input.debtor_id).single()
      companyId = debtor?.company_id ?? null
    }
    if (!companyId) return c.json({ error: 'Sin empresa' }, 400)
    const data = await CollectionService.createCollectionTask(input, companyId)
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
