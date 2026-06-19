import { z } from 'zod'

export const listDocumentsQuerySchema = z.object({
  category:   z.string().optional(),
  company_id: z.string().uuid().optional(),
  page:       z.coerce.number().int().positive().default(1),
  limit:      z.coerce.number().int().positive().max(100).default(20),
})

export const createDocumentSchema = z.object({
  title:        z.string().min(2),
  category:     z.string().optional(),
  description:  z.string().optional(),
  file_url:     z.string().url(),
  storage_path: z.string(),
  original_name: z.string(),
  mime_type:    z.string().optional(),
  size_bytes:   z.number().int().positive().optional(),
})

export const updateDocumentSchema = z.object({
  title:       z.string().min(2).optional(),
  category:    z.string().optional(),
  description: z.string().optional(),
  status:      z.enum(['available', 'archived']).optional(),
})
