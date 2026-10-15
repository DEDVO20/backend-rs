// Períodos del calendario tributario según la periodicidad de cada obligación.
// Lógica pura (sin DB) para poder probarla de forma aislada.

export const PERIODICITIES = ['mensual', 'bimestral', 'trimestral', 'cuatrimestral', 'semestral', 'anual'] as const
export type Periodicity = typeof PERIODICITIES[number]

// Meses que abarca cada período
const MONTHS_PER_PERIOD: Record<Periodicity, number> = {
  mensual: 1, bimestral: 2, trimestral: 3, cuatrimestral: 4, semestral: 6, anual: 12,
}

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const SHORT = MONTHS.map(m => m.slice(0, 3))

export interface PeriodDef {
  index: number
  label: string
}

export function isPeriodicity(v: unknown): v is Periodicity {
  return typeof v === 'string' && (PERIODICITIES as readonly string[]).includes(v)
}

export function periodCount(p: Periodicity): number {
  return 12 / MONTHS_PER_PERIOD[p]
}

/**
 * Períodos de una obligación dentro del calendario del año `year`.
 * Las periódicas se etiquetan con los meses del año; las anuales con el año
 * gravable anterior (en el calendario 2026 se declara la renta AG 2025).
 */
export function periodsFor(periodicity: Periodicity, year: number): PeriodDef[] {
  const size = MONTHS_PER_PERIOD[periodicity]
  const count = periodCount(periodicity)

  return Array.from({ length: count }, (_, i) => {
    const first = i * size
    const last  = first + size - 1
    let label: string
    switch (periodicity) {
      case 'mensual':       label = `Período ${MONTHS[first]} ${year}`; break
      case 'bimestral':     label = `Bimestre ${i + 1} (${SHORT[first]}-${SHORT[last]}) ${year}`; break
      case 'trimestral':    label = `Trimestre ${i + 1} (${SHORT[first]}-${SHORT[last]}) ${year}`; break
      case 'cuatrimestral': label = `${MONTHS[first]} - ${MONTHS[last]} ${year}`; break
      case 'semestral':     label = `Semestre ${i + 1} (${SHORT[first]}-${SHORT[last]}) ${year}`; break
      case 'anual':         label = `Año gravable ${year - 1}`; break
    }
    return { index: i + 1, label }
  })
}

// Índice inicial de las fechas adicionales que agrega el contador
export const CUSTOM_INDEX_START = 101
