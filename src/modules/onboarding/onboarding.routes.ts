import { Hono }          from 'hono'
import { zValidator }    from '@hono/zod-validator'
import { authMiddleware }    from '../../middleware/auth.js'
import { requireModule }     from '../../middleware/requireRole.js'
import { requireRole }       from '../../middleware/requireRole.js'
import { OnboardingService } from './onboarding.service.js'
import { DocumentsService }  from '../documents/documents.service.js'
import { supabase }          from '../../lib/supabase.js'
import { logger }            from '../../lib/logger.js'
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

// ── Rutas públicas (sin auth) ─────────────────────────────────────────────────

// POST /api/onboarding — crear borrador (formulario público)
app.post('/',
  zValidator('json', createOnboardingSchema),
  async (c) => {
    const data = await OnboardingService.create(c.req.valid('json'))
    return c.json(data, 201)
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
app.get('/:id', async (c) => {
    const data = await OnboardingService.getById(c.req.param('id')!)
    return c.json(data)
  },
)

// PATCH /api/onboarding/:id — actualizar borrador
app.patch('/:id',
  zValidator('json', updateOnboardingSchema),
  async (c) => {
    const data = await OnboardingService.update(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/services — seleccionar servicios
app.post('/:id/services',
  zValidator('json', selectServicesSchema),
  async (c) => {
    const data = await OnboardingService.selectServices(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/policies — aceptar políticas
app.post('/:id/policies',
  zValidator('json', acceptPoliciesSchema),
  async (c) => {
    const data = await OnboardingService.acceptPolicies(c.req.param('id')!, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/kyc/documents — subir archivo KYC (multipart) o registrar metadata (json)
app.post('/:id/kyc/documents', async (c) => {
  const userId       = c.get('user')?.id   // puede ser undefined si la ruta es pública
  const onboardingId = c.req.param('id')!
  const contentType    = c.req.header('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    const body     = await c.req.parseBody()
    const file     = body['file']
    const docType  = body['doc_type'] as string | undefined

    if (!(file instanceof File)) return c.json({ error: 'Se requiere un archivo en el campo "file"' }, 400)
    if (!docType)                return c.json({ error: 'El campo "doc_type" es requerido' }, 400)

    const MAX_SIZE = 10 * 1024 * 1024  // 10 MB
    if (file.size > MAX_SIZE) return c.json({ error: 'El archivo supera el límite de 10 MB' }, 413)

    const { storagePath, fileUrl } = await DocumentsService.uploadKycFile(file, onboardingId)

    const parsed = uploadKycDocSchema.safeParse({
      doc_type:      docType,
      storage_path:  storagePath,
      file_url:      fileUrl,
      original_name: file.name,
      mime_type:     file.type || undefined,
      size_bytes:    file.size,
    })
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

    const data = await OnboardingService.uploadKycDoc(onboardingId, parsed.data, userId)
    return c.json(data, 201)
  }

  // Fallback JSON — metadata de archivo ya subido directamente a Storage
  const json = await c.req.json()
  const parsed = uploadKycDocSchema.safeParse(json)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const data = await OnboardingService.uploadKycDoc(onboardingId, parsed.data, userId)
  return c.json(data, 201)
})

// PATCH /api/onboarding/:id/kyc/documents/:docId — verificar/rechazar doc
app.patch('/:id/kyc/documents/:docId',
  authMiddleware,
  requireRole('rs_admin', 'admin'),
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
app.post('/:id/submit', async (c) => {
  const data = await OnboardingService.submit(c.req.param('id')!)
  return c.json(data)
})

// POST /api/onboarding/:id/approve — solo rs_admin y admin
app.post('/:id/approve',
  requireRole('rs_admin', 'admin'),
  async (c) => {
    const { id: userId } = c.get('user')
    const data = await OnboardingService.approve(c.req.param('id')!, userId)
    return c.json(data)
  },
)

// POST /api/onboarding/:id/reject — solo rs_admin y admin
app.post('/:id/reject',
  requireRole('rs_admin', 'admin'),
  zValidator('json', rejectOnboardingSchema),
  async (c) => {
    const { id: userId } = c.get('user')
    const data = await OnboardingService.reject(c.req.param('id')!, userId, c.req.valid('json'))
    return c.json(data)
  },
)

// POST /api/onboarding/:id/request-correction — solo rs_admin y admin
app.post('/:id/request-correction',
  requireRole('rs_admin', 'admin'),
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
  async (c) => {
    const onboardingId = c.req.param('id')!

    const ob = await OnboardingService.getById(onboardingId)
    if (!ob) return c.json({ error: 'Onboarding no encontrado' }, 404)

    // Invalidar invitaciones anteriores
    await supabase
      .from('company_invitations')
      .update({ status: 'cancelled' })
      .eq('email', ob.rep_email.toLowerCase().trim())
      .eq('status', 'pending')

    // Crear nueva invitación
    const token = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    await supabase.from('company_invitations').insert({
      email:      ob.rep_email.toLowerCase().trim(),
      full_name:  ob.rep_name,
      role:       'client_owner',
      company_id: ob.company_id ?? null,
      token,
      status:     'pending',
      expires_at: expiresAt,
    })

    const { NotificationService } = await import('../../notifications/NotificationService.js')
    const platformUrl = process.env.PLATFORM_URL ?? 'https://app.tudominio.com'

    void NotificationService.enqueue({
      channel:  'email',
      template: 'kyc-approved',
      to:       ob.rep_email,
      data: {
        ownerName:   ob.rep_name,
        companyName: ob.company_name,
        platformUrl: `${platformUrl}/invitations/accept?token=${token}`,
      },
    })

    logger.info({ onboardingId, email: ob.rep_email }, 'Invitación reenviada')
    return c.json({ ok: true, email: ob.rep_email })
  },
)

export const onboardingRoutes = app
