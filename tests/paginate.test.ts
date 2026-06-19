import { describe, it, expect } from 'vitest'
import { paginationRange, paginatedResponse } from '../src/lib/paginate.js'

describe('paginationRange', () => {
  it('calcula el rango correcto para page 1', () => {
    expect(paginationRange(1, 20)).toEqual({ from: 0, to: 19 })
  })

  it('calcula el rango correcto para page 2', () => {
    expect(paginationRange(2, 20)).toEqual({ from: 20, to: 39 })
  })

  it('calcula el rango correcto para page 3 con limit 10', () => {
    expect(paginationRange(3, 10)).toEqual({ from: 20, to: 29 })
  })
})

describe('paginatedResponse', () => {
  it('devuelve la estructura correcta', () => {
    const result = paginatedResponse([1, 2, 3], 50, 2, 10)
    expect(result).toEqual({
      data: [1, 2, 3],
      meta: { total: 50, page: 2, limit: 10, pages: 5 },
    })
  })

  it('calcula pages correctamente con total no divisible', () => {
    const result = paginatedResponse([], 25, 1, 10)
    expect(result.meta.pages).toBe(3)
  })

  it('devuelve pages=0 cuando total es 0', () => {
    const result = paginatedResponse([], 0, 1, 20)
    expect(result.meta.pages).toBe(0)
  })
})
