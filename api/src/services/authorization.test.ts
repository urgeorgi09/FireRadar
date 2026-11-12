import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import towerRoutes from '../routes/towers.js'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/client.js', () => ({ default: query }))

describe('operational route authorization', () => {
  let app: ReturnType<typeof Fastify>

  afterEach(async () => {
    await app.close()
    vi.clearAllMocks()
  })

  async function createApp() {
    app = Fastify()
    await app.register(jwt, { secret: 'test-secret-for-route-tests' })
    await app.register(towerRoutes, { prefix: '/towers' })
    await app.ready()
  }

  it('rejects unauthenticated access to tower positions', async () => {
    query.mockResolvedValue([])
    await createApp()

    const response = await app.inject({ method: 'GET', url: '/towers' })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a citizen token from operational tower data', async () => {
    query.mockResolvedValue([{ id: 1, email: 'citizen@example.test', role: 'citizen', active: true }])
    await createApp()
    const token = app.jwt.sign({ id: 1, role: 'citizen', email: 'citizen@example.test' })

    const response = await app.inject({
      method: 'GET',
      url: '/towers',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  it('rejects a deactivated dispatcher token', async () => {
    query.mockResolvedValue([{ id: 2, email: 'dispatch@example.test', role: 'dispatcher', active: false }])
    await createApp()
    const token = app.jwt.sign({ id: 2, role: 'dispatcher', email: 'dispatch@example.test' })

    const response = await app.inject({
      method: 'GET',
      url: '/towers/alerts',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(401)
  })
})
