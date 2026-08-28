import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requirePermission } from '../../middleware/requireRole.js'
import { supabase } from '../../lib/supabase.js'
import {
  MODULE_CATALOG,
  ACTIONS,
  isModule,
  invalidatePermissions,
  type Action,
} from '../../lib/permissions.js'

const app = new Hono()

// Ver el módulo de roles requiere el permiso 'roles' (view).
app.use('/*', authMiddleware, requireModule('roles'))

const actionEnum = z.enum(['view', 'create', 'update', 'delete'])

const permissionEntrySchema = z.object({
  module: z.string().refine(isModule, 'Módulo desconocido'),
  actions: z.array(actionEnum).default([]),
})

const permissionsSchema = z.object({
  permissions: z.array(permissionEntrySchema),
})

const createRoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'Clave inválida (minúsculas, guion bajo)').max(40).optional(),
  name: z.string().min(2).max(80),
  description: z.string().max(300).optional(),
  scope: z.enum(['internal', 'client']).default('internal'),
  permissions: z.array(permissionEntrySchema).default([]),
})

const updateRoleSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(300).nullable().optional(),
  scope: z.enum(['internal', 'client']).optional(),
})

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'rol'
}

function toRow(roleKey: string, module: string, actions: Action[]) {
  return {
    role_key:   roleKey,
    module,
    can_view:   actions.includes('view'),
    can_create: actions.includes('create'),
    can_update: actions.includes('update'),
    can_delete: actions.includes('delete'),
  }
}

// GET /api/roles/modules — catálogo de módulos + acciones (para pintar la grilla)
app.get('/modules', (c) => {
  const modules = Object.entries(MODULE_CATALOG).map(([key, meta]) => ({
    key,
    name:  meta.name,
    scope: meta.scope,
  }))
  return c.json({ modules, actions: ACTIONS })
})

// GET /api/roles — roles con su matriz de permisos y conteo de usuarios
app.get('/', async (c) => {
  const [{ data: roles, error: rErr }, { data: perms, error: pErr }] = await Promise.all([
    supabase.from('roles').select('*').order('is_system', { ascending: false }).order('name'),
    supabase.from('role_permissions').select('role_key, module, can_view, can_create, can_update, can_delete'),
  ])
  if (rErr) throw rErr
  if (pErr) throw pErr

  // Conteo de usuarios por rol
  const { data: profiles, error: cErr } = await supabase.from('profiles').select('role')
  if (cErr) throw cErr
  const counts = new Map<string, number>()
  for (const p of profiles ?? []) counts.set(p.role, (counts.get(p.role) ?? 0) + 1)

  const permsByRole = new Map<string, Record<string, Action[]>>()
  for (const p of perms ?? []) {
    const entry = permsByRole.get(p.role_key) ?? {}
    const actions = ACTIONS.filter((a) =>
      (a === 'view' && p.can_view) ||
      (a === 'create' && p.can_create) ||
      (a === 'update' && p.can_update) ||
      (a === 'delete' && p.can_delete),
    )
    if (actions.length) entry[p.module] = actions
    permsByRole.set(p.role_key, entry)
  }

  const result = (roles ?? []).map((r) => ({
    ...r,
    user_count: counts.get(r.key) ?? 0,
    permissions: permsByRole.get(r.key) ?? {},
  }))
  return c.json(result)
})

// POST /api/roles — crear rol custom
app.post('/',
  requirePermission('roles', 'create'),
  zValidator('json', createRoleSchema),
  async (c) => {
    const body = c.req.valid('json')
    const key = body.key ?? slugify(body.name)

    const { error: insErr } = await supabase.from('roles').insert({
      key,
      name: body.name,
      description: body.description ?? null,
      scope: body.scope,
      is_system: false,
    })
    if (insErr) {
      if (insErr.code === '23505') return c.json({ error: 'Ya existe un rol con esa clave' }, 409)
      throw insErr
    }

    if (body.permissions.length) {
      const rows = body.permissions.map((p) => toRow(key, p.module, p.actions))
      const { error: pErr } = await supabase.from('role_permissions').insert(rows)
      if (pErr) throw pErr
    }

    invalidatePermissions()
    return c.json({ key, name: body.name, scope: body.scope }, 201)
  },
)

// PATCH /api/roles/:key — renombrar / descripción / scope
app.patch('/:key',
  requirePermission('roles', 'update'),
  zValidator('json', updateRoleSchema),
  async (c) => {
    const key = c.req.param('key')
    const body = c.req.valid('json')

    const { data, error } = await supabase
      .from('roles')
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq('key', key)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') return c.json({ error: 'Rol no encontrado' }, 404)
      throw error
    }
    return c.json(data)
  },
)

// PUT /api/roles/:key/permissions — reemplaza el set completo de permisos del rol
app.put('/:key/permissions',
  requirePermission('roles', 'update'),
  zValidator('json', permissionsSchema),
  async (c) => {
    const key = c.req.param('key')

    // El rol debe existir
    const { data: role, error: roleErr } = await supabase
      .from('roles').select('key').eq('key', key).single()
    if (roleErr || !role) return c.json({ error: 'Rol no encontrado' }, 404)

    const entries = new Map<string, Action[]>()
    for (const p of c.req.valid('json').permissions) entries.set(p.module, p.actions)

    // Candado anti-lockout: 'admin' nunca pierde acceso a 'roles'.
    if (key === 'admin') {
      const rolesActions = new Set(entries.get('roles') ?? [])
      rolesActions.add('view')
      entries.set('roles', [...rolesActions])
    }

    const rows = [...entries.entries()]
      .map(([module, actions]) => toRow(key, module, actions))
      .filter((r) => r.can_view || r.can_create || r.can_update || r.can_delete)

    // Reemplazo atómico simple: borrar e insertar
    const { error: delErr } = await supabase.from('role_permissions').delete().eq('role_key', key)
    if (delErr) throw delErr
    if (rows.length) {
      const { error: insErr } = await supabase.from('role_permissions').insert(rows)
      if (insErr) throw insErr
    }

    invalidatePermissions()
    return c.json({ ok: true, key, modules: rows.length })
  },
)

// DELETE /api/roles/:key — borrar rol custom (bloqueado si is_system o en uso)
app.delete('/:key',
  requirePermission('roles', 'delete'),
  async (c) => {
    const key = c.req.param('key')

    const { data: role, error: roleErr } = await supabase
      .from('roles').select('key, is_system').eq('key', key).single()
    if (roleErr || !role) return c.json({ error: 'Rol no encontrado' }, 404)
    if (role.is_system) return c.json({ error: 'No se puede borrar un rol del sistema' }, 400)

    const { count, error: cntErr } = await supabase
      .from('profiles').select('id', { count: 'exact', head: true }).eq('role', key)
    if (cntErr) throw cntErr
    if ((count ?? 0) > 0) {
      return c.json({ error: `El rol tiene ${count} usuario(s) asignado(s)` }, 409)
    }

    const { error: delErr } = await supabase.from('roles').delete().eq('key', key)
    if (delErr) throw delErr

    invalidatePermissions()
    return c.json({ ok: true })
  },
)

export const rolesRoutes = app
