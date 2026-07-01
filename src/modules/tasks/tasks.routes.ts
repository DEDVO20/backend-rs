import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule } from '../../middleware/requireRole.js'
import { requireRole } from '../../middleware/requireRole.js'
import { TasksService } from './tasks.service.js'
import {
  listTasksQuerySchema,
  updateTaskSchema,
  createTaskSchema,
  generateTasksSchema,
} from './tasks.schema.js'

const INTERNAL_ROLES = ['admin', 'rs_admin', 'rs_staff'] as const

const app = new Hono()

app.use('/*', authMiddleware, requireModule('tasks'))

// GET /api/tasks
app.get('/',
  zValidator('query', listTasksQuerySchema),
  async (c) => {
    const { role, companyId } = c.get('user')
    const isInternal = (INTERNAL_ROLES as readonly string[]).includes(role)
    const result = await TasksService.list(c.req.valid('query'), companyId, isInternal)
    return c.json(result)
  },
)

// ── Task Templates — MUST be before /:id to avoid route collision ──────────
import { supabase } from '../../lib/supabase.js'

const templateSchema = z.object({
  service_id:         z.string().uuid(),
  title:              z.string().min(3),
  description:        z.string().optional(),
  frequency:          z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semestral', 'annual']),
  due_day:            z.number().int().min(1).max(31).optional(),
  create_day:         z.number().int().min(1).max(31).optional(),
  owner_type:         z.enum(['rs_team', 'client']).default('rs_team'),
  requires_document:  z.boolean().default(false),
  active:             z.boolean().default(true),
})

app.get('/templates',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const { frequency, owner_type, requires_document, active, service_id } = c.req.query()

    let q = supabase
      .from('task_templates')
      .select('*, services(name)')
      .order('frequency')
      .order('title')

    if (frequency)          q = q.eq('frequency', frequency)
    if (owner_type)         q = q.eq('owner_type', owner_type)
    if (service_id)         q = q.eq('service_id', service_id)
    if (requires_document !== undefined) q = q.eq('requires_document', requires_document === 'true')
    if (active !== undefined)            q = q.eq('active', active === 'true')

    const { data, error } = await q
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  },
)

app.post('/templates',
  requireRole('admin', 'rs_admin'),
  zValidator('json', templateSchema),
  async (c) => {
    const { data, error } = await supabase
      .from('task_templates')
      .insert(c.req.valid('json'))
      .select('*, services(name)')
      .single()
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data, 201)
  },
)

app.patch('/templates/:id',
  requireRole('admin', 'rs_admin'),
  zValidator('json', templateSchema.partial()),
  async (c) => {
    const { data, error } = await supabase
      .from('task_templates')
      .update(c.req.valid('json'))
      .eq('id', c.req.param('id')!)
      .select('*, services(name)')
      .single()
    if (error) return c.json({ error: error.message }, 500)
    return c.json(data)
  },
)

app.delete('/templates/:id',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const { error } = await supabase
      .from('task_templates')
      .delete()
      .eq('id', c.req.param('id')!)
    if (error) return c.json({ error: error.message }, 500)
    return c.json({ ok: true })
  },
)

// GET /api/tasks/cron-logs — historial de ejecuciones del cron
app.get('/cron-logs',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const { data, error } = await supabase
      .from('cron_logs')
      .select('*')
      .order('executed_at', { ascending: false })
      .limit(100)
    if (error) throw error
    return c.json(data)
  },
)

// GET /api/tasks/:id
app.get('/:id', async (c) => {
  const data = await TasksService.getById(c.req.param('id')!)
  return c.json(data)
})

// POST /api/tasks — solo roles internos
app.post('/',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createTaskSchema),
  async (c) => {
    const data = await TasksService.create(c.req.valid('json'))
    return c.json(data, 201)
  },
)

// PATCH /api/tasks/:id — estado y documento adjunto
app.patch('/:id',
  zValidator('json', updateTaskSchema),
  async (c) => {
    const { role } = c.get('user')
    const body = c.req.valid('json')
    const isInternal = (INTERNAL_ROLES as readonly string[]).includes(role)

    // Clientes solo pueden cambiar status y document_id
    if (!isInternal && Object.keys(body).some(k => k !== 'status' && k !== 'document_id')) {
      return c.json({ error: 'Acceso denegado' }, 403)
    }

    // Validar quién puede completar según owner_type
    if (body.status === 'done') {
      const task = await TasksService.getById(c.req.param('id')!)
      if (task.owner_type === 'client' && isInternal) {
        return c.json({ error: 'Esta tarea debe ser completada por el cliente' }, 403)
      }
      if (task.owner_type === 'rs_team' && !isInternal) {
        return c.json({ error: 'Esta tarea debe ser completada por el equipo Finto' }, 403)
      }
    }

    const data = await TasksService.update(c.req.param('id')!, body)
    return c.json(data)
  },
)

// DELETE /api/tasks/:id — solo roles internos
app.delete('/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const { supabase } = await import('../../lib/supabase.js')
    const { error } = await supabase.from('tasks').delete().eq('id', c.req.param('id')!)
    if (error) throw error
    return c.json({ ok: true })
  },
)

// POST /api/tasks/generate — genera tareas periódicas
app.post('/generate',
  requireRole('admin', 'rs_admin'),
  zValidator('json', generateTasksSchema),
  async (c) => {
    const start = Date.now()
    const body  = c.req.valid('json')
    try {
      const result = await TasksService.generateTasks(body)
      await supabase.from('cron_logs').insert({
        job_name:    'generate-tasks-manual',
        status:      'success',
        result:      { ...result, ...body },
        duration_ms: Date.now() - start,
      })
      return c.json(result, 201)
    } catch (err) {
      await supabase.from('cron_logs').insert({
        job_name:    'generate-tasks-manual',
        status:      'failed',
        result:      {},
        error:       err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - start,
      })
      throw err
    }
  },
)

// POST /api/tasks/reminders — dispara recordatorios de tareas con vencimiento mañana
app.post('/reminders',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const start = Date.now()
    const count = await TasksService.sendReminders()
    await supabase.from('cron_logs').insert({
      job_name:    'send-reminders-manual',
      status:      'success',
      result:      { sent: count },
      duration_ms: Date.now() - start,
    })
    return c.json({ sent: count })
  },
)

// POST /api/tasks/mark-overdue — marca tareas como vencidas manualmente
app.post('/mark-overdue',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    const count = await TasksService.markOverdue()
    return c.json({ marked_overdue: count })
  },
)

export const tasksRoutes = app
