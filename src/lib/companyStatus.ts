/** Estado de una empresa inactiva (se acepta el valor histórico en español) */
export const INACTIVE_COMPANY_STATUSES = ['inactive', 'inactiva'] as const

export function isCompanyInactive(status: string | null | undefined): boolean {
  return !!status && (INACTIVE_COMPANY_STATUSES as readonly string[]).includes(status)
}

/** Filtro PostgREST para `.not('<tabla>.status', 'in', INACTIVE_IN_FILTER)` */
export const INACTIVE_IN_FILTER = `(${INACTIVE_COMPANY_STATUSES.join(',')})`
