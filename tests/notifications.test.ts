import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger antes de cualquier import que lo use
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// ── Mocks globales ────────────────────────────────────────────────────────────

// Datos de retorno por defecto para el mock de supabase
const mockOnboarding = {
  id:               'onb_001',
  rep_email:        'owner@empresa.com',
  rep_name:         'María García',
  company_name:     'Empresa S.A.S',
  company_id:       'comp_001',
  status:           'approved',
  reviewed_by:      'reviewer_001',
  reviewed_at:      new Date().toISOString(),
  rejection_reason: null,
  review_notes:     null,
}

// Cadena fluente de supabase que siempre resuelve con mockOnboarding
const makeChain = (resolved: unknown = mockOnboarding) => {
  const c: any = {}
  const methods = ['select','insert','update','eq','single','range','order','ilike','or','rpc']
  methods.forEach(m => {
    c[m] = () => c
  })
  c.single = () => Promise.resolve({ data: resolved, error: null })
  return c
}

vi.mock('../src/lib/supabase.js', () => ({
  supabase: { from: () => makeChain(), rpc: () => Promise.resolve({ data: { ok: true, token: 'tok_test' }, error: null }) },
}))

vi.mock('../src/notifications/NotificationService.js', () => ({
  NotificationService: {
    enqueue:       vi.fn().mockResolvedValue(undefined),
    sendBroadcast: vi.fn().mockResolvedValue('broadcast_123'),
    dispatch:      vi.fn().mockResolvedValue(undefined),
    sendNow:       vi.fn().mockResolvedValue(undefined),
  },
}))

import { NotificationService } from '../src/notifications/NotificationService.js'
import { OnboardingService }   from '../src/modules/onboarding/onboarding.service.js'
import { RequestsService }     from '../src/modules/operational-requests/requests.service.js'
import { CollectionService }   from '../src/modules/collection/collection.service.js'

// ── Onboarding ────────────────────────────────────────────────────────────────

describe('Notificaciones — onboarding', () => {
  beforeEach(() => vi.clearAllMocks())

  it('approve() llama enqueue con template kyc-approved', async () => {
    await OnboardingService.approve('onb_001', 'reviewer_001')

    expect(NotificationService.enqueue).toHaveBeenCalledOnce()
    expect(NotificationService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel:  'email',
        template: 'kyc-approved',
        to:       mockOnboarding.rep_email,
        data:     expect.objectContaining({ companyName: mockOnboarding.company_name }),
      }),
    )
  })

  it('reject() llama enqueue con template kyc-rejected y el motivo correcto', async () => {
    await OnboardingService.reject('onb_001', 'reviewer_001', {
      rejection_reason: 'Documentos incompletos',
    })

    expect(NotificationService.enqueue).toHaveBeenCalledOnce()
    expect(NotificationService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel:  'email',
        template: 'kyc-rejected',
        to:       mockOnboarding.rep_email,
        data:     expect.objectContaining({ reason: 'Documentos incompletos' }),
      }),
    )
  })

  it('requestCorrection() llama enqueue con template kyc-rejected y las notas como reason', async () => {
    await OnboardingService.requestCorrection('onb_001', 'reviewer_001', 'Falta cámara de comercio')

    expect(NotificationService.enqueue).toHaveBeenCalledOnce()
    expect(NotificationService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'kyc-rejected',
        to:       mockOnboarding.rep_email,
        data:     expect.objectContaining({ reason: 'Falta cámara de comercio' }),
      }),
    )
  })
})

// ── Solicitudes operativas ────────────────────────────────────────────────────

