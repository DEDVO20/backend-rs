import { describe, it, expect } from 'vitest'
import { hubspotDate, ownerName, stageKind, stagesFromPipelines, toDealRow } from '../src/modules/hubspot/hubspot.domain.js'

describe('stageKind', () => {
  it('clasifica las etapas de RAD por su nombre', () => {
    expect(stageKind('Posible cliente')).toBe('open')
    expect(stageKind('Propuesta Enviada')).toBe('sent')
    expect(stageKind('Propuesta ganada')).toBe('won')
    expect(stageKind('Facturado Cerrado')).toBe('won')
    expect(stageKind('Facturación recurrente')).toBe('won')
    expect(stageKind('Cierre perdido')).toBe('lost')
  })

  it('usa los metadatos de HubSpot cuando el nombre no lo dice', () => {
    expect(stageKind('Cerrado', { isClosed: 'true', probability: '1.0' })).toBe('won')
    expect(stageKind('Archivado', { isClosed: 'true', probability: '0.0' })).toBe('lost')
    expect(stageKind('Reunión', { isClosed: 'false', probability: '0.4' })).toBe('open')
  })
})

describe('toDealRow', () => {
  const stages = stagesFromPipelines([{
    id: 'default', label: 'Ventas',
    stages: [
      { id: 's1', label: 'Propuesta Enviada', displayOrder: 3, metadata: { isClosed: 'false', probability: '0.5' } },
      { id: 's2', label: 'Propuesta ganada', displayOrder: 1, metadata: { isClosed: 'true', probability: '1.0' } },
    ],
  }])
  const owners = new Map([['77', ownerName({ firstName: 'Jeison', lastName: 'Larrota' })]])

  it('toma etapa, socio, valor en moneda de la empresa y fechas', () => {
    const row = toDealRow({
      id: '123',
      properties: {
        dealname: 'Asesoría', amount: '1000', amount_in_home_currency: '1500000', dealstage: 's2',
        pipeline: 'default', closedate: '2026-10-15T17:00:00.000Z', createdate: '2026-09-01T10:00:00Z', hubspot_owner_id: '77',
      },
    }, stages, owners)
    expect(row).toMatchObject({
      deal_id: '123', amount: 1_500_000, stage_label: 'Propuesta ganada', stage_order: 1, stage_kind: 'won',
      owner_name: 'Jeison Larrota', close_date: '2026-10-15', create_date: '2026-09-01', pipeline_label: 'Ventas',
    })
  })

  it('sin etapa conocida ni socio queda abierto y sin nombre', () => {
    const row = toDealRow({ id: '9', properties: { dealstage: 'x', amount: null } }, stages, owners)
    expect(row).toMatchObject({ stage_kind: 'open', stage_label: 'x', owner_name: '', amount: 0, close_date: null })
  })

  it('acepta fechas en milisegundos', () => {
    expect(hubspotDate('1760547600000')).toBe('2025-10-15')
    expect(hubspotDate('')).toBeNull()
  })
})
