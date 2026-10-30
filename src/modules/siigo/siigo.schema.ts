import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha esperado: YYYY-MM-DD')

/**
 * connectionId: de quién son los libros (cuenta de Siigo). Solo lo usan los roles internos;
 * por defecto, la conexión de Finto. Los clientes siempre ven la de su propia empresa.
 * companyId: tercero dentro de esos libros (p. ej. un cliente dentro de los libros de Finto).
 */
const connectionId = z.string().uuid().optional()

export const listSiigoSalesQuerySchema = z.object({
  connectionId,
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
  connectionId,
  // 'incremental': desde la última sync completada (menos un margen de solape) hasta hoy
  mode:         z.enum(['days', 'range', 'full', 'incremental']).default('days'),
  days:         z.coerce.number().int().positive().max(365).default(15),
  year:         z.coerce.number().int().min(2020).max(2035).optional(),
  startDate:    z.string().optional(),
  endDate:      z.string().optional(),
  sellerFilter: z.string().optional(),
})

export const listSiigoCollectionsQuerySchema = z.object({
  connectionId,
  startDate:   isoDate.optional(),
  endDate:     isoDate.optional(),
  companyId:   z.string().uuid().optional(),
  customerNit: z.string().optional(),
  search:      z.string().optional(),
  page:        z.coerce.number().int().positive().default(1),
  limit:       z.coerce.number().int().positive().max(500).default(50),
})

export const syncSiigoCollectionsBodySchema = z.object({
  connectionId,
  startDate: isoDate.optional(),
  endDate:   isoDate.optional(),
})

export const listTrialBalanceQuerySchema = z.object({
  connectionId,
  period:    z.string().regex(/^\d{4}-\d{2}$/, 'Formato de periodo esperado: YYYY-MM').optional(),
  account:   z.string().max(20).optional(), // prefijo de código contable (ej. 13, 1305)
  companyId: z.string().uuid().optional(),
  search:    z.string().optional(),
  page:      z.coerce.number().int().positive().default(1),
  limit:     z.coerce.number().int().positive().max(500).default(100),
})

export const syncTrialBalanceBodySchema = z.object({
  connectionId,
  mode: z.enum(['current', 'year']).default('current'),
  year: z.coerce.number().int().min(2020).max(2035).optional(),
})

export const syncLogsQuerySchema = z.object({ connectionId })

/** Credenciales y ajustes de una conexión. accessKey vacía o ausente = conservar la actual */
export const saveSiigoConnectionBodySchema = z.object({
  username:             z.string().max(200).optional(),
  accessKey:            z.string().max(500).optional(),
  partnerId:            z.string().max(100).optional(),
  sellerFilter:         z.string().max(50).optional(),
  salesStartYear:       z.coerce.number().int().min(2015).max(2035).nullable().optional(),
  collectionsStartDate: isoDate.nullable().optional(),
  active:               z.boolean().optional(),
})

export type ListSiigoSalesQuery = z.infer<typeof listSiigoSalesQuerySchema>
export type ListTrialBalanceQuery = z.infer<typeof listTrialBalanceQuerySchema>
export type SyncTrialBalanceBody = z.infer<typeof syncTrialBalanceBodySchema>
export type ListSiigoCollectionsQuery = z.infer<typeof listSiigoCollectionsQuerySchema>
export type SyncSiigoCollectionsBody = z.infer<typeof syncSiigoCollectionsBodySchema>
export type SyncSiigoBody       = z.infer<typeof syncSiigoBodySchema>
export type SaveSiigoConnectionBody = z.infer<typeof saveSiigoConnectionBodySchema>
