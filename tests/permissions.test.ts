import { describe, it, expect, vi } from 'vitest'

// El test solo ejercita funciones puras; se mockea supabase para no exigir env.
vi.mock('../src/lib/supabase.js', () => ({ supabase: {} }))

import {
  buildPermMap,
  canFromMap,
  modulesFromMap,
  permissionsFromMap,
  hasRole,
  MODULE_CATALOG,
  RS_ROLES,
  CLIENT_ROLES,
  type PermRow,
  type PermMap,
} from '../src/lib/permissions.js'

// ── Fixture: refleja la siembra de la migración (CRUD completo donde hay acceso).
// Mismos pares (rol, módulo) que 20260820_dynamic_roles_permissions.sql.
const SEED: Array<[string, string]> = [
  ['admin','dashboard'],['rs_admin','dashboard'],['rs_staff','dashboard'],
  ['contador','dashboard'],['client_owner','dashboard'],['client_user','dashboard'],
  ['admin','onboarding'],['rs_admin','onboarding'],['rs_staff','onboarding'],
  ['admin','companies'],['rs_admin','companies'],['rs_staff','companies'],['client_owner','companies'],
  ['admin','tasks'],['rs_admin','tasks'],['rs_staff','tasks'],
  ['contador','tasks'],['client_owner','tasks'],['client_user','tasks'],
  ['admin','operational_requests'],['rs_admin','operational_requests'],['rs_staff','operational_requests'],
  ['client_owner','operational_requests'],['client_user','operational_requests'],
  ['admin','collection'],['rs_admin','collection'],['rs_staff','collection'],['client_owner','collection'],
  ['admin','accounting'],['rs_admin','accounting'],['contador','accounting'],
  ['admin','participations'],['rs_admin','participations'],['contador','participations'],
  ['admin','documents'],['rs_admin','documents'],['rs_staff','documents'],
  ['contador','documents'],['client_owner','documents'],['client_user','documents'],
  ['admin','team_management'],['rs_admin','team_management'],['client_owner','team_management'],
  ['admin','users_admin'],
  ['admin','settings'],['rs_admin','settings'],
  ['admin','notifications_log'],['rs_admin','notifications_log'],
  ['admin','roles'],
]

const rows: PermRow[] = SEED.map(([role_key, module]) => ({
  role_key, module,
  can_view: true, can_create: true, can_update: true, can_delete: true,
}))

const map: PermMap = buildPermMap(rows)
const access = (role: string, module: string) => canFromMap(map, role, module, 'view')

describe('canFromMap (view)', () => {
  it('admin accede a todos los módulos del catálogo', () => {
    for (const m of Object.keys(MODULE_CATALOG)) {
      expect(access('admin', m)).toBe(true)
    }
  })

  it('rs_staff NO accede a users_admin ni settings', () => {
    expect(access('rs_staff', 'users_admin')).toBe(false)
    expect(access('rs_staff', 'settings')).toBe(false)
  })

  it('rs_staff accede a onboarding, tasks, collection', () => {
    expect(access('rs_staff', 'onboarding')).toBe(true)
    expect(access('rs_staff', 'tasks')).toBe(true)
    expect(access('rs_staff', 'collection')).toBe(true)
  })

  it('client_owner NO accede a onboarding ni users_admin', () => {
    expect(access('client_owner', 'onboarding')).toBe(false)
    expect(access('client_owner', 'users_admin')).toBe(false)
  })

  it('client_owner accede a companies, tasks, requests, collection, documents, team', () => {
    expect(access('client_owner', 'companies')).toBe(true)
    expect(access('client_owner', 'tasks')).toBe(true)
    expect(access('client_owner', 'operational_requests')).toBe(true)
    expect(access('client_owner', 'collection')).toBe(true)
    expect(access('client_owner', 'documents')).toBe(true)
    expect(access('client_owner', 'team_management')).toBe(true)
  })

  it('client_user NO accede a collection, companies, team_management', () => {
    expect(access('client_user', 'collection')).toBe(false)
    expect(access('client_user', 'companies')).toBe(false)
    expect(access('client_user', 'team_management')).toBe(false)
  })

  it('client_user SÍ accede a tasks, requests y documents', () => {
    expect(access('client_user', 'tasks')).toBe(true)
    expect(access('client_user', 'operational_requests')).toBe(true)
    expect(access('client_user', 'documents')).toBe(true)
  })

  it('accounting: solo admin, rs_admin y contador', () => {
    expect(access('admin', 'accounting')).toBe(true)
    expect(access('rs_admin', 'accounting')).toBe(true)
    expect(access('contador', 'accounting')).toBe(true)
    expect(access('rs_staff', 'accounting')).toBe(false)
    expect(access('client_owner', 'accounting')).toBe(false)
    expect(access('client_user', 'accounting')).toBe(false)
  })

  it('solo admin accede a users_admin y roles', () => {
    expect(access('admin', 'users_admin')).toBe(true)
    expect(access('admin', 'roles')).toBe(true)
    expect(access('rs_admin', 'users_admin')).toBe(false)
    expect(access('rs_admin', 'roles')).toBe(false)
  })
})

describe('canFromMap (acciones)', () => {
  it('un rol sin acción concreta la recibe false', () => {
    const partial = buildPermMap([
      { role_key: 'lector', module: 'tasks', can_view: true, can_create: false, can_update: false, can_delete: false },
    ])
    expect(canFromMap(partial, 'lector', 'tasks', 'view')).toBe(true)
    expect(canFromMap(partial, 'lector', 'tasks', 'create')).toBe(false)
    expect(canFromMap(partial, 'lector', 'tasks', 'delete')).toBe(false)
  })

  it('la siembra otorga CRUD completo donde hay acceso', () => {
    expect(canFromMap(map, 'admin', 'tasks', 'create')).toBe(true)
    expect(canFromMap(map, 'admin', 'tasks', 'update')).toBe(true)
    expect(canFromMap(map, 'admin', 'tasks', 'delete')).toBe(true)
  })
})

describe('modulesFromMap', () => {
  it('client_user no recibe onboarding, collection, team, users_admin, settings', () => {
    const modules = modulesFromMap(map, 'client_user')
    expect(modules).not.toContain('onboarding')
    expect(modules).not.toContain('collection')
    expect(modules).not.toContain('team_management')
    expect(modules).not.toContain('users_admin')
    expect(modules).not.toContain('settings')
  })

  it('rs_admin no recibe users_admin ni roles', () => {
    const modules = modulesFromMap(map, 'rs_admin')
    expect(modules).not.toContain('users_admin')
    expect(modules).not.toContain('roles')
  })

  it('un rol inexistente recibe lista vacía', () => {
    expect(modulesFromMap(map, 'no_existe')).toEqual([])
  })
})

describe('permissionsFromMap', () => {
  it('devuelve { module: Action[] } con acciones ordenadas', () => {
    const perms = permissionsFromMap(map, 'contador')
    expect(perms.accounting).toEqual(['view', 'create', 'update', 'delete'])
    expect(perms.collection).toBeUndefined()
  })
})

describe('hasRole y constantes de grupo', () => {
  it('hasRole verifica pertenencia', () => {
    expect(hasRole('admin', 'rs_admin', 'admin')).toBe(true)
    expect(hasRole('rs_staff', 'rs_admin', 'admin')).toBe(false)
  })

  it('RS_ROLES / CLIENT_ROLES', () => {
    expect(RS_ROLES).toContain('admin')
    expect(RS_ROLES).not.toContain('client_owner')
    expect(CLIENT_ROLES).toContain('client_owner')
    expect(CLIENT_ROLES).not.toContain('admin')
  })
})
