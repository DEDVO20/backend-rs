import { z } from 'zod'

export const createBlogPostSchema = z.object({
  title:                z.string().min(3, 'El título debe tener al menos 3 caracteres'),
  slug:                 z.string().min(2, 'El slug es requerido').regex(/^[a-z0-9-]+$/, 'El slug solo puede contener letras minúsculas, números y guiones'),
  excerpt:              z.string().optional(),
  content:              z.string().min(10, 'El contenido debe tener al menos 10 caracteres'),
  cover_image:          z.string().url('URL de imagen inválida').optional().or(z.literal('')),
  category:             z.string().default('Finanzas'),
  tags:                 z.array(z.string()).default([]),
  author_name:          z.string().default('Equipo Finto'),
  author_role:          z.string().default('Finanzas & Estrategia'),
  reading_time_minutes: z.number().int().min(1).default(5),
  published:            z.boolean().default(false),
  featured:             z.boolean().default(false),
})

export const updateBlogPostSchema = createBlogPostSchema.partial()

export const queryBlogPostSchema = z.object({
  search:    z.string().optional(),
  category:  z.string().optional(),
  published: z.enum(['true', 'false', 'all']).optional().default('all'),
  featured:  z.enum(['true', 'false']).optional(),
  page:      z.coerce.number().int().positive().default(1),
  limit:     z.coerce.number().int().positive().max(100).default(20),
})

export const createBlogCategorySchema = z.object({
  name:        z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  slug:        z.string().min(2).regex(/^[a-z0-9-]+$/, 'Slug inválido').optional(),
  description: z.string().optional(),
  color:       z.string().default('brand'),
})

export const updateBlogCategorySchema = createBlogCategorySchema.partial()

export type CreateBlogPostInput = z.infer<typeof createBlogPostSchema>
export type UpdateBlogPostInput = z.infer<typeof updateBlogPostSchema>
export type QueryBlogPostInput  = z.infer<typeof queryBlogPostSchema>
export type CreateBlogCategoryInput = z.infer<typeof createBlogCategorySchema>
export type UpdateBlogCategoryInput = z.infer<typeof updateBlogCategorySchema>

