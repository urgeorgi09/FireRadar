import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import sql from '../db/client.js'
import { loadBulgariaBoundaryGeoJSON } from '../services/bulgariaBoundary.js'
import { verifyTurnstile } from '../services/turnstile.js'
import { requireActiveUser } from '../services/authorization.js'
import { startDroneAnimation } from './drones.js'

const AlertSchema = z.object({
  lat: z.number()
    .min(41.24, 'Координатата е извън България (N)')
    .max(44.21, 'Координатата е извън България (N)'),
  lon: z.number()
    .min(22.36, 'Координатата е извън България (E)')
    .max(28.61, 'Координатата е извън България (E)'),
  description: z.string()
    .max(500, 'Описанието е прекалено дълго (макс. 500 знака)')
    .optional(),
  captchaToken: z.string().min(1, 'Потвърди CAPTCHA проверката'),
})

export default async function alertRoutes(app: FastifyInstance) {
  const boundaryGeoJSON = loadBulgariaBoundaryGeoJSON()

  // Публично подаване без акаунт; Turnstile и IP rate limit ограничават спама.
  app.post('/', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
  }, async (req, reply) => {
    const body = AlertSchema.safeParse(req.body)
    if (!body.success) {
      const msg = body.error.issues[0]?.message ?? 'Невалидни данни'
      return reply.status(400).send({ error: msg })
    }
    const [{ inside }] = await sql`
      SELECT ST_Intersects(
        ST_SetSRID(ST_MakePoint(${body.data.lon}, ${body.data.lat}), 4326),
        ST_SetSRID(ST_GeomFromGeoJSON(${boundaryGeoJSON}), 4326)
      ) AS inside
    `
    if (!inside) return reply.status(400).send({ error: 'Координатите трябва да са в България' })

    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY
    if (!turnstileSecret) {
      req.log.error('TURNSTILE_SECRET_KEY не е конфигуриран')
      return reply.status(503).send({ error: 'Защитата от спам временно не е конфигурирана.' })
    }
    let captchaValid: boolean
    try {
      captchaValid = await verifyTurnstile(body.data.captchaToken, turnstileSecret)
    } catch (err) {
      req.log.error({ err }, 'Грешка при проверка на Turnstile')
      return reply.status(503).send({ error: 'Проверката CAPTCHA временно е недостъпна. Опитай отново.' })
    }
    if (!captchaValid)
      return reply.status(400).send({ error: 'CAPTCHA проверката е невалидна. Опитай отново.' })

    const result = await sql.begin(async tx => {
      const [alert] = await tx<{ id: number; lat: number; lon: number; drone_recon_id: number | null }[]>`
        INSERT INTO alerts (user_id, lat, lon, description)
        VALUES (NULL, ${body.data.lat}, ${body.data.lon}, ${body.data.description ?? null})
        RETURNING *
      `
      if (!alert) throw new Error('Failed to create citizen alert')

      const [drone] = await tx<{ id: number; name: string; base_lat: number; base_lon: number }[]>`
        SELECT d.id, d.name, d.base_lat, d.base_lon
        FROM drones d
        WHERE d.type = 'recon' AND d.status = 'idle'
        ORDER BY ST_Distance(
          d.base_geom::geography,
          ST_SetSRID(ST_MakePoint(${alert.lon}, ${alert.lat}), 4326)::geography
        )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `
      if (!drone) return { alert, drone: null }

      const delta = 0.009
      const missionPoly = `POLYGON((
        ${alert.lon - delta} ${alert.lat - delta},
        ${alert.lon + delta} ${alert.lat - delta},
        ${alert.lon + delta} ${alert.lat + delta},
        ${alert.lon - delta} ${alert.lat + delta},
        ${alert.lon - delta} ${alert.lat - delta}
      ))`
      await tx`
        UPDATE drones SET
          status = 'en_route',
          current_lat = base_lat,
          current_lon = base_lon,
          current_geom = base_geom,
          mission_polygon = ST_SetSRID(ST_GeomFromText(${missionPoly}), 4326),
          citizen_alert_id = ${alert.id},
          updated_at = NOW()
        WHERE id = ${drone.id}
      `
      const [updatedAlert] = await tx<{ id: number; lat: number; lon: number; drone_recon_id: number }[]>`
        UPDATE alerts SET drone_recon_id = ${drone.id} WHERE id = ${alert.id} RETURNING *
      `
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (NULL, 'system@fireradar-bg.org', 'auto_dispatch_recon', ${String(drone.id)},
          ${sql.json({ drone_type: 'recon', citizen_alert_id: alert.id })})
      `
      if (!updatedAlert) throw new Error('Failed to link reconnaissance drone to citizen alert')
      return { alert: updatedAlert, drone }
    })
    if (result.drone) {
      startDroneAnimation(
        result.drone.id,
        result.drone.base_lat,
        result.drone.base_lon,
        result.alert.lat,
        result.alert.lon,
        'recon',
        app,
      )
    }
    return result.alert
  })

  // Диспечер/Admin вижда всички сигнали
  app.get('/', { preHandler: requireActiveUser(['dispatcher', 'admin']) }, async (req, reply) => {
    await req.jwtVerify()
    const user = req.user as { role: string }
    if (!['dispatcher', 'admin'].includes(user.role))
      return reply.status(403).send({ error: 'Забранен достъп' })

    return sql`
      SELECT a.*,
             u.email AS reporter_email,
             recon.name AS drone_recon_name,
             recon.status AS drone_recon_status,
             tanker.name AS drone_tanker_name,
             tanker.status AS drone_tanker_status
      FROM alerts a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN drones recon ON recon.id = a.drone_recon_id
      LEFT JOIN drones tanker ON tanker.id = a.drone_tanker_id
      ORDER BY a.created_at DESC
      LIMIT 200
    `
  })

  // Диспечер потвърждава/отхвърля сигнал
  app.patch('/:id', { preHandler: requireActiveUser(['dispatcher', 'admin']) }, async (req, reply) => {
    await req.jwtVerify()
    const user = req.user as { role: string; id: number; email: string }
    if (!['dispatcher', 'admin'].includes(user.role))
      return reply.status(403).send({ error: 'Забранен достъп' })

    const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params)
    const body = z.object({ status: z.enum(['confirmed', 'dismissed', 'extinguished']) }).safeParse(req.body)
    if (!params.success || !body.success)
      return reply.status(400).send({ error: 'Невалиден статус' })
    const { id } = params.data
    const { status } = body.data

    const updated = await sql.begin(async tx => {
      const [current] = await tx<{ id: number; status: string }[]>`
        SELECT id, status FROM alerts WHERE id = ${id} FOR UPDATE
      `
      if (!current) return { ok: false as const, error: 'Сигналът не е намерен', statusCode: 404 as const }
      if (status === 'extinguished' && current.status !== 'confirmed')
        return { ok: false as const, error: 'Само потвърден сигнал може да бъде отбелязан като угасен', statusCode: 409 as const }

      const [alert] = await tx`UPDATE alerts SET status = ${status} WHERE id = ${id} RETURNING *`
      if (!alert) throw new Error('Failed to update citizen alert status')
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${user.id}, ${user.email}, ${`alert_${status}`}, ${id},
                ${sql.json({ status, alert_id: id })})
      `
      return { ok: true as const, alert }
    })
    if (!updated.ok) return reply.status(updated.statusCode).send({ error: updated.error })

    return updated.alert
  })
}
