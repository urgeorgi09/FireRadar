import sql from '../db/client.js'

export async function recoverDrones() {
  const drones = await sql`
    UPDATE drones
    SET status = 'idle',
        current_lat = base_lat,
        current_lon = base_lon,
        current_geom = base_geom,
        mission_polygon = NULL,
        citizen_alert_id = NULL,
        updated_at = NOW()
    WHERE status <> 'idle'
    RETURNING id
  `
  if (drones.length)
    console.warn(`[WARN] Върнати са ${drones.length} дрона в idle след рестарт на API`)
}
