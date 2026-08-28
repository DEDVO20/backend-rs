// ─────────────────────────────────────────────────────────────────────────────
// permissions.ts
// Roles y permisos DINÁMICOS. La asignación módulo→rol vive en la base de datos
// (tablas roles / role_permissions) y se administra desde la app.
//
// Lo único que permanece en código es el CATÁLOGO de módulos, porque cada módulo
// corresponde a una feature/ruta real: no se puede "asignar" un módulo que no
// existe. Agregar un módulo nuevo = una línea en MODULE_CATALOG.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabase.js'

// Un rol es cualquier string (los base + los que cree el admin).
export type Role = string

export type Action = 'view' | 'create' | 'update' | 'delete'
export const ACTIONS: readonly Action[] = ['view', 'create', 'update', 'delete'] as const

// ── Catálogo de módulos (fuente de verdad de "qué se puede asignar") ──────────
export const MODULE_CATALOG = {
  dashboard:            { name: 'Panel',                  scope: 'shared' },
  onboarding:           { name: 'Onboarding',             scope: 'internal' },
  companies:            { name: 'Empresas',               scope: 'shared' },
  tasks:                { name: 'Tareas',                 scope: 'shared' },
  operational_requests: { name: 'Solicitudes',            scope: 'shared' },
  collection:           { name: 'Cobranza',               scope: 'shared' },
  accounting:           { name: 'Contabilidad',           scope: 'internal' },
  participations:       { name: 'Participaciones',        scope: 'internal' },
  documents:            { name: 'Documentos',             scope: 'shared' },
  team_management:      { name: 'Gestión de equipo',      scope: 'shared' },
  users_admin:          { name: 'Administración usuarios', scope: 'internal' },
  settings:             { name: 'Configuración',          scope: 'internal' },
  notifications_log:    { name: 'Log de notificaciones',  scope: 'internal' },
  roles:                { name: 'Roles y permisos',       scope: 'internal' },
} as const satisfies Record<string, { name: string; scope: 'internal' | 'client' | 'shared' }>

export type Module = keyof typeof MODULE_CATALOG

export function isModule(m: string): m is Module {
  return m in MODULE_CATALOG
}

// ── Estructura en memoria: role → module → Set<Action> ────────────────────────
export type PermRow = {
  role_key:   string
  module:     string
  can_view:   boolean
  can_create: boolean
  can_update: boolean
  can_delete: boolean
}

export type PermMap = Map<string, Map<string, Set<Action>>>

/** Construye el mapa de permisos a partir de filas de la tabla (función pura). */
export function buildPermMap(rows: PermRow[]): PermMap {
  const map: PermMap = new Map()
  for (const r of rows) {
    let byModule = map.get(r.role_key)
    if (!byModule) {
      byModule = new Map()
      map.set(r.role_key, byModule)
    }
    const actions = new Set<Action>()
    if (r.can_view)   actions.add('view')
    if (r.can_create) actions.add('create')
    if (r.can_update) actions.add('update')
    if (r.can_delete) actions.add('delete')
    if (actions.size > 0) byModule.set(r.module, actions)
  }
  return map
}

/** ¿El rol puede ejecutar `action` sobre `module`? (función pura sobre un mapa) */
export function canFromMap(map: PermMap, role: Role, module: string, action: Action = 'view'): boolean {
  return map.get(role)?.get(module)?.has(action) ?? false
}

/** Módulos visibles (con acción 'view') para un rol. (función pura sobre un mapa) */
export function modulesFromMap(map: PermMap, role: Role): string[] {
  const byModule = map.get(role)
  if (!byModule) return []
  return [...byModule.entries()].filter(([, a]) => a.has('view')).map(([m]) => m)
}

/** Permisos de un rol como { module: Action[] } (para enviar al frontend). */
export function permissionsFromMap(map: PermMap, role: Role): Record<string, Action[]> {
  const byModule = map.get(role)
  if (!byModule) return {}
  const out: Record<string, Action[]> = {}
  for (const [module, actions] of byModule) {
    out[module] = ACTIONS.filter(a => actions.has(a))
  }
  return out
}

// ── Capa cacheada sobre la base de datos ──────────────────────────────────────
const PERM_CACHE_TTL = 60_000
let cache: { map: PermMap; expires: number } | null = null
let inflight: Promise<PermMap> | null = null

/** Invalida el cache — llamar tras cualquier cambio en roles/permisos. */
export function invalidatePermissions(): void {
  cache = null
}

async function loadPermMap(): Promise<PermMap> {
  const { data, error } = await supabase
    .from('role_permissions')
    .select('role_key, module, can_view, can_create, can_update, can_delete')

  if (error) throw error
  return buildPermMap((data ?? []) as PermRow[])
}

/** Devuelve el mapa de permisos, cacheado con TTL corto. */
export async function getPermMap(): Promise<PermMap> {
  if (cache && cache.expires > Date.now()) return cache.map
  if (inflight) return inflight

  inflight = loadPermMap()
    .then((map) => {
      cache = { map, expires: Date.now() + PERM_CACHE_TTL }
      return map
    })
    .finally(() => { inflight = null })

  return inflight
}

/** ¿El rol puede ejecutar `action` sobre `module`? */
export async function can(role: Role, module: string, action: Action = 'view'): Promise<boolean> {
  return canFromMap(await getPermMap(), role, module, action)
}

/** ¿El rol puede VER el módulo? (equivale a can(role, module, 'view')) */
export async function canAccess(role: Role, module: string): Promise<boolean> {
  return can(role, module, 'view')
}

/** Módulos disponibles (visibles) para un rol — para el sidebar del frontend. */
export async function getModulesForRole(role: Role): Promise<string[]> {
  return modulesFromMap(await getPermMap(), role)
}

/** Matriz de permisos de un rol { module: Action[] } — para el frontend. */
export async function getPermissionsForRole(role: Role): Promise<Record<string, Action[]>> {
  return permissionsFromMap(await getPermMap(), role)
}

// ── Constantes de conveniencia (roles internos vs. cliente) ───────────────────
export const RS_ROLES: Role[] = ['admin', 'rs_admin', 'rs_staff', 'contador']
export const CLIENT_ROLES: Role[] = ['client_owner', 'client_user']

export function hasRole(userRole: Role, ...allowed: Role[]): boolean {
  return allowed.includes(userRole)
}
