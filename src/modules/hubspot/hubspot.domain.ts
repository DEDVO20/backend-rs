/**
 * CRM (HubSpot) — conversión de negocios (deals) a filas para las gráficas.
 * Sin dependencias de red ni de base de datos (se prueba de forma aislada).
 */

type Obj = Record<string, any>

/** open: sin propuesta · sent: propuesta enviada · won: ganada/facturada · lost: perdida */
export type StageKind = 'open' | 'sent' | 'won' | 'lost'

export interface StageInfo {
  pipelineId: string
  pipelineLabel: string
  label: string
  order: number
  kind: StageKind
}

export interface DealRow {
  deal_id: string
  name: string
  amount: number
  pipeline_id: string
  pipeline_label: string
  stage_id: string
  stage_label: string
  stage_order: number
  stage_kind: StageKind
  owner_id: string
  owner_name: string
  close_date: string | null
  create_date: string | null
}

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Tipo de etapa por su nombre (las etapas de cada portal son personalizadas) y, si el nombre
 * no lo dice, por los metadatos de HubSpot (etapa cerrada con probabilidad 1 = ganada, 0 = perdida).
 * Ej. RAD: Posible cliente (open) · Propuesta enviada (sent) · Propuesta ganada, Facturado cerrado,
 * Facturación recurrente (won) · Cierre perdido (lost).
 */
export function stageKind(label: string, metadata: Obj = {}): StageKind {
  const t = norm(label)
  const closed = String(metadata.isClosed ?? '') === 'true'
  const probability = Number(metadata.probability)

  if (/perdid|lost|descartad|rechazad|cancelad/.test(t)) return 'lost'
  if (/ganad|won|factura|recurrent/.test(t)) return 'won'
  if (closed && probability === 0) return 'lost'
  if (closed && probability === 1) return 'won'
  if (/enviad|sent|propuesta|cotizacion|negociacion/.test(t)) return 'sent'
  return 'open'
}

/** Mapa id de etapa → datos, a partir de /crm/v3/pipelines/deals */
export function stagesFromPipelines(pipelines: Obj[]): Map<string, StageInfo> {
  const out = new Map<string, StageInfo>()
  for (const p of pipelines) {
    for (const s of Array.isArray(p.stages) ? p.stages : []) {
      out.set(String(s.id), {
        pipelineId:    String(p.id ?? ''),
        pipelineLabel: String(p.label ?? ''),
        label:         String(s.label ?? s.id),
        order:         Number(s.displayOrder ?? 0),
        kind:          stageKind(s.label, s.metadata),
      })
    }
  }
  return out
}

export function ownerName(o: Obj): string {
  return [o.firstName, o.lastName].map(x => String(x ?? '').trim()).filter(Boolean).join(' ') || String(o.email ?? '').trim()
}

/** Fecha ISO (YYYY-MM-DD) de una propiedad de HubSpot (ISO o milisegundos) */
export function hubspotDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v)
  const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** Fila de un negocio. El valor es el de la moneda de la empresa (amount_in_home_currency) si existe */
export function toDealRow(deal: Obj, stages: Map<string, StageInfo>, owners: Map<string, string>): DealRow {
  const p = deal.properties ?? {}
  const stageId = String(p.dealstage ?? '')
  const stage = stages.get(stageId)
  const amount = Number(p.amount_in_home_currency ?? p.amount ?? 0)
  const ownerId = String(p.hubspot_owner_id ?? '')

  return {
    deal_id:        String(deal.id),
    name:           String(p.dealname ?? ''),
    amount:         Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0,
    pipeline_id:    String(p.pipeline ?? stage?.pipelineId ?? ''),
    pipeline_label: stage?.pipelineLabel ?? '',
    stage_id:       stageId,
    stage_label:    stage?.label ?? stageId,
    stage_order:    stage?.order ?? 999,
    stage_kind:     stage?.kind ?? 'open',
    owner_id:       ownerId,
    owner_name:     ownerId ? owners.get(ownerId) ?? '' : '',
    close_date:     hubspotDate(p.closedate),
    create_date:    hubspotDate(p.createdate),
  }
}
