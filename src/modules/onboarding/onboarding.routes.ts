import { Hono, type Context, type Next } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { zValidator }    from '@hono/zod-validator'
import { authMiddleware }    from '../../middleware/auth.js'
import { requireModule }     from '../../middleware/requireRole.js'
import { requireRole, requirePermission } from '../../middleware/requireRole.js'
import { EDITABLE_DRAFT_STATUSES, OnboardingService } from './onboarding.service.js'
import { DocumentsService }  from '../documents/documents.service.js'
import { supabase }          from '../../lib/supabase.js'
import { createInvitation } from '../invitations/invitations.service.js'
import {
  createOnboardingSchema,
  updateOnboardingSchema,
  selectServicesSchema,
  acceptPoliciesSchema,
  uploadKycDocSchema,
  reviewKycDocSchema,
  listOnboardingQuerySchema,
  rejectOnboardingSchema,
} from './onboarding.schema.js'

const app = new Hono()

function draftSignature(id: string, expiresAt: string) {
  return createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY!)
    .update(`finto:onboarding:draft:v1:${id}:${expiresAt}`).digest()
}

async function requireDraft(c: Context, next: Next) {
  const id = c.req.param('id')!
  const credential = c.req.header('Authorization')?.match(/^Onboarding (\d{13})\.([0-9a-f]{64})$/)
  if (!credential || Number(credential[1]) <= Date.now() ||
      !timingSafeEqual(draftSignature(id, credential[1]!), Buffer.from(credential[2]!, 'hex'))) {
    return c.json({ error: 'Credencial de registro inválida o expirada' }, 403)
  }

  const { data, error } = await supabase.from('client_onboardings').select('id')
    .eq('id', id).in('status', EDITABLE_DRAFT_STATUSES).maybeSingle()
  if (error) throw error
  if (!data) return c.json({ error: 'Este expediente ya no se puede editar desde el formulario' }, 409)
  await next()
}

// ── Rutas públicas (sin auth) ─────────────────────────────────────────────────

// POST /api/onboarding — crear borrador (formulario público)
app.post('/',
  zValidator('json', createOnboardingSchema),
  async (c) => {
    const data = await OnboardingService.create(c.req.valid('json'))
    const expiresAt = String(Date.now() + 24 * 60 * 60 * 1000)
    c.header('Cache-Control', 'no-store')
    return c.json({ ...data, draft_token: `${expiresAt}.${draftSignature(data.id, expiresAt).toString('hex')}` }, 201)
  },
)

// ── Rutas autenticadas ────────────────────────────────────────────────────────

// GET /api/onboarding — listar (rs_admin/admin)
app.get('/',
  authMiddleware,
  requireModule('onboarding'),
  zValidator('query', listOnboardingQuerySchema),
  async (c) => {
    const { id } = c.get('user')
    const result = await OnboardingService.list(c.req.valid('query'), id)
    return c.json(result)
  },
)

// GET /api/onboarding/:id — detalle
app.get('/:id', authMiddleware, requireModule('onboarding'), async (c) => {
    const data = await OnboardingService.getById(c.req.param('id')!)
    return c.json(data)
  },
)

