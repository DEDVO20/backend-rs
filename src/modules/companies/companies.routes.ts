import { Hono }         from 'hono'
import { zValidator }   from '@hono/zod-validator'
import { z }            from 'zod'
import { authMiddleware }     from '../../middleware/auth.js'
import { requireModule }      from '../../middleware/requireRole.js'
import { requireRole }        from '../../middleware/requireRole.js'
import { requireOwnCompany }  from '../../middleware/requireRole.js'
import { CompaniesService }   from './companies.service.js'
import {
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
  zValidator('json', updateCompanySchema),
  async (c) => {
    const { role, companyId } = c.get('user')
    const id = c.req.param('id')!
    const isInternal = ['admin', 'rs_admin'].includes(role)

    if (!isInternal) {
      if (role !== 'client_owner' || companyId !== id) {
        return c.json({ error: 'Acceso denegado' }, 403)
      }
    }

    const data = await CompaniesService.update(id, c.req.valid('json'))
    return c.json(data)
  },
)

// GET /api/companies/:id/team
app.get('/:id/team', requireOwnCompany('id'), async (c) => {
  const data = await CompaniesService.getTeam(c.req.param('id')!)
  return c.json(data)
})

// POST /api/companies/:id/invite
const inviteSchema = z.object({
  email: z.string().email(),
  role:  z.enum(['client_owner', 'client_user']),
})

app.post('/:id/invite',
  requireOwnCompany('id'),
  zValidator('json', inviteSchema),
  async (c) => {
    const { id: inviterId, role } = c.get('user')
    const companyId = c.req.param('id')!
    const { email, role: targetRole } = c.req.valid('json')

    // client_owner solo puede invitar client_user
    if (role === 'client_owner' && targetRole === 'client_owner') {
      return c.json({ error: 'No puedes invitar otro owner' }, 403)
    }

    const data = await CompaniesService.inviteUser(companyId, email, targetRole, inviterId)
    return c.json(data)
  },
)

// DELETE /api/companies/:id/members/:userId — desactivar miembro
app.delete('/:id/members/:userId',
  requireOwnCompany('id'),
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
