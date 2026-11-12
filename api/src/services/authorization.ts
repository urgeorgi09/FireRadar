import type { FastifyReply, FastifyRequest } from 'fastify'
import sql from '../db/client.js'

type StaffRole = 'dispatcher' | 'admin'

export async function findActiveUser(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const [user] = await sql<{ id: number; email: string; role: string; active: boolean }[]>`
    SELECT id, email, role, active FROM users WHERE id = ${id}
  `
  return user?.active ? user : null
}

export function requireActiveUser(allowedRoles: readonly StaffRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await req.jwtVerify()
    const claims = req.user as { id?: unknown }
    if (typeof claims.id !== 'number')
      return reply.status(401).send({ error: 'Невалиден токен' })

    const user = await findActiveUser(claims.id)
    if (!user) return reply.status(401).send({ error: 'Потребителят е неактивен или не съществува' })
    if (!allowedRoles.includes(user.role as StaffRole))
      return reply.status(403).send({ error: 'Нямате права за тази операция' })

    req.user = { ...claims, id: user.id, role: user.role, email: user.email }
  }
}
