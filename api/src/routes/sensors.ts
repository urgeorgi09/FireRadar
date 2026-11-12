/**
 * Sensor API — endpoint за приемане на данни от сензори на кули.
 * Автентикация: X-API-Key header (или Bearer token за диспечери).
 *
 * Използване:
 *   POST /sensors/tower-alert
 *   Headers: X-API-Key: <ключ>
 *   Body: { lat, lon, confidence, smoke_density?, temperature? }
 *
 * Кулата извиква този endpoint когато сензорът засече дим/топлина.
 * Демо симулатор: GET /sensors/simulate/:tower_id  (само за dispatcher/admin)
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import sql from '../db/client.js'
import { generateSensorApiKey, hashSensorApiKey } from '../services/sensorApiKey.js'
import { requireActiveUser } from '../services/authorization.js'

const AlertPayloadSchema = z.object({
  lat:             z.number().min(41).max(44),
  lon:             z.number().min(22).max(29),
  confidence:      z.number().min(0).max(1).default(0.8),
  smoke_density:   z.number().optional(),   // 0-1, опционален сензорен показател
  temperature:     z.number().optional(),   // °C от термален сензор
})

export default async function sensorRoutes(app: FastifyInstance) {
  // ── Сензорен endpoint (X-API-Key) ────────────────────────────────────────
  app.post('/tower-alert', async (req, reply) => {
    const header = req.headers['x-api-key']
    const apiKey = typeof header === 'string' ? header.trim() : undefined
    if (!apiKey)
      return reply.status(401).send({ error: 'Липсва X-API-Key header' })

    // Проверка на ключа и намиране на кулата
    const [keyRow] = await sql`
      SELECT k.tower_id, k.active, wt.name AS tower_name
      FROM sensor_api_keys k
      JOIN watch_towers wt ON wt.id = k.tower_id
      WHERE k.api_key_hash = ${hashSensorApiKey(apiKey)}
    `
    if (!keyRow)
      return reply.status(401).send({ error: 'Невалиден API ключ' })
    if (!keyRow.active)
      return reply.status(403).send({ error: 'API ключът е деактивиран' })

    const body = AlertPayloadSchema.safeParse(req.body)
    if (!body.success)
      return reply.status(400).send({ error: 'Невалидни данни', details: body.error.issues })

    const { lat, lon, confidence } = body.data

    const [alert] = await sql`
      INSERT INTO tower_alerts (tower_id, lat, lon, geom, confidence)
      VALUES (
        ${keyRow.tower_id},
        ${lat}, ${lon},
        ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326),
        ${confidence}
      )
      RETURNING id, tower_id, lat, lon, confidence, status, created_at
    `

    app.log.info({ towerId: keyRow.tower_id, confidence }, 'Получен е сигнал от сензор на кула')
    return { alert, tower: { id: keyRow.tower_id, name: keyRow.tower_name } }
  })

  // ── Демо симулатор ────────────────────────────────────────────────────────
  // Генерира реалистичен сигнал от избрана кула (само за dispatcher/admin)
  app.post('/simulate/:tower_id', {
    preHandler: requireActiveUser(['dispatcher', 'admin']),
  }, async (req, reply) => {
    await req.jwtVerify()
    const user = req.user as { role: string }
    if (!['dispatcher', 'admin'].includes(user.role))
      return reply.status(403).send({ error: 'Само диспечери и администратори' })

    const { tower_id } = req.params as { tower_id: string }
    const [tower] = await sql`SELECT * FROM watch_towers WHERE id = ${tower_id}`
    if (!tower) return reply.status(404).send({ error: 'Кулата не е намерена' })

    // Добавяме малко случайно отклонение (~0-5 км) от центъра на кулата
    const jitter = () => (Math.random() - 0.5) * 0.08
    const lat = +(tower.lat + jitter()).toFixed(5)
    const lon = +(tower.lon + jitter()).toFixed(5)
    const confidence = +(0.65 + Math.random() * 0.35).toFixed(2)  // 0.65–1.00

    const [alert] = await sql`
      INSERT INTO tower_alerts (tower_id, lat, lon, geom, confidence)
      VALUES (${tower.id}, ${lat}, ${lon},
              ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326),
              ${confidence})
      RETURNING id, tower_id, lat, lon, confidence, status, created_at
    `

    return {
      message: `Симулиран сигнал от "${tower.name}"`,
      alert,
      note: 'Това е тестов сигнал, генериран от симулатора. При реална работа се изпраща от сензора на кулата чрез POST /sensors/tower-alert с X-API-Key header.'
    }
  })

  // ── Управление на API ключове (само admin) ────────────────────────────────
  app.get('/keys', { preHandler: requireActiveUser(['admin']) }, async (req, reply) => {
    await req.jwtVerify()
    const user = req.user as { role: string }
    if (user.role !== 'admin') return reply.status(403).send({ error: 'Само администратори' })
    return sql`
      SELECT k.id, k.tower_id, wt.name AS tower_name,
             k.description, k.active, k.created_at
      FROM sensor_api_keys k
      JOIN watch_towers wt ON wt.id = k.tower_id
      ORDER BY k.created_at DESC
    `
  })

  app.post('/keys', { preHandler: requireActiveUser(['admin']) }, async (req, reply) => {
    await req.jwtVerify()
    const user = req.user as { role: string }
    if (user.role !== 'admin') return reply.status(403).send({ error: 'Само администратори' })

    const body = z.object({
      tower_id: z.number().int().positive(),
      description: z.string().max(200).optional(),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалидни данни за API ключ' })

    const apiKey = generateSensorApiKey()
    const apiKeyHash = hashSensorApiKey(apiKey)

    const [key] = await sql`
      INSERT INTO sensor_api_keys (tower_id, api_key_hash, description)
      VALUES (${body.data.tower_id}, ${apiKeyHash}, ${body.data.description ?? null})
      RETURNING id, tower_id, description, created_at
    `
    return { ...key, api_key: apiKey }
  })
}
