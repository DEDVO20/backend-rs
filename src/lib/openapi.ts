import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

export { OpenAPIHono, createRoute, z }

// Componentes reutilizables
export const errorSchema = z.object({
  error: z.string().openapi({ example: 'Mensaje de error' }),
})

export const paginatedMetaSchema = z.object({
  total: z.number(),
  page:  z.number(),
  limit: z.number(),
  pages: z.number(),
})

export const uuidParam = { id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }

// Respuestas comunes
export const responses = {
  400: { content: { 'application/json': { schema: errorSchema } }, description: 'Solicitud inválida' },
  401: { content: { 'application/json': { schema: errorSchema } }, description: 'No autorizado' },
  403: { content: { 'application/json': { schema: errorSchema } }, description: 'Prohibido' },
  404: { content: { 'application/json': { schema: errorSchema } }, description: 'No encontrado' },
  500: { content: { 'application/json': { schema: errorSchema } }, description: 'Error interno' },
} as const
