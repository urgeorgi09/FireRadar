/**
 * Взема метео от Open-Meteo (hourly!) за представителни точки,
 * изчислява истинския FWI с 60 дни "затопляне" (памет на влажностните кодове),
 * и записва risk_forecasts за всички клетки чрез nearest-neighbor.
 *
 * Ключова разлика от предишната версия:
 * - hourly данни → взимаме 12:00 стойностите (обед) — изискване на стандарта
 * - 60 дни предистория за да са FFMC/DMC/DC "загрети"
 * - Прогнозата е за следващите 3 дни (индекси 60, 61, 62)
 */
import sql from '../db/client.js'
import { predictRisk } from '../services/model.js'
import { fwiSeries, INITIAL_STATE, type Weather } from '../services/fwi.js'

function getRepresentativePoints() {
  const points: { lat: number; lon: number }[] = []
  for (let lat = 41.3; lat <= 44.1; lat += 0.5) {
    for (let lon = 22.5; lon <= 28.5; lon += 0.5) {
      points.push({ lat: +lat.toFixed(1), lon: +lon.toFixed(1) })
    }
  }
  return points
}

/**
 * Взима hourly данни за 60 дни назад + 3 дни напред.
 * Извлича обедните стойности (индекс 12 в hourly масива = 12:00).
 */
async function fetchBatch(points: { lat: number; lon: number }[]): Promise<any[]> {
  const lats = points.map(p => p.lat).join(',')
  const lons = points.map(p => p.lon).join(',')
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', lats)
  url.searchParams.set('longitude', lons)
  // hourly за обедните стойности + daily за валежите
  url.searchParams.set('hourly', 'temperature_2m,relative_humidity_2m,wind_speed_10m')
  url.searchParams.set('daily', 'precipitation_sum')
  url.searchParams.set('past_days', '60')
  url.searchParams.set('forecast_days', '3')
  url.searchParams.set('timezone', 'Europe/Sofia')
  url.searchParams.set('wind_speed_unit', 'kmh')

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url.toString())
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
      continue
    }
    if (!res.ok) throw new Error(`Open-Meteo: ${res.status}`)
    return res.json()
  }
  throw new Error('Open-Meteo: max retries exceeded')
}

/**
 * Конвертира Open-Meteo hourly/daily отговор към масив от Weather обекти.
 * Взима 12:00 час (index i*24 + 12 в hourly масива) за всеки ден.
 */
function toWeatherDays(data: any): Weather[] {
  const dates: string[] = data.daily?.time ?? []
  return dates.map((date, i) => ({
    temp:  data.hourly.temperature_2m[i * 24 + 12]       ?? 15,
    rh:    data.hourly.relative_humidity_2m[i * 24 + 12] ?? 60,
    wind:  data.hourly.wind_speed_10m[i * 24 + 12]       ?? 10,
    rain:  data.daily.precipitation_sum[i]                ?? 0,
    month: Number(date.slice(5, 7)),
  }))
}

