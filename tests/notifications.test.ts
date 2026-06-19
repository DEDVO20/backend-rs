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

  it('sendCampaign() llama sendBroadcast() solo con contactos que tienen teléfono', async () => {
    const mockCampaign = {
      id:                   'camp_001',
      name:                 'Campaña Junio',
      channel:              'whatsapp',
      company_id:           'comp_001',
      collection_templates: {},
      collection_debtors:   [
        { id: 'd1', debtor_name: 'Juan', phone: '+573001111111', whatsapp: null },
        { id: 'd2', debtor_name: 'Sin Tel', phone: null, whatsapp: null },
      ],
    }

    const { supabase } = await import('../src/lib/supabase.js')
    const campaignChain: any = {
      select: () => campaignChain,
      eq:     () => campaignChain,
      single: () => Promise.resolve({ data: mockCampaign, error: null }),
      update: () => campaignChain,
    }
    ;(supabase.from as any) = () => campaignChain

    const result = await CollectionService.sendCampaign('camp_001')

    expect(NotificationService.sendBroadcast).toHaveBeenCalledOnce()

    const [call] = vi.mocked(NotificationService.sendBroadcast).mock.calls
    expect(call[0].channel).toBe('whatsapp')
    expect(call[0].template).toBe('collection-reminder')
    expect(call[0].contacts).toHaveLength(1)
    expect(call[0].contacts[0].to).toBe('+573001111111')
    expect(result.sent).toBe(1)
  })
})
