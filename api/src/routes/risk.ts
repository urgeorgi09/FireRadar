import type { FastifyInstance } from 'fastify'
import sql from '../db/client.js'
import { predictRisk } from '../services/model.js'
import { fetchOpenMeteoArchive } from '../services/openMeteo.js'
import { fwiStep, fwiSeries, INITIAL_STATE, fwiToRiskLevel, type Weather } from '../services/fwi.js'
import { loadBulgariaBoundaryGeoJSON } from '../services/bulgariaBoundary.js'

type ReplayCell = {
  id: number
  lat: number
  lon: number
  geom: unknown
  fwi: number
  risk_level: string
  risk_score: number
  risk_source: 'model' | 'fwi'
  explanation: string
  precipitation_mm: number
  forecast_at: string
}

const REPLAY_CACHE_TTL_MS = 30 * 60 * 1000
const REPLAY_CACHE_MAX_ENTRIES = 10
const replayCache = new Map<string, { expiresAt: number; cells: ReplayCell[] }>()

// ---------- helpers ----------

/**
 * Взима 30 дни предистория + целевата дата от Archive API (hourly).
 * Пресмята FWI серията за всяка точка и връща стойностите за целевия ден.
 */
async function fetchArchiveBatch(
  points: { lat: number; lon: number }[],
  date: string
): Promise<Map<string, { temp: number; humidity: number; windSpeed: number; precip: number; fwiVal: number }>> {
  const result = new Map<string, { temp: number; humidity: number; windSpeed: number; precip: number; fwiVal: number }>()
  const BATCH = 20   // по-малко за hourly (повече данни)

  const startDate = new Date(date)
  startDate.setDate(startDate.getDate() - 30)
  const start = startDate.toISOString().slice(0, 10)

  const batches: { lat: number; lon: number }[][] = []
  for (let i = 0; i < points.length; i += BATCH) {
    batches.push(points.slice(i, i + BATCH))
  }

  const loadBatch = async (batch: { lat: number; lon: number }[]) => {
    const lats = batch.map(p => p.lat).join(',')
    const lons = batch.map(p => p.lon).join(',')
    const url = `https://archive-api.open-meteo.com/v1/archive` +
      `?latitude=${lats}&longitude=${lons}` +
      `&start_date=${start}&end_date=${date}` +
      `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m` +
      `&daily=precipitation_sum` +
      `&timezone=Europe%2FSofia&wind_speed_unit=kmh`
    const res = await fetchOpenMeteoArchive(url)
    const data = await res.json()
    const arr: any[] = Array.isArray(data) ? data : [data]
    return batch.flatMap((point, j) => {
      const d = arr[j]
      if (!d?.daily?.time) return []
      const days: Weather[] = d.daily.time.map((dt: string, di: number) => ({
        temp:  d.hourly.temperature_2m[di * 24 + 12]       ?? 15,
        rh:    d.hourly.relative_humidity_2m[di * 24 + 12] ?? 60,
        wind:  d.hourly.wind_speed_10m[di * 24 + 12]       ?? 10,
        rain:  d.daily.precipitation_sum[di]                ?? 0,
        month: Number(dt.slice(5, 7)),
      }))
      const series = fwiSeries(days, INITIAL_STATE)
      const last = days[days.length - 1]
      const lastFwi = series[series.length - 1]
      return [{
        key: `${point.lat.toFixed(1)},${point.lon.toFixed(1)}`,
        weather: {
          temp: last.temp,
          humidity: last.rh,
          windSpeed: last.wind,
          precip: last.rain,
          fwiVal: lastFwi.fwi,
        },
      }]
    })
  }

  for (let i = 0; i < batches.length; i += 2) {
    const batchResults = await Promise.all(batches.slice(i, i + 2).map(loadBatch))
    for (const batch of batchResults) {
      for (const { key, weather } of batch) result.set(key, weather)
    }
  }
  return result
}

function nearestWeather<T>(
  lat: number, lon: number,
  weatherMap: Map<string, T>
): T | undefined {
  const key = `${(Math.round(lat * 2) / 2).toFixed(1)},${(Math.round(lon * 2) / 2).toFixed(1)}`
  if (weatherMap.has(key)) return weatherMap.get(key)
  let best: string | undefined
  let bestDist = Infinity
  for (const k of weatherMap.keys()) {
    const [la, lo] = k.split(',').map(Number)
    const d = (lat - la) ** 2 + (lon - lo) ** 2
    if (d < bestDist) { bestDist = d; best = k }
  }
  return best ? weatherMap.get(best) : undefined
}

