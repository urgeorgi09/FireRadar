import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import alertRoutes from './alerts.js'
import { startDroneAnimation } from './drones.js'

const { query, begin, verifyTurnstile, boundaryInside } = vi.hoisted(() => ({
  query: vi.fn(),
  begin: vi.fn(),
  verifyTurnstile: vi.fn(),
  boundaryInside: { value: true },
}))
vi.mock('../db/client.js', () => ({
  default: Object.assign(query, { begin, json: vi.fn() }),
}))
vi.mock('../services/bulgariaBoundary.js', () => ({
  loadBulgariaBoundaryGeoJSON: () => JSON.stringify({
    type: 'Polygon',
    coordinates: [[[22, 41], [29, 41], [29, 45], [22, 45], [22, 41]]],
  }),
}))
vi.mock('../services/turnstile.js', () => ({ verifyTurnstile }))
vi.mock('./drones.js', () => ({ startDroneAnimation: vi.fn() }))

describe('public alert route', () => {
  let app: ReturnType<typeof Fastify>
  const previousSecret = process.env.TURNSTILE_SECRET_KEY

  beforeEach(async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret'
    boundaryInside.value = true
    verifyTurnstile.mockResolvedValue(true)
    query.mockImplementation(async (strings: TemplateStringsArray) => {
      const statement = strings.join('')
      if (statement.includes('ST_Intersects')) return [{ inside: boundaryInside.value }]
      if (statement.includes('FROM users')) return [{ id: 2, email: 'dispatch@example.test', role: 'dispatcher', active: true }]
      return []
    })
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        const statement = strings.join('')
        if (statement.includes('INSERT INTO alerts')) return [{ id: 1, lat: 42.6, lon: 23.3, status: 'pending', drone_recon_id: null }]
        if (statement.includes('FROM drones')) return []
        return []
      }),
    )
    app = Fastify()
    await app.register(jwt, { secret: 'test-secret-for-alert-tests' })
    await app.register(rateLimit, { global: false })
    await app.register(alertRoutes, { prefix: '/alerts' })
    await app.ready()
  })

  it('rejects coordinates inside the bounding box but outside the country boundary', async () => {
    boundaryInside.value = false
    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: { lat: 42, lon: 23, description: 'test', captchaToken: 'token' },
    })
    expect(response.statusCode).toBe(400)
    expect(verifyTurnstile).not.toHaveBeenCalled()
  })

  it('rejects descriptions longer than 500 characters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: { lat: 42.6, lon: 23.3, description: 'x'.repeat(501), captchaToken: 'token' },
    })
    expect(response.statusCode).toBe(400)
    expect(verifyTurnstile).not.toHaveBeenCalled()
  })

  it('rejects an invalid Turnstile response', async () => {
    verifyTurnstile.mockResolvedValue(false)
    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: { lat: 42.6, lon: 23.3, description: 'test', captchaToken: 'token' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('creates an operations alert and leaves it waiting when no recon drone is available', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: { lat: 42.6, lon: 23.3, description: 'Smoke report', captchaToken: 'token' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 1, status: 'pending', drone_recon_id: null })
    expect(begin).toHaveBeenCalledOnce()
  })

  it('automatically dispatches the nearest idle recon drone for a citizen alert', async () => {
    const statements: string[] = []
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        const statement = strings.join('')
        statements.push(statement)
        if (statement.includes('INSERT INTO alerts'))
          return [{ id: 8, lat: 42.6, lon: 23.3, drone_recon_id: null }]
        if (statement.includes('FROM drones'))
          return [{ id: 4, name: 'Реконс-1', base_lat: 42.65, base_lon: 23.28 }]
        if (statement.includes('UPDATE alerts'))
          return [{ id: 8, lat: 42.6, lon: 23.3, drone_recon_id: 4 }]
        return []
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: { lat: 42.6, lon: 23.3, description: 'Smoke report', captchaToken: 'token' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 8, drone_recon_id: 4 })
    expect(statements.some(statement => statement.includes('UPDATE drones'))).toBe(true)
    expect(startDroneAnimation).toHaveBeenCalledWith(
      4, 42.65, 23.28, 42.6, 23.3, 'recon', expect.objectContaining({ log: expect.any(Object) }),
    )
  })

  it('marks a confirmed citizen alert as extinguished and audits the change', async () => {
    const statements: string[] = []
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        const statement = strings.join('')
        statements.push(statement)
        if (statement.includes('SELECT id, status FROM alerts'))
          return [{ id: 15, status: 'confirmed' }]
        if (statement.includes('UPDATE alerts SET status'))
          return [{ id: 15, status: 'extinguished' }]
        return []
      }),
    )
    const token = app.jwt.sign({ id: 2, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'PATCH',
      url: '/alerts/15',
      headers: { authorization: ['Bearer', token].join(' ') },
      payload: { status: 'extinguished' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: 15, status: 'extinguished' })
    expect(statements.some(statement => statement.includes('INSERT INTO audit_log'))).toBe(true)
  })

  it('does not allow extinguishing a citizen alert before it is confirmed', async () => {
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        if (strings.join('').includes('SELECT id, status FROM alerts'))
          return [{ id: 15, status: 'pending' }]
        return []
      }),
    )
    const token = app.jwt.sign({ id: 2, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'PATCH',
      url: '/alerts/15',
      headers: { authorization: ['Bearer', token].join(' ') },
      payload: { status: 'extinguished' },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('потвърден сигнал') })
  })

  afterEach(async () => {
    await app.close()
    vi.clearAllMocks()
    if (previousSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY
    else process.env.TURNSTILE_SECRET_KEY = previousSecret
  })

  it('rejects invalid coordinates before contacting providers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: { lat: 50, lon: 23, description: 'test', captchaToken: 'token' },
    })
    expect(response.statusCode).toBe(400)
    expect(verifyTurnstile).not.toHaveBeenCalled()
  })

  it('fails closed when Turnstile is unavailable', async () => {
    verifyTurnstile.mockRejectedValue(new Error('provider unavailable'))
    const response = await app.inject({
      method: 'POST',
      url: '/alerts',
      payload: { lat: 42.6, lon: 23.3, description: 'test', captchaToken: 'token' },
    })
    expect(response.statusCode).toBe(503)
  })

  it('applies the per-IP alert submission limit', async () => {
    let response
    for (let attempt = 0; attempt < 6; attempt++) {
      response = await app.inject({
        method: 'POST',
        url: '/alerts',
        payload: { lat: 42.6, lon: 23.3, description: 'test', captchaToken: 'token' },
      })
    }
    expect(response?.statusCode).toBe(429)
  })
})
