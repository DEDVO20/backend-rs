import { Hono }       from 'hono'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../../middleware/auth.js'
import { requireModule }  from '../../middleware/requireRole.js'
import { requireRole }    from '../../middleware/requireRole.js'
import { DocumentsService } from './documents.service.js'
import {
  listDocumentsQuerySchema,
  createDocumentSchema,
  updateDocumentSchema,
} from './documents.schema.js'

const INTERNAL_ROLES = ['admin', 'rs_admin', 'rs_staff'] as const

const app = new Hono()

app.use('/*', authMiddleware, requireModule('documents'))

// GET /api/documents
app.get('/',
  zValidator('query', listDocumentsQuerySchema),
  async (c) => {
    const { role, companyId } = c.get('user')
    const isInternal = (INTERNAL_ROLES as readonly string[]).includes(role)
    const result = await DocumentsService.list(c.req.valid('query'), companyId, isInternal)
    return c.json(result)
  },
)

// GET /api/documents/:id
app.get('/:id', async (c) => {
  const data = await DocumentsService.getById(c.req.param('id')!)
  return c.json(data)
})

// GET /api/documents/:id/download — URL firmada de Supabase Storage
app.get('/:id/download', async (c) => {
  const doc = await DocumentsService.getById(c.req.param('id')!)
  if (!doc.storage_path) return c.json({ error: 'Documento sin archivo' }, 404)
  const url = await DocumentsService.getSignedUrl(doc.storage_path)
  return c.json({ url })
})

// POST /api/documents/upload — sube archivo a Storage
app.post('/upload',
  async (c) => {
    const { id, companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa asignada' }, 400)

    const body = await c.req.parseBody()
    const file  = body['file']
    const title = body['title'] as string | undefined

    if (!(file instanceof File)) return c.json({ error: 'Se requiere un archivo en el campo "file"' }, 400)
    if (!title)                  return c.json({ error: 'El campo "title" es requerido' }, 400)

    const MAX_SIZE = 20 * 1024 * 1024  // 20 MB
    if (file.size > MAX_SIZE) return c.json({ error: 'El archivo supera el límite de 20 MB' }, 413)

    const meta = {
      title,
      category:    body['category'] as string | undefined,
      description: body['description'] as string | undefined,
    }

    const data = await DocumentsService.upload(file, meta, companyId, id)
    return c.json(data, 201)
  },
)

// POST /api/documents — crear registro con metadata (cuando el archivo ya está en Storage)
app.post('/',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', createDocumentSchema),
  async (c) => {
    const { id, companyId } = c.get('user')
    if (!companyId) return c.json({ error: 'Sin empresa asignada' }, 400)
    const data = await DocumentsService.create(c.req.valid('json'), companyId, id)
    return c.json(data, 201)
  },
)

// PATCH /api/documents/:id
app.patch('/:id',
  requireRole('admin', 'rs_admin', 'rs_staff'),
  zValidator('json', updateDocumentSchema),
  async (c) => {
    const data = await DocumentsService.update(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// DELETE /api/documents/:id — elimina registro y archivo de Storage
app.delete('/:id',
  requireRole('admin', 'rs_admin'),
  async (c) => {
    await DocumentsService.deleteWithFile(c.req.param('id')!)
    return c.json({ ok: true })
  },
)

export const documentsRoutes = app
