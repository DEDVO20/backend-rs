import { z } from 'zod'

export const updateCompanySchema = z.object({
  name:    z.string().min(2).optional(),
  nit:     z.string().optional(),
  city:    z.string().optional(),
  dept:    z.string().optional(),
  sector:  z.string().optional(),
  phone:   z.string().optional(),
  address: z.string().optional(),
  website: z.string().url().optional().or(z.literal('')),
  size:    z.string().optional(),
  contact: z.string().optional(),
  cargo:   z.string().optional(),
  email:   z.string().email().optional(),
  asesor:  z.string().optional(),
  notes:   z.string().optional(),
  max_users: z.number().int().positive().optional(),
})

export const createCompanySchema = z.object({
  name:    z.string().min(2),
  nit:     z.string().optional(),
  city:    z.string().optional(),
  dept:    z.string().optional(),
  sector:  z.string().optional(),
  phone:   z.string().optional(),
  address: z.string().optional(),
  website: z.string().url().optional().or(z.literal('')),
  size:    z.string().optional(),
  contact: z.string().optional(),
  cargo:   z.string().optional(),
  email:   z.string().email().optional().or(z.literal('')),
  asesor:  z.string().optional(),
  notes:   z.string().optional(),
  status:  z.string().optional(),
})

export const listCompaniesQuerySchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().optional(),
  page:   z.coerce.number().int().positive().default(1),
  limit:  z.coerce.number().int().positive().max(100).default(20),
})
