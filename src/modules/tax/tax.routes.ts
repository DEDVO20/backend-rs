import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule, requireRole, requirePermission } from '../../middleware/requireRole.js'
import { TaxService } from './tax.service.js'
import {
  createTaxProfileSchema, updateTaxProfileSchema,
  updateSettingsSchema, matrixQuerySchema, computeSchema,
} from './tax.schema.js'

const app = new Hono()

// Perfiles tributarios y terceros comparten dominio → autoriza con 'participations'.
app.use('/*', authMiddleware, requireModule('participations'))

// ── Parámetros de la operación ───────────────────────────────────────────────
app.get('/settings', async (c) => c.json(await TaxService.getSettings()))

app.patch('/settings',
  requireRole('admin', 'rs_admin'),
  requirePermission('participations', 'update'),
  zValidator('json', updateSettingsSchema),
  async (c) => c.json(await TaxService.updateSettings(c.req.valid('json'))),
)

// ── Matriz comparativa (spec §8) ─────────────────────────────────────────────
app.get('/matrix',
  zValidator('query', matrixQuerySchema),
  async (c) => c.json(await TaxService.matrix(c.req.valid('query').invoice_value)),
)

// ── Catálogo de perfiles tributarios ─────────────────────────────────────────
app.get('/profiles', async (c) => {
  const includeInactive = c.req.query('all') === 'true'
  return c.json(await TaxService.listProfiles(includeInactive))
})

app.get('/profiles/:id', async (c) => c.json(await TaxService.getProfile(c.req.param('id')!)))

app.post('/profiles',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  requirePermission('participations', 'create'),
  zValidator('json', createTaxProfileSchema),
  async (c) => c.json(await TaxService.createProfile(c.req.valid('json')), 201),
)

app.patch('/profiles/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  requirePermission('participations', 'update'),
  zValidator('json', updateTaxProfileSchema),
  async (c) => c.json(await TaxService.updateProfile(c.req.param('id')!, c.req.valid('json'))),
)

// Borrado real del perfil. Los terceros que lo tuvieran quedan sin perfil (FK SET NULL).
app.delete('/profiles/:id',
  requireRole('admin', 'rs_admin'),
  requirePermission('participations', 'delete'),
  async (c) => c.json(await TaxService.deleteProfile(c.req.param('id')!)),
)

// ── Cálculo de una operación (por tercero o por perfil) ──────────────────────
app.post('/compute',
  zValidator('json', computeSchema),
  async (c) => c.json(await TaxService.compute(c.req.valid('json'))),
)

export const taxRoutes = app