function normalizeRiskLevels<T extends {
  fwi: number | null
  risk_level: string | null
  explanation?: string | null
}>(rows: T[]) {
  const labels = { low: 'Нисък', moderate: 'Умерен', high: 'Висок', extreme: 'Екстремен' }
  return rows.map(row => {
    const fwi = row.fwi ?? 0
    const risk_level = fwiToRiskLevel(fwi)
    const explanation = row.explanation?.replace(/ \(модел: \d+%\)$/, '')
      .replace(/^(Нисък|Умерен|Висок|Екстремен) риск \(FWI [^)]+\)/,
        `${labels[risk_level]} риск (FWI ${fwi.toFixed(1)})`)
    return {
      ...row,
      risk_level,
      ...(row.explanation == null ? {} : { explanation }),
    }
  })
}

// ---------- routes ----------

export default async function riskRoutes(app: FastifyInstance) {
  const boundaryGeoJSON = loadBulgariaBoundaryGeoJSON()

  // ── Всички клетки с последния им риск — за картата ──────────────────────
  app.get('/cells', async () => {
    const rows = await sql<{
      id: number; lat: number; lon: number; geom: unknown
      fwi: number | null; risk_level: string | null; risk_score: number | null
      risk_source: 'model' | 'fwi' | null
      explanation: string | null; forecast_at: Date | null
      forecast_updated_at: Date | null
    }[]>`
      SELECT
        c.id, c.lat, c.lon,
        ST_AsGeoJSON(c.geom)::json AS geom,
        r.fwi, r.risk_level, r.risk_score, r.risk_source, r.explanation,
        r.forecast_at, r.forecast_updated_at
      FROM cells c
      LEFT JOIN LATERAL (
        SELECT fwi, risk_level, risk_score, risk_source, explanation, forecast_at, created_at AS forecast_updated_at
        FROM risk_forecasts
        WHERE cell_id = c.id
        ORDER BY forecast_at DESC
        LIMIT 1
      ) r ON true
    `
    return normalizeRiskLevels(rows)
  })

  // ── Риск за конкретна клетка + история 7 дни ────────────────────────────
  app.get('/cells/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = await sql<{
      fwi: number | null; risk_level: string | null
      risk_score: number | null; risk_source: 'model' | 'fwi' | null
      explanation: string | null; forecast_at: Date
    }[]>`
      SELECT fwi, risk_level, risk_score, risk_source, explanation, forecast_at
      FROM risk_forecasts
      WHERE cell_id = ${id}
        AND forecast_at >= NOW() - INTERVAL '7 days'
      ORDER BY forecast_at DESC
    `
    if (!rows.length) return reply.status(404).send({ error: 'Не е намерена клетка' })
    return normalizeRiskLevels(rows)
  })

  app.get('/fires/top-date', async (req, reply) => {
    const [day] = await sql`
      SELECT detected_at::text AS date, COUNT(*)::int AS count
      FROM fires
      WHERE detected_at >= DATE '2024-01-01'
      GROUP BY detected_at
      ORDER BY COUNT(*) DESC, detected_at DESC
      LIMIT 1
    `
    if (!day) return reply.status(404).send({ error: 'Няма FIRMS засичания за тестовия период' })
    return day
  })

  app.get('/fires/recent', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      description: 'Последните 48 часа FIRMS VIIRS засичания с номинална или висока увереност. Това са спътникови засичания, не потвърдени пожари.',
    },
  }, async () => {
    return sql`
      SELECT id, lat, lon, brightness, confidence, detected_at::text AS detected_at,
        ST_AsGeoJSON(COALESCE(geom, ST_SetSRID(ST_MakePoint(lon, lat), 4326)))::json AS geom
      FROM fires
      WHERE detected_at >= CURRENT_DATE - INTERVAL '1 day'
        AND confidence IN ('nominal', 'high')
        AND ST_Intersects(
          COALESCE(geom, ST_SetSRID(ST_MakePoint(lon, lat), 4326)),
          ST_SetSRID(ST_GeomFromGeoJSON(${boundaryGeoJSON}), 4326)
        )
      ORDER BY detected_at DESC, id
      LIMIT 10000
    `
  })

  app.get('/fires/:date', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { date } = req.params as { date: string }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '2024-01-01')
      return reply.status(400).send({ error: 'FIRMS данните са налични от 2024-01-01' })
    const day = new Date(`${date}T00:00:00Z`)
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date)
      return reply.status(400).send({ error: 'Невалидна дата' })

    return sql`
      SELECT id, lat, lon, brightness, confidence,
        ST_AsGeoJSON(COALESCE(geom, ST_SetSRID(ST_MakePoint(lon, lat), 4326)))::json AS geom
      FROM fires
      WHERE detected_at = ${date}
      ORDER BY confidence DESC, id
      LIMIT 10000
    `
  })

  // ── Replay: исторически риск за минала дата (с истински FWI) ─────────────
  app.get('/replay/:date', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      description: 'Архивен replay. Процентният резултат е относителен риск, не калибрирана вероятност за пожар.',
      params: {
        type: 'object',
        required: ['date'],
        properties: { date: { type: 'string', format: 'date', description: 'Дата от 2024-01-01 нататък' } },
      },
    },
  }, async (req, reply) => {
    const { date } = req.params as { date: string }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return reply.status(400).send({ error: 'Невалидна дата — използвай YYYY-MM-DD' })

    if (date < '2024-01-01')
      return reply.status(400).send({ error: 'Тестовият период започва на 2024-01-01' })

    const requested = new Date(date)
    if (Number.isNaN(requested.getTime()) || requested.toISOString().slice(0, 10) !== date)
      return reply.status(400).send({ error: 'Невалидна дата' })
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
    if (requested > yesterday)
      return reply.status(400).send({ error: 'Replay работи само за минали дати.' })

    const now = Date.now()
    for (const [cachedDate, entry] of replayCache) {
      if (entry.expiresAt <= now) replayCache.delete(cachedDate)
    }
    const cached = replayCache.get(date)
    if (cached) {
      replayCache.delete(date)
      replayCache.set(date, cached)
      return cached.cells
    }

    // Fetch от Archive API с 30-дневно затопляне
    const repPoints: { lat: number; lon: number }[] = []
    for (let la = 41.3; la <= 44.0; la += 0.5)
      for (let lo = 22.5; lo <= 28.5; lo += 0.5)
        repPoints.push({ lat: +la.toFixed(1), lon: +lo.toFixed(1) })

    let weatherMap: Awaited<ReturnType<typeof fetchArchiveBatch>>
    try {
      weatherMap = await fetchArchiveBatch(repPoints, date)
    } catch (err) {
      req.log.error({ err }, 'Грешка при зареждане на архивни метео данни')
      return reply.status(503).send({ error: 'Архивните метео данни са временно недостъпни. Опитай отново.' })
    }

    if (weatherMap.size === 0)
      return reply.status(503).send({
        error: 'Не могат да се извлекат метео данни. Опитай по-нова дата (след 2023-01-01).'
      })

    const cells = await sql<{ id: number; lat: number; lon: number; veg_type: number; geom: any }[]>`
      SELECT id, lat, lon, veg_type, ST_AsGeoJSON(geom)::json AS geom FROM cells
    `

    const dt    = new Date(date)
    const month = dt.getMonth() + 1
    const doy   = Math.floor((dt.getTime() - new Date(dt.getFullYear(), 0, 0).getTime()) / 86400000)

    const features: ReplayCell[] = await Promise.all(cells.map(async cell => {
      const w = nearestWeather(cell.lat, cell.lon, weatherMap)
        ?? { temp: 22, humidity: 50, windSpeed: 15, precip: 0, fwiVal: 8 }

      const pred = await predictRisk({
        temp:      w.temp,
        humidity:  w.humidity,
        windSpeed: w.windSpeed,
        precip:    w.precip,
        month,
        doy,
        veg_type:  cell.veg_type,
        fwi_override: w.fwiVal,
      })
      return {
        id:          cell.id,
        lat:         cell.lat,
        lon:         cell.lon,
        geom:        cell.geom,
        fwi:         w.fwiVal,
        risk_level:  pred.risk_level,
        risk_score:  pred.risk_score,
        risk_source: pred.source,
        explanation: pred.explanation,
        precipitation_mm: w.precip,
        forecast_at: date + 'T12:00:00',
      }
    }))

    if (replayCache.size >= REPLAY_CACHE_MAX_ENTRIES) {
      const oldestDate = replayCache.keys().next().value
      if (oldestDate) replayCache.delete(oldestDate)
    }
    replayCache.set(date, { expiresAt: Date.now() + REPLAY_CACHE_TTL_MS, cells: features })
    return features
  })

  // ── Симулация на разпространение — клетъчен автомат ──────────────────────
  app.post('/simulate', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    schema: {
      description: 'CPU-интензивна учебна симулация на разпространение на огъня.',
      body: {
        type: 'object',
        required: ['cell_id'],
        properties: {
          cell_id:    { type: 'integer' },
          steps:      { type: 'integer', default: 6, minimum: 1, maximum: 24 },
          wind_dir:   { type: 'number', default: 270 },
          wind_speed: { type: 'number', default: 20 },
        },
      },
    },
  }, async (req, reply) => {
    const { cell_id, steps = 6, wind_dir = 270, wind_speed = 20 } = req.body as {
      cell_id: number; steps?: number; wind_dir?: number; wind_speed?: number
    }

    const rawCells = await sql<{ id: number; lat: number; lon: number; risk_level: string; fwi: number }[]>`
      SELECT c.id, c.lat, c.lon,
        COALESCE(r.risk_level, 'low') AS risk_level,
        COALESCE(r.fwi, 0)            AS fwi
      FROM cells c
      LEFT JOIN LATERAL (
        SELECT risk_level, fwi FROM risk_forecasts
        WHERE cell_id = c.id ORDER BY forecast_at DESC LIMIT 1
      ) r ON true
    `
    const cells = normalizeRiskLevels(rawCells)
    if (!cells.length) return reply.status(404).send({ error: 'Няма клетки' })

    const byId = new Map(cells.map(c => [c.id, c]))
    const startCell = byId.get(cell_id)
    if (!startCell) return reply.status(404).send({ error: 'Клетката не е намерена' })

    const STEP = 0.1
    const grid = new Map<string, number>()
    for (const c of cells) {
      grid.set(`${Math.round(c.lat * 10)},${Math.round(c.lon * 10)}`, c.id)
    }

    const windRad    = (wind_dir * Math.PI) / 180
    const wx         = Math.sin(windRad)
    const wy         = Math.cos(windRad)
    const windFactor = 1 + wind_speed / 40

    const DIRS = [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]

    type CellFire = { id: number; lat: number; lon: number; step: number }
    const burning = new Map<number, CellFire>([[cell_id, { ...startCell, step: 0 }]])
    const burned  = new Set<number>([cell_id])
    const snapshots: CellFire[][] = [[{ ...startCell, step: 0 }]]

    for (let s = 1; s <= steps; s++) {
      const newFront: CellFire[] = []
      for (const fire of burning.values()) {
        if (fire.step < s - 1) continue
        const fLat10 = Math.round(fire.lat * 10)
        const fLon10 = Math.round(fire.lon * 10)
        for (const [dlat10, dlon10] of DIRS) {
          const nId = grid.get(`${fLat10 + dlat10},${fLon10 + dlon10}`)
          if (!nId || burned.has(nId)) continue
          const n = byId.get(nId)!
          const riskScore = { low: 0.1, moderate: 0.3, high: 0.6, extreme: 0.9 }[n.risk_level] ?? 0.1
          const dlon = dlon10 * STEP, dlat = dlat10 * STEP
          const dist = Math.sqrt(dlat * dlat + dlon * dlon)
          const dot  = (dlon * wx + dlat * wy) / (dist || 1)
          const prob = Math.min(riskScore + (dot > 0 ? dot * (windFactor - 1) * riskScore : 0), 0.95)
          if (Math.random() < prob) {
            const nf: CellFire = { id: nId, lat: n.lat, lon: n.lon, step: s }
            newFront.push(nf); burned.add(nId); burning.set(nId, nf)
          }
        }
      }
      for (const [id, fire] of burning) if (fire.step < s - 1) burning.delete(id)
      snapshots.push(newFront)
      if (newFront.length === 0) break
    }

    return {
      origin:      { id: cell_id, lat: startCell.lat, lon: startCell.lon },
      wind_dir, wind_speed,
      steps_run:   snapshots.length - 1,
      total_cells: burned.size,
      cells:       Array.from(burned).map(id => {
        const c = byId.get(id)!
        return { id, lat: c.lat, lon: c.lon, step: burning.get(id)?.step ?? 0 }
      }),
      snapshots: snapshots.map((s, i) => ({ step: i, cells: s })),
    }
  })
}
