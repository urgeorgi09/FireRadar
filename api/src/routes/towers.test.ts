import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import towerRoutes from './towers.js'

const { query, begin } = vi.hoisted(() => ({
  query: vi.fn(),
  begin: vi.fn(),
}))
vi.mock('../db/client.js', () => ({
  default: Object.assign(query, { begin, json: vi.fn() }),
}))

describe('tower operational routes', () => {
  let app: ReturnType<typeof Fastify>

  async function createApp() {
    app = Fastify()
    await app.register(jwt, { secret: 'test-secret-for-tower-tests' })
    await app.register(towerRoutes, { prefix: '/towers' })
    await app.ready()
    return app
  }

  afterEach(async () => {
    await app.close()
    vi.clearAllMocks()
  })

  it('requires authentication for tower and tower-alert reads', async () => {
    await createApp()
    for (const url of ['/towers', '/towers/alerts']) {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(401)
    }
  })

  it('denies non-staff access to tower and tower-alert reads', async () => {
    query.mockResolvedValue([{ id: 5, email: 'citizen@example.test', role: 'citizen', active: true }])
    await createApp()
    const token = app.jwt.sign({ id: 5, role: 'citizen', email: 'citizen@example.test' })
    for (const url of ['/towers', '/towers/alerts']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.statusCode).toBe(403)
    }
  })

  it('audits tower-alert creation in the same transaction', async () => {
    query.mockResolvedValue([{ id: 5, email: 'dispatch@example.test', role: 'dispatcher', active: true }])
    const statements: string[] = []
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => Promise<unknown>) =>
      callback(async strings => {
        const statement = strings.join('')
        statements.push(statement)
        if (statement.includes('INSERT INTO tower_alerts'))
          return [{ id: 9, status: 'pending' }]
        return []
      }),
    )
    await createApp()
    const token = app.jwt.sign({ id: 5, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'POST',
      url: '/towers/1/alert',
      headers: { authorization: `Bearer ${token}` },
      payload: { lat: 42.6, lon: 23.3, confidence: 0.9 },
    })

    expect(response.statusCode).toBe(200)
    expect(statements.some(statement => statement.includes('INSERT INTO audit_log'))).toBe(true)
  })

  it('writes tower-alert status changes to audit_log in the same transaction', async () => {
    query.mockResolvedValue([{ id: 5, email: 'dispatch@example.test', role: 'dispatcher', active: true }])
    const statements: string[] = []
    begin.mockImplementation(async (callback: (tx: (strings: TemplateStringsArray) => Promise<unknown[]>) => Promise<unknown>) =>
      callback(async strings => {
        const statement = strings.join('')
        statements.push(statement)
        if (statement.includes('UPDATE tower_alerts'))
          return [{ id: 9, status: 'confirmed' }]
        return []
      }),
    )
    await createApp()
    const token = app.jwt.sign({ id: 5, role: 'dispatcher', email: 'dispatch@example.test' })
    const response = await app.inject({
      method: 'PATCH',
      url: '/towers/alerts/9',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'confirmed' },
    })

    expect(response.statusCode).toBe(200)
    expect(statements.some(statement => statement.includes('INSERT INTO audit_log'))).toBe(true)
  })
})
