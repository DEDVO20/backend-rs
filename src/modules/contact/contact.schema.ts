import { z } from 'zod'

const SERVICE_VALUES = ['control', 'contabilidad', 'facturacion', 'nomina'] as const

export const contactLeadSchema = z.object({
  // Servicios seleccionados (los 4 módulos del landing)
  services: z.array(z.enum(SERVICE_VALUES)).min(1, 'Selecciona al menos un servicio'),

  // Tamaño de operación
  companySize: z.enum(['0-3', '4-9', '10-24', '25+']),

  // Cuándo quiere empezar
  startDate: z.enum(['asap', 'this-month', 'next-month', 'just-quoting']),

  // Datos de contacto
  name:    z.string().min(2).max(100),
  company: z.string().min(1).max(100),
  phone:   z.string().min(7).max(20),
  email:   z.string().email(),
})

export type ContactLeadInput = z.infer<typeof contactLeadSchema>
