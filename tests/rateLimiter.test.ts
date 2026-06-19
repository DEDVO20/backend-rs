import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { rateLimiter } from '../src/middleware/rateLimiter.js'

function makeApp(max: number, windowMs = 60_000) {
  const app = new Hono()
  app.use('*', rateLimiter({ max, windowMs, keyPrefix: `test-${Date.now()}` }))
  app.get('/', (c) => c.json({ ok: true }))
  return app
}

describe('rateLimiter', () => {
  it('permite requests dentro del límite', async () => {
    const app = makeApp(3)

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/', { headers: { 'x-real-ip': '1.2.3.4' } })
      expect(res.status).toBe(200)
    }
  })

  it('bloquea con 429 al superar el límite', async () => {
    const app = makeApp(2)
    const headers = { 'x-real-ip': '5.6.7.8' }

    await app.request('/', { headers })
    await app.request('/', { headers })
    const res = await app.request('/', { headers })

    expect(res.status).toBe(429)
    const body = await res.json() as any
    expect(body).toHaveProperty('error')
    expect(body).toHaveProperty('retryAfter')
  })

  it('incluye el header Retry-After en la respuesta 429', async () => {
    const app = makeApp(1)
    const headers = { 'x-real-ip': '9.10.11.12' }

    await app.request('/', { headers })
    const res = await app.request('/', { headers })

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('IPs distintas tienen contadores independientes', async () => {
    const app = makeApp(1)

    const res1 = await app.request('/', { headers: { 'x-real-ip': '1.1.1.1' } })
    const res2 = await app.request('/', { headers: { 'x-real-ip': '2.2.2.2' } })

    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
  })
})