function nearest(lat: number, lon: number, points: { lat: number; lon: number }[]) {
  let best = 0, bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = (lat - points[i].lat) ** 2 + (lon - points[i].lon) ** 2
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

export async function updateForecasts() {
  await sql`ALTER TABLE risk_forecasts ADD COLUMN IF NOT EXISTS risk_score DOUBLE PRECISION`
  await sql`ALTER TABLE risk_forecasts ADD COLUMN IF NOT EXISTS risk_source TEXT`

  const cells = await sql<{ id: number; lat: number; lon: number; veg_type: number }[]>`
    SELECT id, lat, lon, veg_type FROM cells ORDER BY id
  `
  if (!cells.length) { console.log('Няма клетки'); return }

  console.log(`Обновявам прогнози за ${cells.length} клетки (истински FWI с памет)...`)

  const repPoints = getRepresentativePoints()
  const BATCH = 20
  // За всяка точка: масив от Weather обекти (60+3 дни)
  const weatherByPoint: (Weather[] | null)[] = new Array(repPoints.length).fill(null)
  let fetchedCount = 0

  for (let i = 0; i < repPoints.length; i += BATCH) {
    const batch = repPoints.slice(i, i + BATCH)
    try {
      const data = await fetchBatch(batch)
      const results: any[] = Array.isArray(data) ? data : [data]
      for (let j = 0; j < batch.length; j++) {
        const days = toWeatherDays(results[j])
        if (days.length > 0) {
          weatherByPoint[i + j] = days
          fetchedCount++
        }
      }
    } catch (err) {
      console.warn(`  [WARN] Грешка при метео точки ${i}–${i + BATCH}:`, (err as Error).message)
    }
    await new Promise(r => setTimeout(r, 600))
  }

  if (fetchedCount === 0) {
    console.warn('[WARN] Open-Meteo е недостъпен — прогнозите не са обновени.')
    return
  }

  // Предварително изчисляваме FWI серията за всяка точка
  // days[0..59] = предистория (60 дни), days[60..62] = прогноза (3 дни)
  const fwiByPoint: (ReturnType<typeof fwiSeries> | null)[] = weatherByPoint.map(days =>
    days ? fwiSeries(days, INITIAL_STATE) : null
  )

  const forecasts: {
    cell_id: number; forecast_at: string
    fwi: number; risk_level: string; risk_score: number
    risk_source: 'model' | 'fwi'; explanation: string
  }[] = []

  for (const cell of cells) {
    const idx    = nearest(cell.lat, cell.lon, repPoints)
    const days   = weatherByPoint[idx]
    const series = fwiByPoint[idx]
    if (!days || !series) continue

    // Прогнозните дни са последните 3 (индекси 60, 61, 62 от 63 общо)
    const forecastStart = days.length - 3
    for (let d = forecastStart; d < days.length; d++) {
      const weather = days[d]
      const fwiRes  = series[d]
      const dateStr = new Date(Date.now() + (d - forecastStart) * 86400000)
        .toISOString().slice(0, 10)

      const pred = await predictRisk({
        temp:      weather.temp,
        humidity:  weather.rh,
        windSpeed: weather.wind,
        precip:    weather.rain,
        month:     weather.month,
        doy:       Math.floor((new Date(dateStr).getTime() - new Date(new Date(dateStr).getFullYear(), 0, 0).getTime()) / 86400000),
        veg_type:  cell.veg_type,
        // Передаваме реалните FWI компоненти — lag вече е вграден в серията
        fwi_lag1:  d > 0 ? series[d - 1].fwi : fwiRes.fwi,
        fwi_lag2:  d > 1 ? series[d - 2].fwi : fwiRes.fwi,
        fwi_lag3:  d > 2 ? series[d - 3].fwi : fwiRes.fwi,
        // Предаваме реалния FWI от серията (с памет!)
        fwi_override: fwiRes.fwi,
        ffmc: fwiRes.ffmc,
        dmc:  fwiRes.dmc,
        dc:   fwiRes.dc,
        isi:  fwiRes.isi,
        bui:  fwiRes.bui,
      }, fwiRes)

      forecasts.push({
        cell_id:     cell.id,
        forecast_at: dateStr + 'T12:00:00+02:00',
        fwi:         fwiRes.fwi,
        risk_level:  pred.risk_level,
        risk_score:  pred.risk_score,
        risk_source: pred.source,
        explanation: pred.explanation,
      })
    }
  }

  const INSERT_BATCH = 1000
  for (let i = 0; i < forecasts.length; i += INSERT_BATCH) {
    await sql`
      INSERT INTO risk_forecasts ${sql(forecasts.slice(i, i + INSERT_BATCH))}
      ON CONFLICT (cell_id, forecast_at) DO UPDATE SET
        fwi         = EXCLUDED.fwi,
        risk_level  = EXCLUDED.risk_level,
        risk_score  = EXCLUDED.risk_score,
        risk_source = EXCLUDED.risk_source,
        explanation = EXCLUDED.explanation,
        created_at  = NOW()
    `
  }

  console.log(`[OK] Записани ${forecasts.length} прогнози (истински FWI)`)
}
