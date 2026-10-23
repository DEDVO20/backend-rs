import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha esperado: YYYY-MM-DD')

export const listSiigoSalesQuerySchema = z.object({
  startDate:   isoDate.optional(),
  endDate:     isoDate.optional(),
  period:      z.string().regex(/^\d{4}-\d{2}$/, 'Formato de periodo esperado: YYYY-MM').optional(),
  companyId:   z.string().uuid().optional(),
  customerNit: z.string().optional(),
  docType:     z.enum(['FACTURA', 'NOTA_CREDITO']).optional(),
  productCode: z.string().optional(),
  search:      z.string().optional(),
  page:        z.coerce.number().int().positive().default(1),
  limit:       z.coerce.number().int().positive().max(500).default(50),
})

export const syncSiigoBodySchema = z.object({
  // 'incremental': desde la última sync completada (menos un margen de solape) hasta hoy
  mode:         z.enum(['days', 'range', 'full', 'incremental']).default('days'),
  days:         z.coerce.number().int().positive().max(365).default(15),
  year:         z.coerce.number().int().min(2020).max(2035).optional(),
  startDate:    z.string().optional(),
  endDate:      z.string().optional(),
  sellerFilter: z.string().optional(),
})

export type ListSiigoSalesQuery = z.infer<typeof listSiigoSalesQuerySchema>
export type SyncSiigoBody       = z.infer<typeof syncSiigoBodySchema>
