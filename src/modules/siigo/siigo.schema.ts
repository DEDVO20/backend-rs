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

/** Meses 1–12 de un año, para importar meses específicos */
const monthsField = z.array(z.coerce.number().int().min(1).max(12)).min(1).max(12).optional()

export const syncSiigoBodySchema = z.object({
  connectionId,
  // 'incremental': desde la última sync completada (menos un margen de solape) hasta hoy
  // 'months': solo los meses indicados del año (cada bloque de meses seguidos es un rango)
  mode:         z.enum(['days', 'range', 'full', 'incremental', 'months']).default('days'),
  days:         z.coerce.number().int().positive().max(365).default(15),
  year:         z.coerce.number().int().min(2020).max(2035).optional(),
  months:       monthsField,
  startDate:    z.string().optional(),
  endDate:      z.string().optional(),
  sellerFilter: z.string().optional(),
}).refine(b => b.mode !== 'months' || (b.year && b.months?.length), {
  message: 'Elige el año y al menos un mes para importar',
  path: ['months'],
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
  // Meses específicos de un año (en lugar de startDate/endDate)
  year:      z.coerce.number().int().min(2020).max(2035).optional(),
  months:    monthsField,
}).refine(b => !b.months?.length || b.year, { message: 'Indica el año de los meses a importar', path: ['year'] })

export const listTrialBalanceQuerySchema = z.object({
  connectionId,
  period:    z.string().regex(/^\d{4}-\d{2}$/, 'Formato de periodo esperado: YYYY-MM').optional(),
  account:   z.string().max(20).optional(), // prefijo de código contable (ej. 13, 1305)
  companyId: z.string().uuid().optional(),
  search:    z.string().optional(),
  page:      z.coerce.number().int().positive().default(1),
  limit:     z.coerce.number().int().positive().max(500).default(100),
})

/**
 * mode 'current': mes en curso · 'year': enero al mes actual (o diciembre si el año ya cerró)
 * · 'months': solo los meses indicados (1–12) del año.
 */
export const syncTrialBalanceBodySchema = z.object({
  connectionId,
  mode:   z.enum(['current', 'year', 'months']).default('current'),
  year:   z.coerce.number().int().min(2020).max(2035).optional(),
  months: z.array(z.coerce.number().int().min(1).max(12)).min(1).max(12).optional(),
}).refine(b => b.mode !== 'months' || (b.months?.length ?? 0) > 0, {
  message: 'Elige al menos un mes para importar',
  path: ['months'],
})

export const syncReceivablesBodySchema = z.object({ connectionId })

export const listReceivablesQuerySchema = z.object({
  connectionId,
  companyId: z.string().uuid().optional(),
  bucket:    z.enum(['No vencido', '1-30', '31-60', '61-90', '91+', 'Sin vencimiento']).optional(),
  search:    z.string().max(100).optional(),
  page:      z.coerce.number().int().positive().default(1),
  limit:     z.coerce.number().int().positive().max(500).default(100),
})

const agingBucket = z.enum(['No vencido', '1-30', '31-60', '61-90', '91+', 'Sin vencimiento'])

/** Gráficas de cartera: periodo de la evolución + filtros cruzados (edad, vendedor, cliente) */
export const receivablesReportQuerySchema = listSiigoCollectionsQuerySchema.extend({
  bucket: agingBucket.optional(),
  seller: z.string().max(200).optional(),
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
export type SyncReceivablesBody = z.infer<typeof syncReceivablesBodySchema>
export type ListReceivablesQuery = z.infer<typeof listReceivablesQuerySchema>
export type ListSiigoCollectionsQuery = z.infer<typeof listSiigoCollectionsQuerySchema>
export type ReceivablesReportQuery = z.infer<typeof receivablesReportQuerySchema>
export type SyncSiigoCollectionsBody = z.infer<typeof syncSiigoCollectionsBodySchema>
export type SyncSiigoBody       = z.infer<typeof syncSiigoBodySchema>
export type SaveSiigoConnectionBody = z.infer<typeof saveSiigoConnectionBodySchema>
