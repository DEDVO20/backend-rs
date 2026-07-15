import { describe, it, expect } from 'vitest'
import {
  canAccess,
  getModulesForRole,
  hasRole,
  MODULE_PERMISSIONS,
  RS_ROLES,
  CLIENT_ROLES,
  type Role,
  type Module,
} from '../src/lib/permissions.js'

describe('canAccess', () => {
  it('admin accede a todos los módulos', () => {
    const modules = Object.keys(MODULE_PERMISSIONS) as Module[]
    for (const m of modules) {
      expect(canAccess('admin', m)).toBe(true)
    }
  })

  it('rs_staff NO accede a users_admin ni settings', () => {
    expect(canAccess('rs_staff', 'users_admin')).toBe(false)
    expect(canAccess('rs_staff', 'settings')).toBe(false)
  })

  it('rs_staff accede a onboarding, tasks, collection', () => {
    expect(canAccess('rs_staff', 'onboarding')).toBe(true)
    expect(canAccess('rs_staff', 'tasks')).toBe(true)
    expect(canAccess('rs_staff', 'collection')).toBe(true)
  })

  it('client_owner NO accede a onboarding ni users_admin', () => {
    expect(canAccess('client_owner', 'onboarding')).toBe(false)
    expect(canAccess('client_owner', 'users_admin')).toBe(false)
  })

  it('client_owner accede a su empresa, tasks, requests, collection, documents', () => {
    expect(canAccess('client_owner', 'companies')).toBe(true)
    expect(canAccess('client_owner', 'tasks')).toBe(true)
    expect(canAccess('client_owner', 'operational_requests')).toBe(true)
    expect(canAccess('client_owner', 'collection')).toBe(true)
    expect(canAccess('client_owner', 'documents')).toBe(true)
    expect(canAccess('client_owner', 'team_management')).toBe(true)
  })

  it('client_user NO accede a collection, companies, team_management', () => {
    expect(canAccess('client_user', 'collection')).toBe(false)
    expect(canAccess('client_user', 'companies')).toBe(false)
    expect(canAccess('client_user', 'team_management')).toBe(false)
  })

  it('client_user SÍ accede a tasks, requests y documents', () => {
    expect(canAccess('client_user', 'tasks')).toBe(true)
    expect(canAccess('client_user', 'operational_requests')).toBe(true)
    expect(canAccess('client_user', 'documents')).toBe(true)
  })

  it('accounting: solo admin, rs_admin y contador', () => {
    expect(canAccess('admin', 'accounting')).toBe(true)
    expect(canAccess('rs_admin', 'accounting')).toBe(true)
    expect(canAccess('contador', 'accounting')).toBe(true)
    expect(canAccess('rs_staff', 'accounting')).toBe(false)
    expect(canAccess('client_owner', 'accounting')).toBe(false)
    expect(canAccess('client_user', 'accounting')).toBe(false)
  })

  it('contador accede a tasks y documents pero NO a collection ni settings', () => {
    expect(canAccess('contador', 'tasks')).toBe(true)
    expect(canAccess('contador', 'documents')).toBe(true)
    expect(canAccess('contador', 'dashboard')).toBe(true)
    expect(canAccess('contador', 'collection')).toBe(false)
    expect(canAccess('contador', 'settings')).toBe(false)
    expect(canAccess('contador', 'users_admin')).toBe(false)
  })

  it('todos los roles acceden al dashboard', () => {
    const roles: Role[] = ['admin', 'rs_admin', 'rs_staff', 'client_owner', 'client_user']
    for (const role of roles) {
      expect(canAccess(role, 'dashboard')).toBe(true)
    }
  })

  it('solo admin accede a users_admin', () => {
    expect(canAccess('admin',        'users_admin')).toBe(true)
    expect(canAccess('rs_admin',     'users_admin')).toBe(false)
    expect(canAccess('rs_staff',     'users_admin')).toBe(false)
    expect(canAccess('client_owner', 'users_admin')).toBe(false)
    expect(canAccess('client_user',  'users_admin')).toBe(false)
  })
})

describe('getModulesForRole', () => {
  it('admin recibe todos los módulos', () => {
    const all = Object.keys(MODULE_PERMISSIONS) as Module[]
    expect(getModulesForRole('admin').sort()).toEqual(all.sort())
  })

  it('client_user no recibe onboarding, collection, team_management, users_admin, settings', () => {
    const modules = getModulesForRole('client_user')
    expect(modules).not.toContain('onboarding')
    expect(modules).not.toContain('collection')
    expect(modules).not.toContain('team_management')
    expect(modules).not.toContain('users_admin')
    expect(modules).not.toContain('settings')
  })

  it('rs_admin no recibe users_admin', () => {
    const modules = getModulesForRole('rs_admin')
    expect(modules).not.toContain('users_admin')
  })

  it('todos los módulos de rs_staff son correctos', () => {
    const modules = getModulesForRole('rs_staff')
    expect(modules).toContain('dashboard')
    expect(modules).toContain('onboarding')
    expect(modules).toContain('companies')
    expect(modules).toContain('tasks')
    expect(modules).toContain('operational_requests')
    expect(modules).toContain('collection')
    expect(modules).toContain('documents')
    expect(modules).not.toContain('users_admin')
    expect(modules).not.toContain('settings')
    expect(modules).not.toContain('team_management')
  })
})

describe('hasRole', () => {
  it('verifica correctamente si un rol está en la lista', () => {
    expect(hasRole('admin', 'rs_admin', 'admin')).toBe(true)
    expect(hasRole('rs_staff', 'rs_admin', 'admin')).toBe(false)
    expect(hasRole('client_owner', 'client_owner', 'client_user')).toBe(true)
  })
})

describe('constantes de grupos', () => {
  it('RS_ROLES incluye los roles internos', () => {
    expect(RS_ROLES).toContain('admin')
    expect(RS_ROLES).toContain('rs_admin')
    expect(RS_ROLES).toContain('rs_staff')
    expect(RS_ROLES).not.toContain('client_owner')
  })

  it('CLIENT_ROLES incluye solo roles de cliente', () => {
    expect(CLIENT_ROLES).toContain('client_owner')
    expect(CLIENT_ROLES).toContain('client_user')
    expect(CLIENT_ROLES).not.toContain('admin')
  })
})
