import type { Context, Next } from 'hono'
import type { Role, Module, Action } from '../lib/permissions.js'
import { canAccess, can } from '../lib/permissions.js'

/**
 * Restringe una ruta a uno o más roles específicos.
 *
 * @example
 * app.post('/:id/approve', requireRole('rs_admin', 'admin'), handler)
 */
export function requireRole(...roles: Role[]) {
  return async (c: Context, next: Next) => {
    const { role } = c.get('user')
    if (!roles.includes(role)) {
      return c.json({ error: 'Acceso denegado — rol insuficiente' }, 403)
    }
    await next()
  }
}

/**
 * Restringe una ruta según los permisos del rol (acción 'view').
 * Usar en el nivel del router para proteger módulos completos.
 *
 * @example
 * app.use('/onboarding/*', authMiddleware, requireModule('onboarding'))
 */
export function requireModule(module: Module) {
  return async (c: Context, next: Next) => {
    const { role } = c.get('user')
    if (!(await canAccess(role, module))) {
      return c.json({ error: `Módulo '${module}' no disponible para tu rol` }, 403)
    }
    await next()
  }
}

/**
 * Restringe una ruta a una acción concreta (crear/editar/eliminar) sobre un módulo.
 * Usar en rutas de escritura para respetar los permisos por acción del rol.
 *
 * @example
 * app.post('/', requirePermission('collection', 'create'), handler)
 * app.patch('/:id', requirePermission('collection', 'update'), handler)
 * app.delete('/:id', requirePermission('collection', 'delete'), handler)
 */
export function requirePermission(module: Module, action: Action) {
  return async (c: Context, next: Next) => {
    const { role } = c.get('user')
    if (!(await can(role, module, action))) {
      return c.json({ error: `Acción '${action}' no permitida en '${module}' para tu rol` }, 403)
    }
    await next()
  }
}

/**
 * Verifica que el usuario solo acceda a recursos de su propia empresa.
 * Para roles internos (rs_*) permite cualquier empresa.
 *
 * @example
 * app.get('/:companyId/tasks', requireOwnCompany('companyId'), handler)
 */
export function requireOwnCompany(paramName = 'companyId') {
  return async (c: Context, next: Next) => {
    const { role, companyId } = c.get('user')
    const targetId = c.req.param(paramName)

    // Roles internos pueden ver cualquier empresa
    const isInternal = ['admin', 'rs_admin', 'rs_staff'].includes(role)
    if (isInternal) return next()

    if (!companyId || companyId !== targetId) {
      return c.json({ error: 'Acceso denegado — empresa incorrecta' }, 403)
    }

    await next()
  }
}
