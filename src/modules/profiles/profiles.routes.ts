import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireRole } from '../../middleware/requireRole.js'
import { supabase } from '../../lib/supabase.js'
import { paginationSchema, paginationRange, paginatedResponse } from '../../lib/paginate.js'

const app = new Hono()

app.use('/*', authMiddleware)

const updateProfileSchema = z.object({
  full_name: z.string().min(2).optional(),
  email: z.string().email().optional(),
})

const updateProfileAdminSchema = updateProfileSchema.extend({
  role: z.enum(['admin', 'rs_admin', 'rs_staff', 'contador', 'client_owner', 'client_user']).optional(),
  active: z.boolean().optional(),
  company_id: z.string().uuid().nullable().optional(),
})

// GET /api/profiles/me — perfil del usuario autenticado
app.get('/me', async (c) => {
  const { id } = c.get('user')

  const { data, error } = await supabase
    .from('profiles')
    .select('*, companies(id, name, status)')
    .eq('id', id)
    .single()

  if (error) throw error
  return c.json(data)
})

// PATCH /api/profiles/me — actualizar propio perfil
app.patch('/me',
  zValidator('json', updateProfileSchema),
  async (c) => {
    const { id } = c.get('user')

    const { data, error } = await supabase
      .from('profiles')
      .update(c.req.valid('json'))
      .eq('id', id)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

const listProfilesSchema = paginationSchema.extend({
  company_id: z.string().uuid().optional(),
  role: z.string().optional(),
  active: z.string().optional(),
})

// GET /api/profiles — listar todos (admin/rs_admin)
app.get('/',
  requireRole('admin', 'rs_admin'),
  zValidator('query', listProfilesSchema),
  async (c) => {
    const { company_id, role, active, page, limit } = c.req.valid('query')
    const { from, to } = paginationRange(page, limit)

    let q = supabase
      .from('profiles')
      .select('*, companies(name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (company_id) q = q.eq('company_id', company_id)
    if (role) q = q.eq('role', role)
    if (active !== undefined) q = q.eq('active', active !== 'false')

    const { data, error, count } = await q
    if (error) throw error
    return c.json(paginatedResponse(data ?? [], count ?? 0, page, limit))
  },
)

// GET /api/profiles/:id
app.get('/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  async (c) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*, companies(name)')
      .eq('id', c.req.param('id')!)
      .single()

    if (error) throw error
    return c.json(data)
  },
)

// PATCH /api/profiles/:id — admin puede cambiar role, active, company
app.patch('/:id',
  requireRole('admin', 'rs_admin'),
  zValidator('json', updateProfileAdminSchema),
  async (c) => {
    const { data, error } = await supabase
      .from('profiles')
      .update(c.req.valid('json'))
      .eq('id', c.req.param('id')!)
      .select()
      .single()

    if (error) throw error
    return c.json(data)
  },
)

// GET /api/profiles/company/:companyId/team — equipo de una empresa con invitaciones pendientes
app.get('/company/:companyId/team', async (c) => {
  const { data, error } = await supabase
    .from('company_team_view')
    .select('*')
    .eq('company_id', c.req.param('companyId')!)
    .order('created_at', { ascending: false })

  if (error) throw error
  return c.json(data)
})

// POST /api/profiles/invite — invitar personal administrativo Finto
const inviteAdminSchema = z.object({
  full_name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(['admin', 'rs_admin', 'rs_staff', 'contador']),
})

app.post('/invite',
  requireRole('admin', 'rs_admin'),
  zValidator('json', inviteAdminSchema),
  async (c) => {
    const { full_name, email, role: targetRole } = c.req.valid('json')

    // Create invitation record
    const token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    const { error: invErr } = await supabase
      .from('company_invitations')
      .insert({
        full_name,
        email: email.toLowerCase().trim(),
        role: targetRole,
        token,
        status: 'pending',
        expires_at: expiresAt,
        company_id: null,
      })

    if (invErr) {
      if (invErr.code === '23505') return c.json({ error: 'Ya existe una invitación pendiente para ese email' }, 409)
      throw invErr
    }

    // Send invitation email via Zavu
    const { NotificationService } = await import('../../notifications/NotificationService.js')
    const platformUrl = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

    void NotificationService.enqueue({
      channel: 'email',
      template: 'invitation',
      to: email,
      data: {
        name: full_name,
        companyName: 'Finto',
        inviteUrl: `${platformUrl}/invitations/accept?token=${token}`,
      },
    })

    return c.json({ ok: true, email, role: targetRole, expires_at: expiresAt }, 201)
  },
)

export const profilesRoutes = app