// PATCH /api/onboarding/:id — actualizar borrador
app.patch('/:id',
  authMiddleware,
  requireModule('onboarding'),
  requirePermission('onboarding', 'update'),
  zValidator('json', updateOnboardingSchema),
  async (c) => {
    const data = await OnboardingService.update(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/services — seleccionar servicios
app.post('/:id/services',
  requireDraft,
  zValidator('json', selectServicesSchema),
  async (c) => {
    const data = await OnboardingService.selectServices(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/policies — aceptar políticas
app.post('/:id/policies',
  requireDraft,
  zValidator('json', acceptPoliciesSchema),
  async (c) => {
    const data = await OnboardingService.acceptPolicies(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/kyc/documents — subir archivo KYC (multipart)
app.post('/:id/kyc/documents', requireDraft, async (c) => {
  const onboardingId = c.req.param('id')!
  const contentType    = c.req.header('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    const body     = await c.req.parseBody()
    const file     = body['file']
    const docType  = uploadKycDocSchema.shape.doc_type.safeParse(body['doc_type'])

    if (!(file instanceof File)) return c.json({ error: 'Se requiere un archivo en el campo "file"' }, 400)
    if (!docType.success) return c.json({ error: 'Tipo de documento inválido' }, 400)

    const MAX_SIZE = 10 * 1024 * 1024  // 10 MB
    if (file.size > MAX_SIZE) return c.json({ error: 'El archivo supera el límite de 10 MB' }, 413)

    const { storagePath, fileUrl } = await DocumentsService.uploadKycFile(file, onboardingId)

    const parsed = uploadKycDocSchema.safeParse({
      doc_type:      docType.data,
      storage_path:  storagePath,
      file_url:      fileUrl,
      original_name: file.name,
      mime_type:     file.type || undefined,
      size_bytes:    file.size,
    })
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

    const data = await OnboardingService.uploadKycDoc(onboardingId, parsed.data)
    return c.json(data, 201)
  }

  return c.json({ error: 'Se requiere multipart/form-data con el archivo' }, 415)
})

// PATCH /api/onboarding/:id/kyc/documents/:docId — verificar/rechazar doc
app.patch('/:id/kyc/documents/:docId',
  authMiddleware,
  requireRole('rs_admin', 'admin'),
  requirePermission('onboarding', 'update'),
  zValidator('json', reviewKycDocSchema),
  async (c) => {
    const { id: userId } = c.get('user')
    const data = await OnboardingService.reviewKycDoc(
      c.req.param('docId')!,
      c.req.valid('json'),
      userId,
    )
    return c.json(data)
  },
)

// GET /api/onboarding/:id/kyc/documents/:docId/url — URL firmada para preview
app.get('/:id/kyc/documents/:docId/url',
  authMiddleware,
  requireRole('rs_admin', 'admin'),
  async (c) => {
    const { supabase } = await import('../../lib/supabase.js')
    const docId = c.req.param('docId')!

    const { data: doc, error } = await supabase
      .from('kyc_documents')
      .select('storage_path')
      .eq('id', docId)
      .single()

    if (error || !doc) return c.json({ error: 'Documento no encontrado' }, 404)

    const { data: urlData, error: urlErr } = await supabase.storage
      .from('kyc-documents')
      .createSignedUrl(doc.storage_path, 3600)

    if (urlErr) return c.json({ error: 'Error generando URL' }, 500)
    return c.json({ url: urlData.signedUrl })
  },
)

// POST /api/onboarding/:id/submit — enviar a revisión
app.post('/:id/submit', requireDraft, async (c) => {
  const data = await OnboardingService.submit(c.req.param('id')!)
  return c.json(data)
})

// POST /api/onboarding/:id/approve — solo rs_admin y admin
app.post('/:id/approve',
  authMiddleware,
  requireRole('rs_admin', 'admin'),
  requirePermission('onboarding', 'update'),
  async (c) => {
    const { id: userId } = c.get('user')
    const data = await OnboardingService.approve(c.req.param('id')!, userId)
    return c.json(data)
  },
)

// POST /api/onboarding/:id/reject — solo rs_admin y admin
app.post('/:id/reject',
  authMiddleware,
  requireRole('rs_admin', 'admin'),
  requirePermission('onboarding', 'update'),
  zValidator('json', rejectOnboardingSchema),
  async (c) => {
    const { id: userId } = c.get('user')
    const data = await OnboardingService.reject(c.req.param('id')!, userId, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/request-correction — solo rs_admin y admin
app.post('/:id/request-correction',
  authMiddleware,
  requireRole('rs_admin', 'admin'),
  requirePermission('onboarding', 'update'),
  async (c) => {
    const { id: userId } = c.get('user')
    const { notes } = await c.req.json<{ notes: string }>()
    const data = await OnboardingService.requestCorrection(c.req.param('id')!, userId, notes)
    return c.json(data)
  },
)

// POST /api/onboarding/:id/resend-invitation — reenviar invitación
app.post('/:id/resend-invitation',
  authMiddleware,
  requireRole('rs_admin', 'admin'),
  requirePermission('onboarding', 'update'),
  async (c) => {
    const onboardingId = c.req.param('id')!

    const ob = await OnboardingService.getById(onboardingId)
    if (!ob) return c.json({ error: 'Onboarding no encontrado' }, 404)

    if (ob.status !== 'approved' || !ob.company_id) {
      return c.json({ error: 'El expediente debe estar aprobado y vinculado a una empresa' }, 409)
    }
    await createInvitation({
      email: ob.rep_email, fullName: ob.rep_name, role: 'client_owner',
      companyId: ob.company_id, invitedBy: c.get('user').id, fromOnboarding: true,
    })
    return c.json({ ok: true, email: ob.rep_email })
  },
)

export const onboardingRoutes = app
