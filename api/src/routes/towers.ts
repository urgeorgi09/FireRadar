import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import sql from '../db/client.js'
import { requireActiveUser } from '../services/authorization.js'

const TowerAlertSchema = z.object({
  lat:        z.number().min(41).max(44),
  lon:        z.number().min(22).max(29),
  confidence: z.number().min(0).max(1).default(0.8),
})

export default async function towerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireActiveUser(['dispatcher', 'admin']))

  // Всички кули с покривни зони
  app.get('/', async () => {
    return sql`
      SELECT
        id, name, lat, lon,
        ST_AsGeoJSON(geom)::json        AS geom,
        ST_AsGeoJSON(cover_zone)::json  AS cover_zone,
        radius_km, status
      FROM watch_towers
      ORDER BY id
    `
  })

  // Сигнал от кула (само dispatcher/admin)
  app.post('/:id/alert', async (req, reply) => {
    const user = req.user as { id: number; email: string }
    const { id } = req.params as { id: string }
    const body = TowerAlertSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалидни данни' })

    const alert = await sql.begin(async tx => {
      const [created] = await tx`
        INSERT INTO tower_alerts (tower_id, lat, lon, geom, confidence)
        VALUES (
          ${id}, ${body.data.lat}, ${body.data.lon},
          ST_SetSRID(ST_MakePoint(${body.data.lon}, ${body.data.lat}), 4326),
          ${body.data.confidence}
        )
        RETURNING *
      `
      if (!created) throw new Error('Failed to create tower alert')
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${user.id}, ${user.email}, 'tower_alert_created', ${String(created.id)},
          ${sql.json({ tower_id: id, confidence: body.data.confidence })})
      `
      return created
    })
    return alert
  })

  // Всички активни сигнали от кули
  app.get('/alerts', async () => {
    return sql`
      SELECT
        ta.*,
        ST_AsGeoJSON(ta.geom)::json AS geom,
        wt.name AS tower_name
      FROM tower_alerts ta
      JOIN watch_towers wt ON wt.id = ta.tower_id
      ORDER BY ta.created_at DESC
      LIMIT 100
    `
  })

  // Обновяване на статус на сигнал
  app.patch('/alerts/:id', async (req, reply) => {
    const user = req.user as { id: number; email: string }
    const { id } = req.params as { id: string }
    const { status } = req.body as { status: string }
    const valid = ['pending', 'confirmed', 'false_alarm', 'extinguished']
    if (!valid.includes(status))
      return reply.status(400).send({ error: 'Невалиден статус' })

    const updated = await sql.begin(async tx => {
      const [alert] = await tx`
        UPDATE tower_alerts
        SET status = ${status}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
      if (!alert) return null
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${user.id}, ${user.email}, ${`tower_alert_${status}`}, ${id},
          ${sql.json({ status })})
      `
      return alert
    })
    if (!updated) return reply.status(404).send({ error: 'Сигналът не е намерен' })
    return updated
  })
}
