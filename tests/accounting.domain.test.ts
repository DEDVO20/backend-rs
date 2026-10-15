import { describe, it, expect } from 'vitest'
import { periodsFor, periodCount, isPeriodicity } from '../src/modules/accounting/accounting.domain.js'

describe('periodsFor', () => {
  it('mensual genera 12 períodos con el nombre del mes', () => {
    const p = periodsFor('mensual', 2026)
    expect(p).toHaveLength(12)
    expect(p[0]).toEqual({ index: 1, label: 'Período Enero 2026' })
    expect(p[11]!.label).toBe('Período Diciembre 2026')
  })

  it('bimestral genera 6 bimestres', () => {
    const p = periodsFor('bimestral', 2026)
    expect(p).toHaveLength(6)
    expect(p[0]!.label).toBe('Bimestre 1 (Ene-Feb) 2026')
    expect(p[5]!.label).toBe('Bimestre 6 (Nov-Dic) 2026')
  })

  it('cuatrimestral genera 3 períodos', () => {
    const p = periodsFor('cuatrimestral', 2026)
    expect(p.map(x => x.label)).toEqual([
      'Enero - Abril 2026', 'Mayo - Agosto 2026', 'Septiembre - Diciembre 2026',
    ])
  })

  it('anual se etiqueta con el año gravable anterior', () => {
    expect(periodsFor('anual', 2026)).toEqual([{ index: 1, label: 'Año gravable 2025' }])
  })

  it('periodCount e isPeriodicity', () => {
    expect(periodCount('trimestral')).toBe(4)
    expect(periodCount('semestral')).toBe(2)
    expect(isPeriodicity('mensual')).toBe(true)
    expect(isPeriodicity('diario')).toBe(false)
  })
})
