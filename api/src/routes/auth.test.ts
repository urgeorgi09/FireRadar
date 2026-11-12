import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import authRoutes from './auth.js'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/client.js', () => ({ default: query }))

describe('authentication routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    query.mockResolvedValue([])
    app = Fastify()
    await app.register(rateLimit, { global: false })
    await app.register(jwt, { secret: 'test-secret-for-auth-tests' })
    await app.register(authRoutes, { prefix: '/auth' })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    vi.clearAllMocks()
  })

  it('returns 401 for a validly-shaped login with an unknown account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'missing@example.test', password: 'a-long-test-password' },
    })

    expect(response.statusCode).toBe(401)
  })

  it('returns 429 after the login rate limit is reached', async () => {
    let response
    for (let attempt = 0; attempt < 11; attempt++) {
      response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'missing@example.test', password: 'a-long-test-password' },
      })
    }

    expect(response?.statusCode).toBe(429)
  })
})
