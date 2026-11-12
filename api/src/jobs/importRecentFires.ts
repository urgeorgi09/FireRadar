import sql from '../db/client.js'
import { loadBulgariaBoundaryGeoJSON } from '../services/bulgariaBoundary.js'

const BBOX = '22.36,41.24,28.61,44.21'
const PRODUCTS = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT']
const REQUEST_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3

type RecentFire = {
  source_id: string
  lat: number
  lon: number
  detected_at: string
  brightness: number | null
  confidence: 'nominal' | 'high'
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      fields.push(value)
      value = ''
    } else {
      value += char
    }
  }
  fields.push(value)
  return fields
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseRecentFirmsCsv(csv: string): RecentFire[] {
  const [headerLine, ...lines] = csv.trim().split(/\r?\n/)
  if (!headerLine) return []
  const headers = parseCsvLine(headerLine.replace(/^\uFEFF/, '')).map(name => name.trim())
  const index = Object.fromEntries(headers.map((name, i) => [name, i]))
  const required = ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'satellite', 'instrument']
  if (required.some(name => index[name] === undefined))
    throw new Error('FIRMS CSV липсват задължителни колони')

  const rows: RecentFire[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const fields = parseCsvLine(line)
    const lat = Number(fields[index.latitude])
    const lon = Number(fields[index.longitude])
    const detectedAt = (fields[index.acq_date] ?? '').trim()
    const acquisitionTime = (fields[index.acq_time] ?? '').trim()
    const satellite = (fields[index.satellite] ?? '').trim()
    const instrument = (fields[index.instrument] ?? '').trim()
    const confidenceValue = (fields[index.confidence] ?? '').trim().toLowerCase()
    const confidence = confidenceValue === 'h' || confidenceValue === 'high'
      ? 'high'
      : confidenceValue === 'n' || confidenceValue === 'nominal'
        ? 'nominal'
        : null
    const acquisitionHour = Number(acquisitionTime.slice(0, 2))
    const acquisitionMinute = Number(acquisitionTime.slice(2))
    if (
      !Number.isFinite(lat) || lat < 41.24 || lat > 44.21 ||
      !Number.isFinite(lon) || lon < 22.36 || lon > 28.61 ||
      !validDate(detectedAt) || !/^\d{4}$/.test(acquisitionTime) ||
      acquisitionHour > 23 || acquisitionMinute > 59 ||
      !confidence || !satellite || !instrument
    ) continue

    const brightnessValue = fields[index.bright_ti4]
    const brightnessNumber = brightnessValue ? Number(brightnessValue) : Number.NaN
    const sourceId = [
      'firms-nrt',
      satellite,
      instrument,
      detectedAt,
      acquisitionTime,
      fields[index.latitude].trim(),
      fields[index.longitude].trim(),
    ].join('-')

    rows.push({
      source_id: sourceId,
      lat,
      lon,
      detected_at: detectedAt,
      brightness: Number.isFinite(brightnessNumber) ? brightnessNumber : null,
      confidence,
    })
  }
  return rows
}

async function fetchRecentCsv(apiKey: string, product: string): Promise<string> {
  const url = new URL(
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(apiKey)}/${product}/${BBOX}/2`,
  )
  let lastFailure = 'network failure or timeout'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (response.status === 429 || response.status >= 500) {
        lastFailure = `HTTP ${response.status}`
      } else if (!response.ok) {
        throw new Error(`FIRMS отказа заявката с HTTP ${response.status}`)
      } else {
        return await response.text()
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('FIRMS отказа заявката'))
        throw error
    } finally {
      clearTimeout(timeout)
    }

    if (attempt < MAX_ATTEMPTS - 1)
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
  }

  throw new Error(`FIRMS не е достъпен след ${MAX_ATTEMPTS} опита (${lastFailure})`)
}

export async function importRecentFires(): Promise<number> {
  const apiKey = process.env.FIRMS_MAP_KEY
  if (!apiKey) {
    console.warn('[WARN] FIRMS_MAP_KEY не е конфигуриран; пропускам обновяването на засичанията.')
    return 0
  }

  const responses = await Promise.allSettled(
    PRODUCTS.map(async product => ({
      product,
      csv: await fetchRecentCsv(apiKey, product),
    })),
  )
  const rowsBySourceId = new Map<string, RecentFire>()
  let successfulProducts = 0
  for (let i = 0; i < responses.length; i++) {
    const result = responses[i]
    if (result.status === 'rejected') {
      console.error(
        `[ERROR] FIRMS ${PRODUCTS[i]} не беше обновен:`,
        result.reason instanceof Error ? result.reason.message : 'неизвестна грешка',
      )
      continue
    }

    successfulProducts++
    try {
      for (const row of parseRecentFirmsCsv(result.value.csv))
        rowsBySourceId.set(row.source_id, row)
    } catch (error) {
      console.error(
        `[ERROR] FIRMS ${result.value.product} върна невалиден CSV:`,
        error instanceof Error ? error.message : 'неизвестна грешка',
      )
    }
  }

  if (successfulProducts === 0) {
    console.error('[ERROR] FIRMS засичанията не бяха обновени от нито един сателит.')
    return 0
  }

  const rows = [...rowsBySourceId.values()]
  if (!rows.length) {
    console.log('[OK] FIRMS NRT: няма валидни засичания с висока/номинална увереност.')
    return 0
  }

  const boundary = loadBulgariaBoundaryGeoJSON()
  const inserted = await sql`
    INSERT INTO fires (source_id, lat, lon, detected_at, brightness, confidence, geom)
    SELECT r.source_id, r.lat, r.lon, r.detected_at::date, r.brightness, r.confidence,
      ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)
    FROM jsonb_to_recordset(${sql.json(rows)}) AS r(
      source_id text, lat float, lon float, detected_at text, brightness float, confidence text
    )
    WHERE ST_Intersects(
      ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326),
      ST_SetSRID(ST_GeomFromGeoJSON(${boundary}), 4326)
    )
    ON CONFLICT (source_id) DO NOTHING
    RETURNING id
  `
  console.log(`[OK] FIRMS NRT: добавени ${inserted.length} нови от ${rows.length} валидни засичания.`)
  return inserted.length
}
