import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { apiReference }               from '@scalar/hono-api-reference'
import { errorSchema, paginatedMetaSchema, responses } from '../../lib/openapi.js'

const app = new OpenAPIHono()

// ── Schemas ───────────────────────────────────────────────────────────────────

const tokenResponseSchema = z.object({
  access_token:  z.string(),
  refresh_token: z.string(),
  expires_in:    z.number(),
  user: z.object({ id: z.string().uuid(), email: z.string().email() }),
})

const profileSchema = z.object({
  id:         z.string().uuid(),
  full_name:  z.string().nullable(),
  email:      z.string().email().nullable(),
  role:       z.string(),
  company_id: z.string().uuid().nullable(),
  active:     z.boolean(),
  created_at: z.string(),
})

const companySchema = z.object({
  id:     z.string().uuid(),
  name:   z.string(),
  nit:    z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
})

const taskSchema = z.object({
  id:          z.string().uuid(),
  title:       z.string(),
  description: z.string().nullable(),
  status:      z.string(),
  due_date:    z.string().nullable(),
  company_id:  z.string().uuid().nullable(),
  created_at:  z.string(),
})

const debtorSchema = z.object({
  id:           z.string().uuid(),
  full_name:    z.string(),
  document_id:  z.string().nullable(),
  phone:        z.string().nullable(),
  email:        z.string().nullable(),
  total_debt:   z.number().nullable(),
  status:       z.string(),
  company_id:   z.string().uuid(),
  created_at:   z.string(),
})

const documentSchema = z.object({
  id:            z.string().uuid(),
  title:         z.string(),
  category:      z.string().nullable(),
  file_url:      z.string(),
  original_name: z.string(),
  mime_type:     z.string().nullable(),
  size_bytes:    z.number().nullable(),
  company_id:    z.string().uuid(),
  created_at:    z.string(),
})

// ── Spec JSON + Scalar UI ─────────────────────────────────────────────────────
// Solo se registran las rutas para generar el spec OpenAPI.
// Los handlers son vacíos — las rutas REALES están en sus propios módulos.

app.doc('/openapi.json', (c) => ({
  openapi: '3.1.0',
  info: {
    title:       'Empresa Paola API',
    version:     '1.0.0',
    description: 'API REST — Hono + Supabase + BullMQ + Zavu',
  },
  servers: [
    { url: new URL(c.req.url).origin, description: 'Este servidor' },
    { url: 'https://api.tudominio.com', description: 'Producción' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
}))

app.get('/docs', apiReference({
  theme:  'saturn',
  spec:   { url: '/openapi.json' },
}))

export const docsRoutes = app
