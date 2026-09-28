import { z } from 'zod'

const SERVICE_VALUES = [
  'facturacion', 'cartera', 'controller',
  'contabilidad', 'pagos', 'nomina', 'multiples',
] as const

export const contactLeadSchema = z.object({
  // Pregunta 1 — Servicios de interés (multi-selección)
  services: z.array(z.enum(SERVICE_VALUES)).min(1, 'Selecciona al menos un servicio'),

  // Pregunta 2 — Tamaño de operación (4 opciones)
  companySize: z.enum(['1-3', '4-10', '11-24', '25+']),

  // Pregunta 3 — Cuándo quiere empezar
  startDate: z.enum(['asap', 'this-month', 'next-month', 'just-quoting']),

  // Datos de contacto
  name:    z.string().min(2).max(100),
  company: z.string().min(1).max(100),
  phone:   z.string().min(7).max(20),
  email:   z.string().email(),
})

export type ContactLeadInput = z.infer<typeof contactLeadSchema>
