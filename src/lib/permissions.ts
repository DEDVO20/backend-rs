// ─────────────────────────────────────────────────────────────────────────────
// permissions.ts
// Fuente de verdad de roles y acceso por módulo.
// Para agregar un módulo nuevo: una sola línea en MODULE_PERMISSIONS.
// ─────────────────────────────────────────────────────────────────────────────

export type Role =
  | 'admin'
  | 'rs_admin'
  | 'rs_staff'
  | 'contador'
  | 'client_owner'
  | 'client_user'

export const MODULE_PERMISSIONS = {
  dashboard:            ['admin', 'rs_admin', 'rs_staff', 'contador', 'client_owner', 'client_user'],
  onboarding:           ['admin', 'rs_admin', 'rs_staff'],
  companies:            ['admin', 'rs_admin', 'rs_staff', 'client_owner'],
  tasks:                ['admin', 'rs_admin', 'rs_staff', 'contador', 'client_owner', 'client_user'],
  operational_requests: ['admin', 'rs_admin', 'rs_staff', 'client_owner', 'client_user'],
  collection:           ['admin', 'rs_admin', 'rs_staff', 'client_owner'],
  accounting:           ['admin', 'rs_admin', 'contador'],
  participations:       ['admin', 'rs_admin', 'contador'],
  documents:            ['admin', 'rs_admin', 'rs_staff', 'contador', 'client_owner', 'client_user'],
  team_management:      ['admin', 'rs_admin', 'client_owner'],
  users_admin:          ['admin'],
  settings:             ['admin', 'rs_admin'],
  notifications_log:    ['admin', 'rs_admin'],
} as const satisfies Record<string, readonly Role[]>

export type Module = keyof typeof MODULE_PERMISSIONS

/** Verifica si un rol puede acceder a un módulo */
export function canAccess(role: Role, module: Module): boolean {
  return (MODULE_PERMISSIONS[module] as readonly string[]).includes(role)
}

/** Devuelve todos los módulos disponibles para un rol (para el frontend) */
export function getModulesForRole(role: Role): Module[] {
  return (Object.keys(MODULE_PERMISSIONS) as Module[]).filter(m => canAccess(role, m))
}

/** Verifica si un rol tiene al menos uno de los roles requeridos */
export function hasRole(userRole: Role, ...allowed: Role[]): boolean {
  return allowed.includes(userRole)
}

/** Roles internos de la firma */
export const RS_ROLES: Role[] = ['admin', 'rs_admin', 'rs_staff', 'contador']

/** Roles de cliente */
export const CLIENT_ROLES: Role[] = ['client_owner', 'client_user']