describe('Notificaciones — solicitudes operativas', () => {
  const mockRequest = {
    id:                        'req_001',
    company_id:                'comp_001',
    created_by:                { email: 'user@empresa.com' },
    operational_request_types: { name: 'Liquidación nómina' },
    status:                    'resolved',
    completed_at:              new Date().toISOString(),
  }

  beforeEach(() => vi.clearAllMocks())

  it('update() con status resolved llama enqueue con template request-resolved', async () => {
    // Spy que devuelve el request con status resolved
    vi.spyOn(RequestsService, 'getById').mockResolvedValue(mockRequest as any)

    const { supabase } = await import('../src/lib/supabase.js')
    const chain: any = {
      update: () => chain,
      eq:     () => chain,
      select: () => chain,
      single: () => Promise.resolve({ data: mockRequest, error: null }),
    }
    ;(supabase.from as any) = () => chain

    await RequestsService.update('req_001', { status: 'resolved' })

    expect(NotificationService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel:  'email',
        template: 'request-resolved',
        data:     expect.objectContaining({
          ticketId: 'REQ_001',
        }),
      }),
    )
  })
})

// ── Collection ────────────────────────────────────────────────────────────────

describe('Notificaciones — collection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('createAgreement() llama enqueue dos veces cuando el deudor tiene whatsapp y email', async () => {
    vi.spyOn(CollectionService, 'getDebtor').mockResolvedValue({
      id:          'deb_001',
      debtor_name: 'Carlos López',
      phone:       '+573001234567',
      whatsapp:    '+573001234567',
      email:       'carlos@mail.com',
    } as any)

    const { supabase } = await import('../src/lib/supabase.js')
    ;(supabase.from as any) = () => makeChain({
      id: 'agr_001', debtor_id: 'deb_001', company_id: 'comp_001',
    })

    await CollectionService.createAgreement(
      { debtor_id: 'deb_001', type: 'promise', promised_amount: 500000, total_amount: 500000, installment_count: 1 },
      'comp_001',
      'user_001',
    )

    expect(NotificationService.enqueue).toHaveBeenCalledTimes(2)
    const channels = vi.mocked(NotificationService.enqueue).mock.calls.map(([p]) => p.channel)
    expect(channels).toContain('whatsapp')
    expect(channels).toContain('email')
  })

  it('createAgreement() llama enqueue una vez cuando el deudor solo tiene phone y no email', async () => {
    vi.spyOn(CollectionService, 'getDebtor').mockResolvedValue({
      id:          'deb_002',
      debtor_name: 'Ana Torres',
      phone:       '+573009876543',
      whatsapp:    null,
      email:       null,
    } as any)

    const { supabase } = await import('../src/lib/supabase.js')
    ;(supabase.from as any) = () => makeChain({ id: 'agr_002' })

    await CollectionService.createAgreement(
      { debtor_id: 'deb_002', type: 'promise', promised_amount: 200000, total_amount: 200000, installment_count: 1 },
      'comp_001',
      'user_001',
    )

    expect(NotificationService.enqueue).toHaveBeenCalledTimes(1)
    expect(NotificationService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp' }),
    )
  })

  it('sendCampaign() encola mensajes solo para contactos con teléfono', async () => {
    const mockCampaign = {
      id:               'camp_001',
      name:             'Campaña Junio',
      channel:          'whatsapp',
      company_id:       'comp_001',
      created_by:       'user_001',
      debtor_ids:       ['d1', 'd2'],
      message_template: 'Hola {{nombre}}',
    }

    const mockDebtors = [
      { id: 'd1', debtor_name: 'Juan', phone: '+573001111111', whatsapp: null, email: null, collection_debts: [] },
      { id: 'd2', debtor_name: 'Sin Tel', phone: null, whatsapp: null, email: null, collection_debts: [] },
    ]

    const { supabase } = await import('../src/lib/supabase.js')
    const chain: any = {
      select: () => chain,
      eq:     () => chain,
      in:     () => chain,
      single: () => Promise.resolve({ data: mockCampaign, error: null }),
      update: () => chain,
      insert: () => Promise.resolve({ data: null, error: null }),
      then:   (fn: any) => Promise.resolve({ data: mockDebtors, error: null }).then(fn),
    }
    const { supabase: sb } = await import('../src/lib/supabase.js')
    ;(sb.from as any) = () => chain

    const result = await CollectionService.sendCampaign('camp_001')

    expect(NotificationService.enqueue).toHaveBeenCalledTimes(1)
    expect(NotificationService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', to: '+573001111111' }),
    )
    expect(result.sent).toBe(1)
  })
})
