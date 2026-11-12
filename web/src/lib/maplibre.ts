import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { Theme } from '../hooks/useTheme'

maplibregl.setWorkerUrl(workerUrl)

export { maplibregl }

export function getBasemapStyle(theme: Theme) {
  return theme === 'dark'
    ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
    : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
}
