/**
 * Drones API
 * - GET /drones — списък (само dispatcher/admin)
 * - POST /dispatch/recon — изпращане на разузнавателен дрон
 * - POST /dispatch/tanker — изпращане на водоносен дрон
 * - PATCH /:id/status — обновяване на статус
 * - POST /:id/move — симулиране на движение (позиция по интерполация)
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import sql from '../db/client.js'
import { requireActiveUser } from '../services/authorization.js'

function requireOps(req: any, reply: any): boolean {
  const user = req.user as { role: string }
  if (!['dispatcher', 'admin'].includes(user.role)) {
    reply.status(403).send({ error: 'Само диспечери и администратори' })
    return false
  }
  return true
}

export default async function droneRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireActiveUser(['dispatcher', 'admin']))

  // ── GET /drones ──────────────────────────────────────────────────────────
  // Само dispatcher/admin — позициите на дроновете са оперативна информация
  app.get('/', async (req, reply) => {
    await req.jwtVerify()
    if (!requireOps(req, reply)) return
    return sql`
      SELECT
        d.*,
        ST_AsGeoJSON(d.base_geom)::json       AS base_geom,
        ST_AsGeoJSON(d.current_geom)::json    AS current_geom,
        ST_AsGeoJSON(d.mission_polygon)::json AS mission_polygon
      FROM drones d
      ORDER BY d.type, d.id
    `
  })

  // ── POST /dispatch/recon ─────────────────────────────────────────────────
  app.post('/dispatch/recon', async (req, reply) => {
    await req.jwtVerify()
    if (!requireOps(req, reply)) return

    const { tower_alert_id } = req.body as { tower_alert_id: number }
    const actor = req.user as { id: number; email: string }
    const result = await sql.begin(async tx => {
      const [alert] = await tx<{ id: number; lat: number; lon: number; status: string }[]>`
        SELECT id, lat, lon, status FROM tower_alerts WHERE id = ${tower_alert_id}
      `
      if (!alert) return { ok: false as const, error: 'Сигналът не е намерен', status: 404 as const }

      const [drone] = await tx<{ id: number; name: string; base_lat: number; base_lon: number }[]>`
        SELECT d.*
        FROM drones d
        WHERE d.type = 'recon' AND d.status = 'idle'
        ORDER BY ST_Distance(
          d.base_geom::geography,
          ST_SetSRID(ST_MakePoint(${alert.lon}, ${alert.lat}), 4326)::geography
        )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `
      if (!drone) return { ok: false as const, error: 'Няма свободен разузнавателен дрон в момента. Опитай след малко.', status: 409 as const }

      const delta = 0.009
      const missionPoly = `POLYGON((
        ${alert.lon - delta} ${alert.lat - delta},
        ${alert.lon + delta} ${alert.lat - delta},
        ${alert.lon + delta} ${alert.lat + delta},
        ${alert.lon - delta} ${alert.lat + delta},
        ${alert.lon - delta} ${alert.lat - delta}
      ))`
      const [updated] = await tx<{ id: number; name: string; status: string; base_lat: number; base_lon: number; tower_alert_id: number }[]>`
        UPDATE drones SET
          status = 'en_route', current_lat = base_lat, current_lon = base_lon,
          current_geom = base_geom,
          mission_polygon = ST_SetSRID(ST_GeomFromText(${missionPoly}), 4326),
          tower_alert_id = ${tower_alert_id}, updated_at = NOW()
        WHERE id = ${drone.id}
        RETURNING id, name, status, base_lat, base_lon, tower_alert_id
      `
      if (!updated) throw new Error('Failed to update dispatched drone')
      await tx`UPDATE tower_alerts SET drone_recon_id = ${drone.id}, updated_at = NOW() WHERE id = ${tower_alert_id}`
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${actor.id}, ${actor.email}, 'dispatch_drone', ${String(drone.id)},
          ${sql.json({ drone_type: 'recon', tower_alert_id })})
      `
      return { ok: true as const, drone: updated, baseLat: drone.base_lat, baseLon: drone.base_lon, targetLat: alert.lat, targetLon: alert.lon }
    })
    if (!result.ok) return reply.status(result.status).send({ error: result.error })
    startDroneAnimation(result.drone.id, result.baseLat, result.baseLon, result.targetLat, result.targetLon, 'recon', app)
    return { drone: result.drone, message: `${result.drone.name} изпратен към сигнал #${tower_alert_id}` }
  })

  app.post('/dispatch/citizen-alert', async (req, reply) => {
    await req.jwtVerify()
    if (!requireOps(req, reply)) return

    const body = z.object({ alert_id: z.number().int().positive() }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалиден граждански сигнал' })
    const { alert_id } = body.data
    const actor = req.user as { id: number; email: string }
    const result = await sql.begin(async tx => {
      const [alert] = await tx<{ id: number; lat: number; lon: number; status: string; drone_recon_id: number | null }[]>`
        SELECT id, lat, lon, status, drone_recon_id
        FROM alerts
        WHERE id = ${alert_id}
        FOR UPDATE
      `
      if (!alert) return { ok: false as const, error: 'Сигналът не е намерен', status: 404 as const }
      if (alert.status === 'dismissed')
        return { ok: false as const, error: 'Отхвърлен сигнал не може да получи дрон', status: 409 as const }
      if (alert.drone_recon_id)
        return { ok: false as const, error: 'Към този сигнал вече е изпратен дрон', status: 409 as const }

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
      if (!drone)
        return { ok: false as const, error: 'Няма свободен разузнавателен дрон в момента.', status: 409 as const }

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
      await tx`UPDATE alerts SET drone_recon_id = ${drone.id} WHERE id = ${alert.id}`
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${actor.id}, ${actor.email}, 'dispatch_drone', ${String(drone.id)},
          ${sql.json({ drone_type: 'recon', citizen_alert_id: alert.id })})
      `
      return { ok: true as const, alert, drone }
    })
    if (!result.ok) return reply.status(result.status).send({ error: result.error })
    startDroneAnimation(result.drone.id, result.drone.base_lat, result.drone.base_lon, result.alert.lat, result.alert.lon, 'recon', app)
    return { drone: result.drone, message: `${result.drone.name} изпратен към граждански сигнал #${alert_id}` }
  })

  app.post('/dispatch/citizen-alert/tanker', async (req, reply) => {
    await req.jwtVerify()
    if (!requireOps(req, reply)) return

    const body = z.object({ alert_id: z.number().int().positive() }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'Невалиден граждански сигнал' })
    const { alert_id } = body.data
    const actor = req.user as { id: number; email: string }
    const result = await sql.begin(async tx => {
      const [alert] = await tx<{
        id: number
        lat: number
        lon: number
        status: string
        drone_tanker_id: number | null
      }[]>`
        SELECT id, lat, lon, status, drone_tanker_id
        FROM alerts
        WHERE id = ${alert_id}
        FOR UPDATE
      `
      if (!alert) return { ok: false as const, error: 'Сигналът не е намерен', status: 404 as const }
      if (alert.status !== 'confirmed')
        return { ok: false as const, error: 'Водоноска може да се изпрати само към потвърден граждански сигнал', status: 409 as const }
      if (alert.drone_tanker_id)
        return { ok: false as const, error: 'Към този сигнал вече е изпратена водоноска', status: 409 as const }

      const [drone] = await tx<{ id: number; name: string; base_lat: number; base_lon: number }[]>`
        SELECT d.id, d.name, d.base_lat, d.base_lon
        FROM drones d
        WHERE d.type = 'tanker' AND d.status = 'idle'
        ORDER BY ST_Distance(
          d.base_geom::geography,
          ST_SetSRID(ST_MakePoint(${alert.lon}, ${alert.lat}), 4326)::geography
        )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `
      if (!drone)
        return { ok: false as const, error: 'Няма свободна водоноска в момента.', status: 409 as const }

      const delta = 0.005
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
      await tx`UPDATE alerts SET drone_tanker_id = ${drone.id} WHERE id = ${alert.id}`
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${actor.id}, ${actor.email}, 'dispatch_drone', ${String(drone.id)},
          ${sql.json({ drone_type: 'tanker', citizen_alert_id: alert.id })})
      `
      return { ok: true as const, alert, drone }
    })
    if (!result.ok) return reply.status(result.status).send({ error: result.error })
    startDroneAnimation(result.drone.id, result.drone.base_lat, result.drone.base_lon, result.alert.lat, result.alert.lon, 'tanker', app)
    return { drone: result.drone, message: `${result.drone.name} изпратена към граждански сигнал #${alert_id}` }
  })

  // ── POST /dispatch/tanker ─────────────────────────────────────────────────
  app.post('/dispatch/tanker', async (req, reply) => {
    await req.jwtVerify()
    if (!requireOps(req, reply)) return

    const { tower_alert_id } = req.body as { tower_alert_id: number }
    const actor = req.user as { id: number; email: string }
    const result = await sql.begin(async tx => {
      const [alert] = await tx<{ id: number; lat: number; lon: number; status: string }[]>`
        SELECT id, lat, lon, status FROM tower_alerts WHERE id = ${tower_alert_id} FOR SHARE
      `
      if (!alert) return { ok: false as const, error: 'Сигналът не е намерен', status: 404 as const }
      if (alert.status !== 'confirmed')
        return { ok: false as const, error: 'Водоноска може да се изпрати само към потвърден пожар', status: 409 as const }

      const [drone] = await tx<{ id: number; name: string; base_lat: number; base_lon: number }[]>`
        SELECT d.*
        FROM drones d
        WHERE d.type = 'tanker' AND d.status = 'idle'
        ORDER BY ST_Distance(
          d.base_geom::geography,
          ST_SetSRID(ST_MakePoint(${alert.lon}, ${alert.lat}), 4326)::geography
        )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `
      if (!drone) return { ok: false as const, error: 'Няма свободна водоноска в момента.', status: 409 as const }

      const delta = 0.005
      const missionPoly = `POLYGON((
        ${alert.lon - delta} ${alert.lat - delta},
        ${alert.lon + delta} ${alert.lat - delta},
        ${alert.lon + delta} ${alert.lat + delta},
        ${alert.lon - delta} ${alert.lat + delta},
        ${alert.lon - delta} ${alert.lat - delta}
      ))`
      const [updated] = await tx<{ id: number; name: string; status: string; base_lat: number; base_lon: number; tower_alert_id: number }[]>`
        UPDATE drones SET
          status = 'en_route', current_lat = base_lat, current_lon = base_lon,
          current_geom = base_geom,
          mission_polygon = ST_SetSRID(ST_GeomFromText(${missionPoly}), 4326),
          tower_alert_id = ${tower_alert_id}, updated_at = NOW()
        WHERE id = ${drone.id}
        RETURNING id, name, status, base_lat, base_lon, tower_alert_id
      `
      if (!updated) throw new Error('Failed to update dispatched drone')
      await tx`UPDATE tower_alerts SET drone_tanker_id = ${drone.id}, updated_at = NOW() WHERE id = ${tower_alert_id}`
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${actor.id}, ${actor.email}, 'dispatch_drone', ${String(drone.id)},
          ${sql.json({ drone_type: 'tanker', tower_alert_id })})
      `
      return { ok: true as const, drone: updated, baseLat: drone.base_lat, baseLon: drone.base_lon, targetLat: alert.lat, targetLon: alert.lon }
    })
    if (!result.ok) return reply.status(result.status).send({ error: result.error })
    startDroneAnimation(result.drone.id, result.baseLat, result.baseLon, result.targetLat, result.targetLon, 'tanker', app)
    return { drone: result.drone, message: `${result.drone.name} изпратена към пожар #${tower_alert_id}` }
  })

  // ── PATCH /:id/status ────────────────────────────────────────────────────
  app.patch('/:id/status', async (req, reply) => {
    await req.jwtVerify()
    if (!requireOps(req, reply)) return

    const { id } = req.params as { id: string }
    const actor = req.user as { id: number; email: string }
    const { status, current_lat, current_lon } = req.body as {
      status: string; current_lat?: number; current_lon?: number
    }
    const valid = ['idle', 'en_route', 'inspecting', 'firefighting', 'returning']
    if (!valid.includes(status))
      return reply.status(400).send({ error: 'Невалиден статус' })

    const updated = await sql.begin(async tx => {
      const [drone] = await tx`
        UPDATE drones SET
          status       = ${status},
          current_lat  = COALESCE(${current_lat ?? null}::double precision, current_lat),
          current_lon  = COALESCE(${current_lon ?? null}::double precision, current_lon),
          current_geom = CASE
            WHEN ${current_lat ?? null}::double precision IS NOT NULL
              OR ${current_lon ?? null}::double precision IS NOT NULL
            THEN ST_SetSRID(ST_MakePoint(
              COALESCE(${current_lon ?? null}::double precision, current_lon, base_lon),
              COALESCE(${current_lat ?? null}::double precision, current_lat, base_lat)
            ), 4326)
            ELSE current_geom
          END,
          tower_alert_id = CASE WHEN ${status} = 'idle' THEN NULL ELSE tower_alert_id END,
          citizen_alert_id = CASE WHEN ${status} = 'idle' THEN NULL ELSE citizen_alert_id END,
          updated_at   = NOW()
        WHERE id = ${id}
        RETURNING id, name, status, current_lat, current_lon
      `
      if (!drone) return null
      await tx`
        INSERT INTO audit_log (actor_id, actor_email, action, target_id, details)
        VALUES (${actor.id}, ${actor.email}, 'drone_status_changed', ${id},
          ${sql.json({ status })})
      `
      return drone
    })
    if (!updated) return reply.status(404).send({ error: 'Дронът не е намерен' })
    return updated
  })
}

/**
 * Симулира движението на дрон по права линия.
 * en_route (10s) → inspecting/firefighting (8s) → returning (10s) → idle
 * Обновява current_geom на всяка секунда.
 */
