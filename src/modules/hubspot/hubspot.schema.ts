import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha esperado: YYYY-MM-DD')

/** Token vacío o ausente = conservar el actual */
export const saveHubspotConnectionBodySchema = z.object({
  token:  z.string().max(500).optional(),
  active: z.boolean().optional(),
})

/**
 * connectionId: libros de Siigo elegidos en las gráficas (internos); define de qué empresa es el HubSpot.
 * companyId: empresa directa (internos). Los clientes siempre ven el de su propia empresa.
 */
export const hubspotReportQuerySchema = z.object({
  connectionId: z.string().uuid().optional(),
  companyId:    z.string().uuid().optional(),
  startDate:    isoDate.optional(),
  endDate:      isoDate.optional(),
})

export const listHubspotDealsQuerySchema = hubspotReportQuerySchema.extend({
  kind:   z.enum(['open', 'sent', 'won', 'lost']).optional(),
  stage:  z.string().max(200).optional(),
  owner:  z.string().max(200).optional(),
  search: z.string().max(100).optional(),
  page:   z.coerce.number().int().positive().default(1),
  limit:  z.coerce.number().int().positive().max(500).default(100),
})

export const hubspotSyncBodySchema = z.object({
  connectionId: z.string().uuid().optional(),
  companyId:    z.string().uuid().optional(),
})

export type SaveHubspotConnectionBody = z.infer<typeof saveHubspotConnectionBodySchema>
export type HubspotReportQuery = z.infer<typeof hubspotReportQuerySchema>
export type ListHubspotDealsQuery = z.infer<typeof listHubspotDealsQuerySchema>
