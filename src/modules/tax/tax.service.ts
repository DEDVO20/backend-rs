import { supabase } from '../../lib/supabase.js'
import {
  computeOperation, money,
  type TaxProfile, type WithholdingAgent, type OperationSettings, type OperationResult,
} from './tax.domain.js'
import type { z } from 'zod'
import type {
  createTaxProfileSchema, updateTaxProfileSchema, updateSettingsSchema, computeSchema,
} from './tax.schema.js'

type CreateProfileInput = z.infer<typeof createTaxProfileSchema>
type UpdateProfileInput = z.infer<typeof updateTaxProfileSchema>
type SettingsUpdate     = z.infer<typeof updateSettingsSchema>
type ComputeInput       = z.infer<typeof computeSchema>

// Fila del catálogo de perfiles tributarios (snake_case desde la BD).
interface TaxProfileRow {
  id: string
  name: string
  description: string | null
  tax_regime: 'ORDINARY' | 'SIMPLE'
  iva_responsible: boolean
  grand_taxpayer: boolean
  self_withholder: boolean
  subject_income_withholding: boolean
  subject_ica_withholding: boolean
  subject_iva_withholding: boolean
  agent_income_withholding: boolean
  agent_ica_withholding: boolean
  agent_iva_withholding: boolean
  iva_rate: number | null
  income_withholding_rate: number | null
  ica_withholding_rate: number | null
  iva_withholding_rate: number | null
  active: boolean
}

interface SettingsRow {
  id: number
  iva_rate: number
  income_withholding_rate: number
  ica_withholding_rate: number
  iva_withholding_rate: number
  commission_rate: number
  commission_iva_rate: number
  default_invoice_value: number
}

/** Mapea la fila del catálogo al perfil que consume el motor puro (spec §2). */
function rowToProfile(row: TaxProfileRow): TaxProfile {
  return {
    personType:     'JURIDICA',   // el tipo de persona es del tercero, no del perfil
    taxRegime:      row.tax_regime,
    ivaResponsible: row.iva_responsible,
    grandTaxpayer:  row.grand_taxpayer,
    ivaRate:        row.iva_rate,
    incomeWithholding: { subject: row.subject_income_withholding, rate: row.income_withholding_rate ?? undefined },
    icaWithholding:    { subject: row.subject_ica_withholding,    rate: row.ica_withholding_rate ?? undefined },
    ivaWithholding:    { subject: row.subject_iva_withholding,    rate: row.iva_withholding_rate ?? undefined },
    // Agente retenedor: gobierna las retenciones sobre la comisión.
    agentIncomeWithholding: row.agent_income_withholding,
    agentIcaWithholding:    row.agent_ica_withholding,
  }
}

function rowToSettings(row: SettingsRow): OperationSettings {
  return {
    ivaRate:               row.iva_rate,
    incomeWithholdingRate: row.income_withholding_rate,
    icaWithholdingRate:    row.ica_withholding_rate,
    ivaWithholdingRate:    row.iva_withholding_rate,
    commissionRate:        row.commission_rate,
    commissionIvaRate:     row.commission_iva_rate,
  }
}

export class TaxService {

  // ── Parámetros de la operación ─────────────────────────────────────────────
  static async getSettings(): Promise<SettingsRow> {
    const { data, error } = await supabase
      .from('tax_operation_settings').select('*').eq('id', 1).single()
    if (error) throw error
    return data as SettingsRow
  }

  static async updateSettings(input: SettingsUpdate): Promise<SettingsRow> {
    const { data, error } = await supabase
      .from('tax_operation_settings')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', 1).select().single()
    if (error) throw error
    return data as SettingsRow
  }

  // ── Catálogo de perfiles tributarios ───────────────────────────────────────
  static async listProfiles(includeInactive = false): Promise<TaxProfileRow[]> {
    let q = supabase.from('tax_profiles').select('*').order('name')
    if (!includeInactive) q = q.eq('active', true)
    const { data, error } = await q
    if (error) throw error
    return (data ?? []) as TaxProfileRow[]
  }

