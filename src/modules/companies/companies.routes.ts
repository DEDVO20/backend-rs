import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware, invalidateCompanyAuthCache } from '../../middleware/auth.js'
import { requireModule }      from '../../middleware/requireRole.js'
import { requireRole, requirePermission } from '../../middleware/requireRole.js'
import { requireOwnCompany }  from '../../middleware/requireRole.js'
import { CompaniesService }   from './companies.service.js'
import { createInvitation, listPendingInvitations } from '../invitations/invitations.service.js'
import { auditAsync }         from '../../lib/audit.js'
import {
  CLIENT_EDITABLE_COMPANY_FIELDS,
  createCompanySchema,
  listCompaniesQuerySchema,
  updateCompanySchema,
} from './companies.schema.js'

const app = new Hono()

app.use('/*', authMiddleware, requireModule('companies'))

// GET /api/companies — solo roles internos
app.get('/',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('query', listCompaniesQuerySchema),
  async (c) => {
    const result = await CompaniesService.list(c.req.valid('query'))
    return c.json(result)
  },
)

// POST /api/companies — crear empresa (admin/rs_admin)
app.post('/',
  requireRole('admin', 'rs_admin'),
  requirePermission('companies', 'create'),
  zValidator('json', createCompanySchema),
  async (c) => {
    const data = await CompaniesService.create(c.req.valid('json'))
    return c.json(data, 201)
  },
)

// GET /api/companies/:id — interno: cualquier empresa | cliente: solo la suya
app.get('/:id', async (c) => {
  const { role } = c.get('user')
  const id = c.req.param('id')

  const isInternal = ['admin', 'rs_admin', 'rs_staff'].includes(role)
  if (isInternal) {
    return c.json(await CompaniesService.getById(id))
  }

  // client_owner ve perfil reducido solo de su empresa
  const { companyId } = c.get('user')
  if (companyId !== id) return c.json({ error: 'Acceso denegado' }, 403)
  return c.json(await CompaniesService.getByIdForClient(id))
})

// PATCH /api/companies/:id — rs_admin, admin o client_owner de su empresa
app.patch('/:id',
  requirePermission('companies', 'update'),
  zValidator('json', updateCompanySchema),
  async (c) => {
    const { role, companyId } = c.get('user')
    const id = c.req.param('id')!
    const isInternal = ['admin', 'rs_admin'].includes(role)

    const input = c.req.valid('json')
    if (!isInternal) {
      if (role !== 'client_owner' || companyId !== id) {
        return c.json({ error: 'Acceso denegado' }, 403)
      }
      // El cliente solo cambia sus datos públicos (sitio web); NIT, cupos, asesor, etc. los gestiona Finto
      const notAllowed = Object.keys(input).filter(k => !(CLIENT_EDITABLE_COMPANY_FIELDS as readonly string[]).includes(k))
      if (notAllowed.length) {
        return c.json({ error: `No puedes modificar: ${notAllowed.join(', ')}` }, 403)
      }
    }

    const data = await CompaniesService.update(id, input)
    return c.json(data)
  },
)

// POST /api/companies/:id/inactivate — solo admin/rs_admin
const inactivateSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

app.post('/:id/inactivate',
  requireRole('admin', 'rs_admin'),
  requirePermission('companies', 'update'),
  zValidator('json', inactivateSchema),
  async (c) => {
    const { id: userId } = c.get('user')
    const data = await CompaniesService.inactivate(c.req.param('id')!, userId, c.req.valid('json').reason)
    invalidateCompanyAuthCache(data.id)   // el bloqueo aplica de inmediato, no en 60 s
    auditAsync({ action: 'update', resource: 'companies', resource_id: data.id, user: c.get('user'), c,
      metadata: { event: 'company_inactivated', reason: data.inactivation_reason } })
    return c.json(data)
  },
)

// POST /api/companies/:id/reactivate — solo admin/rs_admin
app.post('/:id/reactivate',
  requireRole('admin', 'rs_admin'),
  requirePermission('companies', 'update'),
  async (c) => {
    const data = await CompaniesService.reactivate(c.req.param('id')!)
    auditAsync({ action: 'update', resource: 'companies', resource_id: data.id, user: c.get('user'), c,
      metadata: { event: 'company_reactivated' } })
    return c.json(data)
  },
)

// GET /api/companies/:id/team
app.get('/:id/team', requireOwnCompany('id'), async (c) => {
  const data = await CompaniesService.getTeam(c.req.param('id')!)
  return c.json(data)
})

// GET /api/companies/:id/invitations — invitaciones pendientes de la empresa
app.get('/:id/invitations',
  requireRole('admin', 'rs_admin', 'rs_staff', 'client_owner'),
  requireOwnCompany('id'),
  async (c) => c.json(await listPendingInvitations(c.req.param('id')!)),
)

// POST /api/companies/:id/invite — invitar dueño o usuario de la empresa.
// Reenviar = invitar de nuevo el mismo correo (cancela la invitación anterior).
const inviteSchema = z.object({
  email:     z.string().email(),
  full_name: z.string().trim().min(2).optional(),
  role:      z.enum(['client_owner', 'client_user']),
})

app.post('/:id/invite',
  requireRole('admin', 'rs_admin', 'rs_staff', 'client_owner'),
  requireOwnCompany('id'),
  zValidator('json', inviteSchema),
  async (c) => {
    const { id: inviterId, role } = c.get('user')
    const companyId = c.req.param('id')!
    const { email, full_name, role: targetRole } = c.req.valid('json')

    // client_owner solo puede invitar client_user
    if (role === 'client_owner' && targetRole === 'client_owner') {
      return c.json({ error: 'No puedes invitar otro owner' }, 403)
    }

    const data = await createInvitation({
      email, fullName: full_name, role: targetRole, companyId, invitedBy: inviterId,
    })
    return c.json(data, 201)
  },
)

// DELETE /api/companies/:id/members/:userId — desactivar miembro
app.delete('/:id/members/:userId',
  requireOwnCompany('id'),
  requirePermission('companies', 'delete'),
  async (c) => {
    const data = await CompaniesService.deactivateMember(
      c.req.param('id')!,
      c.req.param('userId')!,
    )
    return c.json(data)
  },
)

// GET /api/companies/:id/services
app.get('/:id/services', requireOwnCompany('id'), async (c) => {
  const data = await CompaniesService.getServices(c.req.param('id')!)
  return c.json(data)
})

export const companiesRoutes = app
