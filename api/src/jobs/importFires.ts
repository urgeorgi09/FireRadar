import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import sql from '../db/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CSV_PATH = existsSync('/app/data/firms_bulgaria_2018_2025.csv')
  ? '/app/data/firms_bulgaria_2018_2025.csv'
  : join(__dirname, '../../../data/firms_bulgaria_2018_2025.csv')

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

export async function importFires() {
  if (!existsSync(CSV_PATH)) {
    console.warn(`FIRMS CSV не е намерен: ${CSV_PATH}`)
    return
  }

  await sql`ALTER TABLE fires ADD COLUMN IF NOT EXISTS source_id TEXT`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS fires_source_id_idx ON fires(source_id)`

  const [headerLine, ...lines] = readFileSync(CSV_PATH, 'utf8').trim().split(/\r?\n/)
  const headers = parseCsvLine(headerLine.replace(/^\uFEFF/, ''))
  const index = Object.fromEntries(headers.map((name, i) => [name, i]))
  const required = ['latitude', 'longitude', 'acq_date', 'confidence']
  if (required.some(name => index[name] === undefined))
    throw new Error('FIRMS CSV липсват задължителни колони')

  const rows = lines.map((line, i) => {
    const fields = parseCsvLine(line)
    const lat = Number(fields[index.latitude])
    const lon = Number(fields[index.longitude])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !fields[index.acq_date]) return null
    const brightness = fields[index.bright_ti4] ? Number(fields[index.bright_ti4]) : null
    return {
      source_id: `firms-csv-${i + 2}`,
      lat,
      lon,
      detected_at: fields[index.acq_date],
      brightness: brightness !== null && Number.isFinite(brightness) ? brightness : null,
      confidence: fields[index.confidence],
    }
  }).filter((row): row is NonNullable<typeof row> => row !== null)

  const BATCH_SIZE = 1000
  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const result = await sql`
      INSERT INTO fires (source_id, lat, lon, detected_at, brightness, confidence, geom)
      SELECT r.source_id, r.lat, r.lon, r.detected_at::date, r.brightness, r.confidence,
        ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)
      FROM jsonb_to_recordset(${sql.json(rows.slice(i, i + BATCH_SIZE))}) AS r(
        source_id text, lat float, lon float, detected_at text, brightness float, confidence text
      )
      ON CONFLICT (source_id) DO NOTHING
      RETURNING id
    `
    inserted += result.length
  }
  console.log(`[OK] FIRMS: заредени ${inserted} нови от ${rows.length} засичания`)
}