export function startDroneAnimation(
  droneId: number,
  baseLat: number, baseLon: number,
  targetLat: number, targetLon: number,
  type: 'recon' | 'tanker',
  app: FastifyInstance
) {
  const MOVE_STEPS = 30
  const MISSION_DURATION = 8000  // ms на мисия

  const toTarget = interpolatePath(baseLat, baseLon, targetLat, targetLon, MOVE_STEPS)
  const toBase   = interpolatePath(targetLat, targetLon, baseLat, baseLon, MOVE_STEPS)

  let step = 0
  // Фаза 1: en_route към целта
  const phase1 = setInterval(async () => {
    step++
    const pos = toTarget[Math.min(step, toTarget.length - 1)]
    try {
      await sql`
        UPDATE drones SET
          current_lat  = ${pos.lat},
          current_lon  = ${pos.lon},
          current_geom = ST_SetSRID(ST_MakePoint(${pos.lon}, ${pos.lat}), 4326),
          updated_at   = NOW()
        WHERE id = ${droneId}
      `
    } catch (err) {
      app.log.error({ err, droneId }, 'Грешка при обновяване позицията на дрона')
    }

    if (step >= MOVE_STEPS) {
      clearInterval(phase1)
      const missionStatus = type === 'recon' ? 'inspecting' : 'firefighting'
      // Пристигна — сменяме статуса
      await sql`UPDATE drones SET status = ${missionStatus}, updated_at = NOW() WHERE id = ${droneId}`
        .catch(err => { app.log.error({ err, droneId }, 'Грешка при промяна статуса на дрона') })

      // Фаза 2: мисия на целта
      setTimeout(async () => {
        await sql`UPDATE drones SET status = 'returning', updated_at = NOW() WHERE id = ${droneId}`
          .catch(err => { app.log.error({ err, droneId }, 'Грешка при промяна статуса на дрона') })
        let retStep = 0
        // Фаза 3: en_route обратно към базата
        const phase3 = setInterval(async () => {
          retStep++
          const retPos = toBase[Math.min(retStep, toBase.length - 1)]
          try {
            await sql`
              UPDATE drones SET
                current_lat  = ${retPos.lat},
                current_lon  = ${retPos.lon},
                current_geom = ST_SetSRID(ST_MakePoint(${retPos.lon}, ${retPos.lat}), 4326),
                updated_at   = NOW()
              WHERE id = ${droneId}
            `
          } catch (err) {
            app.log.error({ err, droneId }, 'Грешка при обновяване позицията на дрона')
          }

          if (retStep >= MOVE_STEPS) {
            clearInterval(phase3)
            // Прибрал се — idle
            sql`
              UPDATE drones SET
                status = 'idle', tower_alert_id = NULL, citizen_alert_id = NULL,
                mission_polygon = NULL, updated_at = NOW()
              WHERE id = ${droneId}
            `.catch(err => { app.log.error({ err, droneId }, 'Грешка при приключване на мисията') })
          }
        }, 1000)
      }, MISSION_DURATION)
    }
  }, 1000)
}

function interpolatePath(
  startLat: number, startLon: number,
  endLat: number,   endLon: number,
  steps: number
): { lat: number; lon: number }[] {
  const pts = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    pts.push({
      lat: +(startLat + (endLat - startLat) * t).toFixed(5),
      lon: +(startLon + (endLon - startLon) * t).toFixed(5),
    })
  }
  return pts
}
