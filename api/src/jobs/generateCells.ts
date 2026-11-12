/**
 * Генерира мрежа от клетки ~10×10 км за България и ги записва в cells.
 * Присвоява veg_type от CORINE Land Cover 2018 чрез nearest-centroid.
 * Филтрира клетките по реалната граница на България (ST_Intersects).
 * При стартиране допълва липсващи клетки, като PostGIS филтрира по реалната граница.
 */
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import sql from '../db/client.js'
import { loadBulgariaBoundaryGeoJSON } from '../services/bulgariaBoundary.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/jobs/ -> ../../../data/  (локално) или /app/data/ (Docker volume)
const CLC_PATH = existsSync('/app/data/clc2018_bgr.geojson')
  ? '/app/data/clc2018_bgr.geojson'
  : join(__dirname, '../../../data/clc2018_bgr.geojson')

// CLC Code_18 → veg_type (1=гора, 2=храсталаци, 3=земеделие, 4=друго)
function clcToVeg(code: string | number): number {
  const c = parseInt(String(code).slice(0, 3), 10)
  if ([311, 312, 313].includes(c))              return 1
  if ([321, 322, 323, 324, 333].includes(c))    return 2
  if (c >= 200 && c <= 244)                     return 3
  return 4
}

// Строим lookup: за всеки CLC полигон вземаме bbox centroid → {lat, lon, veg}
function buildClcCentroids(): { lat: number; lon: number; veg: number }[] {
  if (!existsSync(CLC_PATH)) {
    console.log('  CLC файл не е намерен — veg_type=4 за всички клетки')
    return []
  }
  console.log('  Зареждам CLC центроиди...')
  const gj = JSON.parse(readFileSync(CLC_PATH, 'utf-8'))
  const centroids: { lat: number; lon: number; veg: number }[] = []
  for (const feat of gj.features) {
    try {
      const coords: number[][][] = feat.geometry.type === 'Polygon'
        ? feat.geometry.coordinates
        : feat.geometry.coordinates.flat()  // MultiPolygon
      // bbox centroid
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const ring of coords) {
        for (const [x, y] of ring) {
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
        }
      }
      centroids.push({
        lon: (minX + maxX) / 2,
        lat: (minY + maxY) / 2,
        veg: clcToVeg(feat.properties?.Code_18 ?? ''),
      })
    } catch { /* skip malformed */ }
  }
  console.log(`  [OK] ${centroids.length} CLC центроиди`)
  return centroids
}

function nearestVeg(lat: number, lon: number, centroids: { lat: number; lon: number; veg: number }[]): number {
  if (!centroids.length) return 4
  let best = 4, bestDist = Infinity
  for (const c of centroids) {
    const d = (lat - c.lat) ** 2 + (lon - c.lon) ** 2
    if (d < bestDist) { bestDist = d; best = c.veg }
  }
  return best
}

export async function generateCells() {
  const boundaryGeoJSON = loadBulgariaBoundaryGeoJSON()
  console.log('  [OK] Граница на България заредена за ST_Intersects')

  const STEP = 0.1
  const candidates: { lat: number; lon: number }[] = []

  for (let lat = 41.24; lat < 44.21; lat += STEP) {
    for (let lon = 22.36; lon < 28.61; lon += STEP) {
      const centerLat = +(lat + STEP / 2).toFixed(4)
      const centerLon = +(lon + STEP / 2).toFixed(4)
      candidates.push({ lat: centerLat, lon: centerLon })
    }
  }

  const missingCells = await sql<{ lat: number; lon: number }[]>`
    SELECT r.lat, r.lon
    FROM jsonb_to_recordset(${sql.json(candidates)}) AS r(lat float, lon float)
    WHERE ST_Intersects(
      ST_SetSRID(ST_MakeEnvelope(
        r.lon - ${STEP / 2}, r.lat - ${STEP / 2},
        r.lon + ${STEP / 2}, r.lat + ${STEP / 2}
      ), 4326),
      ST_SetSRID(ST_GeomFromGeoJSON(${boundaryGeoJSON}), 4326)
    )
    AND ST_Dimension(ST_Intersection(
      ST_SetSRID(ST_MakeEnvelope(
        r.lon - ${STEP / 2}, r.lat - ${STEP / 2},
        r.lon + ${STEP / 2}, r.lat + ${STEP / 2}
      ), 4326),
      ST_SetSRID(ST_GeomFromGeoJSON(${boundaryGeoJSON}), 4326)
    )) = 2
    AND NOT EXISTS (
      SELECT 1 FROM cells c WHERE c.lat = r.lat AND c.lon = r.lon
    )
  `
  if (!missingCells.length) {
    const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM cells`
    console.log(`Клетките вече са генерирани: ${total}`)
    return
  }

  const clcCentroids = buildClcCentroids()
  const rows = missingCells.map(({ lat, lon }) => ({
    lat, lon, veg_type: nearestVeg(lat, lon, clcCentroids),
  }))
  console.log(`Добавям ${rows.length} липсващи кандидата; точната граница се проверява с ST_Intersects...`)
  const BATCH = 500
  let inserted = 0

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)

    const insertedRows = await sql`
      INSERT INTO cells (lat, lon, veg_type, center, geom)
      SELECT r.lat, r.lon, r.veg_type,
        ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326),
        ST_GeometryN(ST_CollectionExtract(ST_Intersection(
          ST_SetSRID(ST_MakeEnvelope(
            r.lon - ${STEP / 2}, r.lat - ${STEP / 2},
            r.lon + ${STEP / 2}, r.lat + ${STEP / 2}
          ), 4326),
          ST_SetSRID(ST_GeomFromGeoJSON(${boundaryGeoJSON}), 4326)
        ), 3), 1)
      FROM jsonb_to_recordset(${sql.json(batch)}) AS r(lat float, lon float, veg_type int)
      WHERE ST_Intersects(
        ST_SetSRID(ST_MakeEnvelope(
          r.lon - ${STEP / 2}, r.lat - ${STEP / 2},
          r.lon + ${STEP / 2}, r.lat + ${STEP / 2}
        ), 4326),
        ST_SetSRID(ST_GeomFromGeoJSON(${boundaryGeoJSON}), 4326)
      )
      AND ST_Dimension(ST_Intersection(
        ST_SetSRID(ST_MakeEnvelope(
          r.lon - ${STEP / 2}, r.lat - ${STEP / 2},
          r.lon + ${STEP / 2}, r.lat + ${STEP / 2}
        ), 4326),
        ST_SetSRID(ST_GeomFromGeoJSON(${boundaryGeoJSON}), 4326)
      )) = 2
      AND NOT EXISTS (
        SELECT 1 FROM cells c WHERE c.lat = r.lat AND c.lon = r.lon
      )
      RETURNING id
    `
    inserted += insertedRows.length
  }

  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM cells`
  console.log(`[OK] Добавени ${inserted} клетки в границата; общо ${total}`)
}
