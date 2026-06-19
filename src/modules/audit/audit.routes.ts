import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { supabase }       from '../../lib/supabase.js'
import { paginationSchema, paginationRange, paginatedResponse } from '../../lib/paginate.js'

const app = new Hono()

app.use('/*', authMiddleware, requireRole('admin', 'rs_admin'))

const listAuditSchema = paginationSchema.extend({
  user_id:    z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  resource:   z.string().optional(),
  action:     z.string().optional(),
  from:       z.string().datetime().optional(),
  to:         z.string().datetime().optional(),
})

// GET /api/audit — listar eventos de audit log
app.get('/',
  zValidator('query', listAuditSchema),
  async (c) => {
    const { user_id, company_id, resource, action, from, to, page, limit } = c.req.valid('query')
    const { from: rangeFrom, to: rangeTo } = paginationRange(page, limit)

    let q = supabase
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(rangeFrom, rangeTo)

    if (user_id)    q = q.eq('user_id', user_id)
    if (company_id) q = q.eq('company_id', company_id)
    if (resource)   q = q.eq('resource', resource)
    if (action)     q = q.eq('action', action)
    if (from)       q = q.gte('created_at', from)
    if (to)         q = q.lte('created_at', to)

    const { data, error, count } = await q
    if (error) throw error
    return c.json(paginatedResponse(data ?? [], count ?? 0, page, limit))
  },
)

// GET /api/audit/resources — recursos únicos para filtros de UI
app.get('/resources', async (c) => {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('resource')
    .order('resource')
    .limit(200)

  if (error) throw error

  const unique = [...new Set((data ?? []).map((r: any) => r.resource))]
  return c.json(unique)
})

export const auditRoutes = app
