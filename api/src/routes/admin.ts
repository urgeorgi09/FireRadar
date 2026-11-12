/**
 * Admin-only routes:
 * - Управление на потребители (списък, промяна на роля, деактивиране)
 * - Audit log — журнал на действията
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import sql from '../db/client.js'
import { requireActiveUser } from '../services/authorization.js'

function requireAdmin(req: any, reply: any) {
  const user = req.user as { role: string }
  if (user.role !== 'admin') {
    reply.status(403).send({ error: 'Само администратори имат достъп' })
    return false
  }
  return true
}

const RoleSchema    = z.object({ role: z.enum(['citizen', 'dispatcher', 'admin']) })
const StatusSchema  = z.object({ active: z.boolean() })

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireActiveUser(['admin']))

  // ── Потребители ──────────────────────────────────────────────────────────

  app.get('/users', async (req, reply) => {
    await req.jwtVerify()
    if (!requireAdmin(req, reply)) return
    return sql`
      SELECT id, email, role, active, created_at
      FROM users
      ORDER BY created_at DESC
    `
  })

  app.patch('/users/:id/role', async (req, reply) => {
    await req.jwtVerify()
    if (!requireAdmin(req, reply)) return
    const { id } = req.params as { id: string }
    const body = RoleSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалидна роля' })

    const actor = req.user as { id: number; email: string }
    const [updated] = await sql`
      UPDATE users SET role = ${body.data.role} WHERE id = ${id}
      RETURNING id, email, role
    `
    if (!updated) return reply.status(404).send({ error: 'Потребителят не е намерен' })

    // Журнал
    await sql`
      INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
      VALUES (${actor.id}, ${actor.email}, 'change_role', ${id},
              ${sql.json({ old_role: updated.role, new_role: body.data.role })})
    `
    return updated
  })

  app.patch('/users/:id/status', async (req, reply) => {
    await req.jwtVerify()
    if (!requireAdmin(req, reply)) return
    const { id } = req.params as { id: string }
    const body = StatusSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалиден статус' })

    const actor = req.user as { id: number; email: string }
    // Не позволяваме деактивиране на собствения акаунт
    if (String(actor.id) === id)
      return reply.status(400).send({ error: 'Не можете да деактивирате собствения си акаунт' })

    const [updated] = await sql`
      UPDATE users SET active = ${body.data.active} WHERE id = ${id}
      RETURNING id, email, role, active
    `
    if (!updated) return reply.status(404).send({ error: 'Потребителят не е намерен' })

    await sql`
      INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
      VALUES (${actor.id}, ${actor.email},
              ${body.data.active ? 'activate_user' : 'deactivate_user'},
              ${id}, ${sql.json({ email: updated.email })})
    `
    return updated
  })

  // ── Audit log ────────────────────────────────────────────────────────────

  app.get('/audit', async (req, reply) => {
    await req.jwtVerify()
    if (!requireAdmin(req, reply)) return
    const { limit = '50', offset = '0' } = req.query as { limit?: string; offset?: string }
    return sql`
      SELECT * FROM audit_log
      ORDER BY created_at DESC
      LIMIT ${Math.min(parseInt(limit), 200)}
      OFFSET ${parseInt(offset)}
    `
  })

  // ── Системна статистика ──────────────────────────────────────────────────

  app.get('/stats', async (req, reply) => {
    await req.jwtVerify()
    if (!requireAdmin(req, reply)) return
    const [stats] = await sql`
      SELECT
        (SELECT COUNT(*) FROM users)           AS total_users,
        (SELECT COUNT(*) FROM users WHERE role='citizen')    AS citizens,
        (SELECT COUNT(*) FROM users WHERE role='dispatcher') AS dispatchers,
        (SELECT COUNT(*) FROM cells)           AS total_cells,
        (SELECT COUNT(*) FROM risk_forecasts)  AS total_forecasts,
        (SELECT COUNT(*) FROM alerts)          AS total_alerts,
        (SELECT COUNT(*) FROM alerts WHERE status='confirmed') AS confirmed_alerts,
        (SELECT COUNT(*) FROM tower_alerts)    AS tower_alerts,
        (SELECT COUNT(*) FROM drones WHERE status != 'idle')  AS active_drones,
        (SELECT MAX(created_at) FROM risk_forecasts)          AS last_forecast_at
    `
    return stats
  })
}
