/**
 * Admin-only routes — управление на потребители, audit log, статистика.
 * Auth: requireActiveUser(['admin']) hook в plugin обхвата.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import sql from '../db/client.js'
import { requireActiveUser } from '../services/authorization.js'

const RoleSchema   = z.object({ role: z.enum(['citizen', 'dispatcher', 'admin']) })
const StatusSchema = z.object({ active: z.boolean() })

export default async function adminRoutes(app: FastifyInstance) {
  // Един hook за целия plugin — проверява JWT и admin роля
  app.addHook('preHandler', requireActiveUser(['admin']))

  // ── Потребители ──────────────────────────────────────────────────────────

  app.get('/users', async () => {
    return sql`SELECT id, email, role, active, created_at FROM users ORDER BY created_at DESC`
  })

  app.patch('/users/:id/role', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = RoleSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалидна роля' })

    const actor = req.user as { id: number; email: string }

    // Четем старата роля ПРЕДИ UPDATE — RETURNING връща вече новата
    const [before] = await sql`SELECT role FROM users WHERE id = ${id}`
    if (!before) return reply.status(404).send({ error: 'Потребителят не е намерен' })

    const [updated] = await sql`
      UPDATE users SET role = ${body.data.role} WHERE id = ${id}
      RETURNING id, email, role
    `
    if (!updated) return reply.status(404).send({ error: 'Потребителят не е намерен' })

    await sql`
      INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
      VALUES (${actor.id}, ${actor.email}, 'change_role', ${id},
              ${sql.json({ old_role: before.role, new_role: body.data.role })})
    `
    return updated
  })

  app.patch('/users/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = StatusSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалиден статус' })

    const actor = req.user as { id: number; email: string }
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

  app.get('/audit', async (req) => {
    const { limit = '50', offset = '0' } = req.query as { limit?: string; offset?: string }
    return sql`
      SELECT * FROM audit_log
      ORDER BY created_at DESC
      LIMIT ${Math.min(parseInt(limit), 200)}
      OFFSET ${parseInt(offset)}
    `
  })

  // ── Системна статистика ──────────────────────────────────────────────────

  app.get('/stats', async () => {
    const [stats] = await sql`
      SELECT
        (SELECT COUNT(*) FROM users)                             AS total_users,
        (SELECT COUNT(*) FROM users WHERE role='citizen')        AS citizens,
        (SELECT COUNT(*) FROM users WHERE role='dispatcher')     AS dispatchers,
        (SELECT COUNT(*) FROM cells)                             AS total_cells,
        (SELECT COUNT(*) FROM risk_forecasts)                    AS total_forecasts,
        (SELECT COUNT(*) FROM alerts)                            AS total_alerts,
        (SELECT COUNT(*) FROM alerts WHERE status='confirmed')   AS confirmed_alerts,
        (SELECT COUNT(*) FROM tower_alerts)                      AS tower_alerts,
        (SELECT COUNT(*) FROM drones WHERE status != 'idle')     AS active_drones,
        (SELECT MAX(created_at) FROM risk_forecasts)             AS last_forecast_at
    `
    return stats
  })
}
