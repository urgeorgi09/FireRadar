import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcrypt'
import sql from '../db/client.js'
import { findActiveUser } from '../services/authorization.js'

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
})

export default async function authRoutes(app: FastifyInstance) {
  // Login — строг rate limit срещу brute force: 10 опита на 15 минути
  app.post('/login', {
    config: {
      rateLimit: { max: 10, timeWindow: '15 minutes' },
    },
  }, async (req, reply) => {
    const body = LoginSchema.safeParse(req.body)
    if (!body.success)
      return reply.status(400).send({ error: 'Невалидни данни' })

    const [user] = await sql`
      SELECT id, email, password, role, active FROM users WHERE email = ${body.data.email}
    `
    // Умишлено еднакво съобщение за невалиден имейл и парола (no user enumeration)
    if (!user) {
      await bcrypt.hash('dummy', 10)  // timing attack mitigation
      return reply.status(401).send({ error: 'Грешен имейл или парола' })
    }

    const ok = await bcrypt.compare(body.data.password, user.password)
    if (!ok || !user.active || user.role === 'citizen')
      return reply.status(401).send({ error: 'Грешен имейл или парола' })

    const token = app.jwt.sign({ id: user.id, role: user.role, email: user.email })
    return { token, role: user.role, email: user.email, expiresIn: 900 }
  })

  // Обнови токена (ако е валиден — издаваме нов с нов срок)
  app.post('/refresh', async (req, reply) => {
    let claims: { id: number }
    try {
      await req.jwtVerify()
      claims = req.user as { id: number }
    } catch {
      return reply.status(401).send({ error: 'Невалиден или изтекъл токен' })
    }
    const user = await findActiveUser(claims.id)
    if (!user) return reply.status(401).send({ error: 'Потребителят е неактивен или не съществува' })
    const token = app.jwt.sign({ id: user.id, role: user.role, email: user.email })
    return { token, expiresIn: 900 }
  })

  // Текущ потребител
  app.get('/me', async (req, reply) => {
    let claims: { id: number }
    try {
      await req.jwtVerify()
      claims = req.user as { id: number }
    } catch {
      return reply.status(401).send({ error: 'Невалиден токен' })
    }
    const user = await findActiveUser(claims.id)
    if (!user) return reply.status(401).send({ error: 'Потребителят е неактивен или не съществува' })
    return { id: user.id, role: user.role, email: user.email }
  })
}