  static async getProfile(id: string): Promise<TaxProfileRow> {
    const { data, error } = await supabase
      .from('tax_profiles').select('*').eq('id', id).single()
    if (error) throw error
    return data as TaxProfileRow
  }

  static async createProfile(input: CreateProfileInput): Promise<TaxProfileRow> {
    const { data, error } = await supabase
      .from('tax_profiles').insert(input).select().single()
    if (error) throw error
    return data as TaxProfileRow
  }

  static async updateProfile(id: string, input: UpdateProfileInput): Promise<TaxProfileRow> {
    const { data, error } = await supabase
      .from('tax_profiles')
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq('id', id).select().single()
    if (error) throw error
    return data as TaxProfileRow
  }

  // Baja lógica: conserva el perfil pero lo oculta del catálogo activo.
  static async deactivateProfile(id: string): Promise<TaxProfileRow> {
    return TaxService.updateProfile(id, { active: false })
  }

  // Borrado real. La FK third_parties.tax_profile_id es ON DELETE SET NULL:
  // los terceros que lo tuvieran quedan sin perfil asignado (no se borran).
  static async deleteProfile(id: string): Promise<{ ok: true; unassigned: number }> {
    const { count } = await supabase
      .from('third_parties')
      .select('id', { count: 'exact', head: true })
      .eq('tax_profile_id', id)
    const { error } = await supabase.from('tax_profiles').delete().eq('id', id)
    if (error) throw error
    return { ok: true, unassigned: count ?? 0 }
  }

  // ── Perfil efectivo de un tercero (a través de su tax_profile_id) ──────────
  static async getProfileForThirdParty(thirdPartyId: string): Promise<TaxProfileRow> {
    const { data: tp, error } = await supabase
      .from('third_parties').select('tax_profile_id, name').eq('id', thirdPartyId).single()
    if (error) throw error
    if (!tp?.tax_profile_id) {
      const err: any = new Error('El tercero no tiene un perfil tributario asignado')
      err.statusCode = 400
      throw err
    }
    return TaxService.getProfile(tp.tax_profile_id as string)
  }

  // ── Cálculo de una operación ───────────────────────────────────────────────
  static async compute(input: ComputeInput): Promise<{ profile: TaxProfileRow; result: OperationResult }> {
    const [row, settings] = await Promise.all([
      input.tax_profile_id
        ? TaxService.getProfile(input.tax_profile_id)
        : TaxService.getProfileForThirdParty(input.third_party_id!),
      TaxService.getSettings(),
    ])
    const receiver: WithholdingAgent = input.receiver ?? {
      incomeWithholdingAgent: true, icaWithholdingAgent: true, ivaWithholdingAgent: true,
    }
    const result = computeOperation({
      invoiceValue: input.invoice_value,
      emitter:  rowToProfile(row),
      receiver,
      settings: rowToSettings(settings),
    })
    return { profile: row, result }
  }

  // ── Matriz comparativa del catálogo de perfiles (spec §8) ──────────────────
  static async matrix(invoiceValue?: number) {
    const [rows, settings] = await Promise.all([
      TaxService.listProfiles(false),
      TaxService.getSettings(),
    ])
    const value = invoiceValue ?? money(settings.default_invoice_value)
    // Receptor = agente de todas las retenciones (escenario de la matriz, spec §8).
    const receiver: WithholdingAgent = {
      incomeWithholdingAgent: true, icaWithholdingAgent: true, ivaWithholdingAgent: true,
    }
    const opSettings = rowToSettings(settings)

    const columns = rows.map(row => ({
      id:   row.id,
      name: row.name,
      profile: {
        taxRegime:      row.tax_regime,
        ivaResponsible: row.iva_responsible,
        grandTaxpayer:  row.grand_taxpayer,
        selfWithholder: row.self_withholder,
      },
      result: computeOperation({
        invoiceValue: value, emitter: rowToProfile(row), receiver, settings: opSettings,
      }),
    }))

    return { invoiceValue: value, settings, columns }
  }
}
