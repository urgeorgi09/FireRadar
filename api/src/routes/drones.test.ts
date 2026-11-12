import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import droneRoutes from './drones.js'

const { query, begin } = vi.hoisted(() => ({
  query: vi.fn(),
  begin: vi.fn(),
}))
vi.mock('../db/client.js', () => ({
  default: Object.assign(query, { begin, json: vi.fn() }),
}))

describe('drone dispatch routes', () => {
  let app: ReturnType<typeof Fastify>

  async function createApp() {
    app = Fastify()
    await app.register(jwt, { secret: 'test-secret-for-drone-tests' })
    await app.register(droneRoutes, { prefix: '/drones' })
    await app.ready()
    return app
  }

  afterEach(async () => {
    await app.close()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('requires authentication to read drone locations', async () => {
    await createApp()
    const response = await app.inject({ method: 'GET', url: '/drones' })
    expect(response.statusCode).toBe(401)
  })

  it('denies a non-staff user access to drone locations', async () => {
    query.mockResolvedValue([{ id: 2, email: 'citizen@example.test', role: 'citizen', active: true }])
    await createApp()
    const token = app.jwt.sign({ id: 2, role: 'citizen', email: 'citizen@example.test' })
    const response = await app.inject({
      method: 'GET',
      url: '/drones',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  it('audits manual drone status changes in the same transaction', async () => {
    query.mockResolvedValue([{ id: 2, email: 'dispatch@example.test', role: 'dispatcher', active: true }])
    const statements: string[] = []
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        const statement = strings.join('')
        statements.push(statement)
        if (statement.includes('UPDATE drones'))
          return [{ id: 7, name: 'Drone 7', status: 'idle', current_lat: 42, current_lon: 23 }]
        return []
      }),
    )
    await createApp()
    const token = app.jwt.sign({ id: 2, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'PATCH',
      url: '/drones/7/status',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'idle' },
    })

    expect(response.statusCode).toBe(200)
    expect(statements.some(statement => statement.includes('INSERT INTO audit_log'))).toBe(true)
  })

  it('returns 409 when a tanker is requested for an unconfirmed alert', async () => {
    query.mockResolvedValue([{ id: 2, email: 'dispatch@example.test', role: 'dispatcher', active: true }])
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        expect(strings.join('')).toContain('FROM tower_alerts')
        return [{ id: 12, lat: 42.6, lon: 23.3, status: 'pending' }]
      }),
    )

    await createApp()
    const token = app.jwt.sign({ id: 2, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'POST',
      url: '/drones/dispatch/tanker',
      headers: { authorization: `Bearer ${token}` },
      payload: { tower_alert_id: 12 },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('потвърден пожар') })
  })

  it('rejects a tanker for an unconfirmed citizen alert', async () => {
    query.mockResolvedValue([{ id: 2, email: 'dispatch@example.test', role: 'dispatcher', active: true }])
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        expect(strings.join('')).toContain('FROM alerts')
        return [{ id: 12, lat: 42.6, lon: 23.3, status: 'pending', drone_tanker_id: null }]
      }),
    )

    await createApp()
    const token = app.jwt.sign({ id: 2, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'POST',
      url: '/drones/dispatch/citizen-alert/tanker',
      headers: { authorization: ['Bearer', token].join(' ') },
      payload: { alert_id: 12 },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('потвърден граждански сигнал') })
  })

  it('dispatches and audits a tanker for a confirmed citizen alert', async () => {
    query.mockResolvedValue([{ id: 2, email: 'dispatch@example.test', role: 'dispatcher', active: true }])
    const statements: string[] = []
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => unknown) =>
      callback(async strings => {
        const statement = strings.join('')
        statements.push(statement)
        if (statement.includes('FROM alerts'))
          return [{ id: 12, lat: 42.6, lon: 23.3, status: 'confirmed', drone_tanker_id: null }]
        if (statement.includes('FROM drones'))
          return [{ id: 9, name: 'Водоноска-1', base_lat: 42.65, base_lon: 23.28 }]
        return []
      }),
    )

    await createApp()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof setInterval>)
    const token = app.jwt.sign({ id: 2, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'POST',
      url: '/drones/dispatch/citizen-alert/tanker',
      headers: { authorization: ['Bearer', token].join(' ') },
      payload: { alert_id: 12 },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ drone: { id: 9, name: 'Водоноска-1' } })
    expect(statements.some(statement => statement.includes('UPDATE alerts SET drone_tanker_id'))).toBe(true)
    expect(statements.some(statement => statement.includes('INSERT INTO audit_log'))).toBe(true)
  })
})
