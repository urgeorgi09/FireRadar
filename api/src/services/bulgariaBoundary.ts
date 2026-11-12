import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BOUNDARY_PATH = existsSync('/app/data/bulgaria_boundary.geojson')
  ? '/app/data/bulgaria_boundary.geojson'
  : join(__dirname, '../../../data/bulgaria_boundary.geojson')

export function loadBulgariaBoundaryGeoJSON(): string {
  if (!existsSync(BOUNDARY_PATH))
    throw new Error(`Липсва файлът с границата на България: ${BOUNDARY_PATH}`)
  const data = JSON.parse(readFileSync(BOUNDARY_PATH, 'utf8'))
  const geometry = data.type === 'FeatureCollection'
    ? data.features[0]?.geometry
    : data.geometry ?? data
  if (!geometry) throw new Error('Файлът с границата на България няма геометрия')
  return JSON.stringify(geometry)
}
