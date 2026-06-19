import { supabase } from './supabase.js'
import { logger }   from './logger.js'
import type { Context } from 'hono'
import type { AuthUser } from '../middleware/auth.js'

export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'login'  | 'logout'
  | 'invite' | 'accept_invitation'
  | 'approve' | 'reject'
  | 'upload'  | 'download'
  | 'send_campaign' | 'generate_tasks'

export interface AuditEntry {
  action:      AuditAction
  resource:    string
  resource_id?: string
  metadata?:   Record<string, unknown>
  user?:       AuthUser
  c?:          Context   // para extraer ip y user_agent automáticamente
}

export async function audit(entry: AuditEntry): Promise<void> {
  const { action, resource, resource_id, metadata, user, c } = entry

  const ip = c
    ? (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null)
    : null

  const userAgent = c ? (c.req.header('user-agent') ?? null) : null

  const { error } = await supabase.from('audit_logs').insert({
    user_id:    user?.id    ?? null,
    user_role:  user?.role  ?? null,
    company_id: user?.companyId ?? null,
    action,
    resource,
    resource_id: resource_id ?? null,
    metadata:   metadata ?? null,
    ip_address: ip,
    user_agent: userAgent,
  })

  if (error) {
    // El audit log nunca debe interrumpir el flujo principal
    logger.warn({ err: error.message, action, resource }, 'Audit log falló')
  }
}

// Fire-and-forget — no bloquea la respuesta
export function auditAsync(entry: AuditEntry): void {
  void audit(entry)
}
