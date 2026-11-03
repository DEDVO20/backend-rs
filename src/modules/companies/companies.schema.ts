import { z } from 'zod'

/** Sitio web: acepta "empresa.com" y lo guarda como "https://empresa.com"; vacío = sin sitio */
const websiteSchema = z.preprocess(
  v => {
    const s = typeof v === 'string' ? v.trim() : v
    return typeof s === 'string' && s && !/^https?:\/\//i.test(s) ? `https://${s}` : s
  },
  z.string().url('Sitio web inválido').max(300).optional().or(z.literal('')),
)

/** Campos que el client_owner puede cambiar de su propia empresa (el resto lo gestiona Finto) */
export const CLIENT_EDITABLE_COMPANY_FIELDS = ['website'] as const

export const updateCompanySchema = z.object({
  name:    z.string().min(2).optional(),
  nit:     z.string().optional(),
  city:    z.string().optional(),
  dept:    z.string().optional(),
  sector:  z.string().optional(),
  phone:   z.string().optional(),
  address: z.string().optional(),
  website: websiteSchema,
  size:    z.string().optional(),
  contact: z.string().optional(),
  cargo:   z.string().optional(),
  email:   z.string().email().optional(),
  asesor:  z.string().optional(),
  notes:   z.string().optional(),
  max_users: z.number().int().positive().optional(),
  fecha_vinculacion: z.string().date().nullable().optional(),
})

export const createCompanySchema = z.object({
  name:    z.string().min(2),
  nit:     z.string().optional(),
  city:    z.string().optional(),
  dept:    z.string().optional(),
  sector:  z.string().optional(),
  phone:   z.string().optional(),
  address: z.string().optional(),
  website: websiteSchema,
  size:    z.string().optional(),
  contact: z.string().optional(),
  cargo:   z.string().optional(),
  email:   z.string().email().optional().or(z.literal('')),
  asesor:  z.string().optional(),
  notes:   z.string().optional(),
  status:  z.string().optional(),
  fecha_vinculacion: z.string().date().nullable().optional(),
})

export const listCompaniesQuerySchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().optional(),
  page:   z.coerce.number().int().positive().default(1),
  limit:  z.coerce.number().int().positive().max(100).default(20),
})
