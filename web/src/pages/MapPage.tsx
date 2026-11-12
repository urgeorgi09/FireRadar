import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getBasemapStyle, maplibregl } from '../lib/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import axios from 'axios'
import { useAuth } from '../hooks/authContext'
import { useTheme } from '../hooks/useTheme'
import { Icon } from '../components/Icon'

const RISK_COLORS: Record<string, string> = {
  low:      '#22c55e',
  moderate: '#eab308',
  high:     '#f97316',
  extreme:  '#ef4444',
}
const RISK_BG: Record<string, string> = {
  low: 'Нисък', moderate: 'Умерен', high: 'Висок', extreme: 'Екстремен'
}

const REPLAY_START_DATE = '2024-01-01'

type Mode = 'live' | 'replay' | 'simulate'

export default function MapPage() {
  const mapRef      = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<maplibregl.Map | null>(null)
  const mapViewRef = useRef<{
    center: [number, number]
    zoom: number
    bearing: number
    pitch: number
  } | null>(null)
  const markersRef  = useRef<maplibregl.Marker[]>([])
  const queryClient = useQueryClient()
  const { token, role } = useAuth()
  const { theme } = useTheme()
  const activeReplayDateRef = useRef('')

  const [mode, setMode]             = useState<Mode>('live')
  const modeRef = useRef<Mode>('live')

  const [replayDate, setReplayDate]         = useState('')
  const [activeReplayDate, setActiveReplayDate] = useState('')  // само при "Покажи"
  const [replayMaxDate] = useState(() => new Date(Date.now() - 86400000).toISOString().slice(0, 10))
  const [replayError, setReplayError]       = useState('')
  const [demoLoading, setDemoLoading]       = useState(false)
  const [simCellId, setSimCellId]       = useState<number | null>(null)
  const [simStep, setSimStep]           = useState(0)
  const [simData, setSimData]           = useState<any>(null)
  const [windDir, setWindDir]           = useState(270)
  const [windSpeed, setWindSpeed]       = useState(20)
  const [isPickingCell, setIsPickingCell] = useState(false)
  const [isSimPlaying, setIsSimPlaying] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const simStepRef = useRef(0)
  const simTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data: liveCells, isError: liveError } = useQuery({
    queryKey: ['cells'],
    queryFn: () => axios.get('/api/risk/cells').then(r => r.data),
    refetchInterval: 60_000,
    enabled: mode === 'live',
    staleTime: 30_000,
  })

  const {
    data: replayCells,
    isError: replayIsError,
    error: replayErr,
    isFetching: replayFetching,
  } = useQuery({
    queryKey: ['replay', activeReplayDate],
    queryFn: () =>
      axios.get(`/api/risk/replay/${activeReplayDate}`)
        .then(r => r.data)
        .catch(e => { throw new Error(e.response?.data?.error ?? 'Грешка при зареждане') }),
    // Заявка само ако activeReplayDate е зададен и е валиден (2020-2025)
    enabled: mode === 'replay'
      && /^\d{4}-\d{2}-\d{2}$/.test(activeReplayDate)
      && activeReplayDate >= REPLAY_START_DATE,
    retry: false,
    staleTime: 30 * 60 * 1000,  // 30 минути кеш — Archive данни не се менят
  })

  const {
    data: fires,
    isError: firesError,
    isFetching: firesFetching,
  } = useQuery({
    queryKey: ['replay-fires', activeReplayDate],
    queryFn: () => axios.get(`/api/risk/fires/${activeReplayDate}`).then(r => r.data),
    enabled: mode === 'replay' && Boolean(activeReplayDate),
    staleTime: 30 * 60 * 1000,
  })

  const {
    data: liveFires,
    isError: liveFiresError,
    isFetching: liveFiresFetching,
  } = useQuery({
    queryKey: ['live-fires'],
    queryFn: () => axios.get('/api/risk/fires/recent').then(r => r.data),
    enabled: mode === 'live',
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  })

  const simulate = useMutation({
    mutationFn: (params: { cell_id: number; wind_dir: number; wind_speed: number; steps: number }) =>
      axios.post('/api/risk/simulate', params).then(r => r.data),
    onSuccess: data => {
      setSimData(data)
      setSimStep(0)
      simStepRef.current = 0
    },
  })

  const { data: alerts } = useQuery({
    queryKey: ['alerts-map'],
    queryFn: () => axios.get('/api/alerts', {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.data),
    enabled: role === 'dispatcher' || role === 'admin',
    refetchInterval: 30_000,
  })

  const cells = mode === 'live' ? liveCells : mode === 'replay' ? replayCells : liveCells
  const lastForecastUpdate = (liveCells ?? []).reduce((latest: number, cell: any) => {
    const updatedAt = Date.parse(cell.forecast_updated_at ?? '')
    return Number.isFinite(updatedAt) ? Math.max(latest, updatedAt) : latest
  }, 0)
  const lastUpdateTime = lastForecastUpdate ? new Date(lastForecastUpdate) : null
  const forecastIsStale = liveCells !== undefined &&
    (!lastUpdateTime || clockNow - lastUpdateTime.getTime() > 26 * 60 * 60 * 1000)

  useEffect(() => {
    modeRef.current = mode
    activeReplayDateRef.current = activeReplayDate
  }, [mode, activeReplayDate])

  // ── Map init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: getBasemapStyle(theme),
      ...(mapViewRef.current ?? { center: [25.5, 42.7] as [number, number], zoom: 7, bearing: 0, pitch: 0 }),
    })
    map.addControl(new maplibregl.NavigationControl())
    mapInstance.current = map
    return () => {
      const center = map.getCenter()
      mapViewRef.current = {
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      }
      markersRef.current.forEach(marker => marker.remove())
      markersRef.current = []
      map.remove()
      if (mapInstance.current === map) mapInstance.current = null
    }
  }, [theme])

  // ── Клетки ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstance.current
    if (!map || !cells?.length) return

    const geojson = {
      type: 'FeatureCollection',
      features: cells.map((c: any) => ({
        type: 'Feature',
        geometry: c.geom,
        properties: {
          id:          c.id,
          fdi:         c.fwi ?? 0,
          risk_level:  c.risk_level ?? 'low',
          risk_score:  c.risk_score,
          risk_source: c.risk_source,
          precipitation_mm: c.precipitation_mm,
          // XSS: explanation идва от сървъра, но го показваме само в MapLibre Popup
          // чрез setText, не innerHTML — popup текстовете се ескейпват
          explanation: String(c.explanation ?? 'Няма данни').slice(0, 300),
        },
      })),
    }

    const addLayers = () => {
      if (map.getSource('cells')) {
        (map.getSource('cells') as maplibregl.GeoJSONSource).setData(geojson as any)
        if (map.getLayer('firms-fires-points')) map.moveLayer('firms-fires-points')
        return
      }
      map.addSource('cells', { type: 'geojson', data: geojson as any })
      map.addLayer({
        id: 'cells-fill', type: 'fill', source: 'cells',
        paint: {
          'fill-color': [
            'match', ['get', 'risk_level'],
            'low',      RISK_COLORS.low,
            'moderate', RISK_COLORS.moderate,
            'high',     RISK_COLORS.high,
            'extreme',  RISK_COLORS.extreme,
            '#888',
          ],
          'fill-opacity': 0.65,
        },
      })
      map.addLayer({
        id: 'cells-border', type: 'line', source: 'cells',
        paint: { 'line-color': '#ffffff', 'line-width': 0.3, 'line-opacity': 0.3 },
      })
      map.addLayer({
        id: 'cells-score-label',
        type: 'symbol',
        source: 'cells',
        minzoom: 8,
        layout: {
          'text-field': [
            'case',
            ['all', ['==', ['get', 'risk_source'], 'model'], ['has', 'risk_score']],
            ['concat', ['to-string', ['round', ['*', ['get', 'risk_score'], 100]]], '%'],
            '',
          ],
          'text-font': ['Open Sans Regular'],
          'text-size': 12,
          'text-allow-overlap': false,
          'text-ignore-placement': false,
          'text-padding': 2,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#111827',
          'text-halo-width': 1.2,
        },
      })
      if (map.getLayer('firms-fires-points')) map.moveLayer('firms-fires-points')

      map.on('click', 'cells-fill', (e: any) => {
        const props = e.features?.[0]?.properties
        if (!props) return

        // В режим Симулация: избираме клетка вместо popup
        if (modeRef.current === 'simulate') {
          setSimCellId(props.id)
          setIsPickingCell(false)
          // Малка визуална обратна връзка
          const popup = new maplibregl.Popup({ closeButton: false, offset: 10 })
            .setLngLat(e.lngLat)
          // setText = XSS-safe, без HTML
          popup.setText(`Избрана клетка #${props.id} за симулация`)
          popup.addTo(map)
          setTimeout(() => popup.remove(), 1500)
          return
        }

        const levelBg = RISK_BG[props.risk_level] ?? props.risk_level
        const color   = RISK_COLORS[props.risk_level] ?? '#888'
        const explanation = String(props.explanation ?? '')
        const fdi = Number(props.fdi).toFixed(1)
        const score = Number(props.risk_score)
        const hasModelScore = props.risk_source === 'model' && Number.isFinite(score)

        // Popup: използваме createElement за да се избегне innerHTML с user data
        const container = document.createElement('div')
        container.className = 'popup'

        const title = document.createElement('strong')
        title.style.color = color
        title.textContent = `${levelBg} риск`
        container.appendChild(title)

        if (hasModelScore) {
          const scoreP = document.createElement('p')
          scoreP.textContent = `Относителен риск: ${Math.round(score * 100)}%`
          container.appendChild(scoreP)
        } else {
          const scoreP = document.createElement('p')
          scoreP.textContent = 'Процентна оценка не е налична за този източник на данни.'
          container.appendChild(scoreP)
        }

        const fdiP = document.createElement('p')
        fdiP.textContent = `Индекс: ${fdi}`
        container.appendChild(fdiP)

        const exP = document.createElement('p')
        exP.textContent = explanation
        container.appendChild(exP)

        const noteP = document.createElement('p')
        noteP.className = 'risk-score-note'
        noteP.textContent = 'Процентът е относителен и некалибриран; не представлява абсолютна вероятност за пожар.'
        container.appendChild(noteP)

        const replayDateForPopup = activeReplayDateRef.current
        if (modeRef.current === 'replay' && replayDateForPopup) {
          if (Number.isFinite(Number(props.precipitation_mm))) {
            const rainP = document.createElement('p')
            rainP.textContent = `Валежи за деня: ${Number(props.precipitation_mm).toFixed(1)} мм`
            container.appendChild(rainP)
          }
          const dateP = document.createElement('p')
          dateP.style.cssText = 'font-size:0.72rem;color:#94a3b8'
          dateP.textContent = `Историческа дата: ${replayDateForPopup}`
          container.appendChild(dateP)
        }

        new maplibregl.Popup()
          .setLngLat(e.lngLat)
          .setDOMContent(container)
          .addTo(map)
      })
      map.on('mouseenter', 'cells-fill', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'cells-fill', () => { map.getCanvas().style.cursor = '' })
    }

    if (map.isStyleLoaded()) addLayers()
    else map.on('load', addLayers)
  }, [cells, theme])

  useEffect(() => {
    const map = mapInstance.current
    if (!map) return

    const updateFires = () => {
      if (modeRef.current !== mode) return

      const sourceData = {
        type: 'FeatureCollection',
        features: (mode === 'replay' ? (fires ?? []) : mode === 'live' ? (liveFires ?? []) : []).map((fire: any) => ({
          type: 'Feature',
          geometry: fire.geom,
          properties: {
            brightness: fire.brightness,
            confidence: fire.confidence,
            detected_at: fire.detected_at,
          },
        })),
      }

      const source = map.getSource('firms-fires') as maplibregl.GeoJSONSource | undefined
      if (source) {
        source.setData(sourceData as any)
        if (map.getLayer('firms-fires-points')) map.moveLayer('firms-fires-points')
        return
      }

      map.addSource('firms-fires', { type: 'geojson', data: sourceData as any })
      map.addLayer({
        id: 'firms-fires-points',
        type: 'circle',
        source: 'firms-fires',
        paint: {
          'circle-radius': 5,
          'circle-color': '#ff2d2d',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      })
      map.moveLayer('firms-fires-points')
      map.on('click', 'firms-fires-points', (event: any) => {
        const props = event.features?.[0]?.properties
        if (!props) return
        const popup = document.createElement('div')
        popup.className = 'popup'
        const title = document.createElement('strong')
        title.textContent = 'Спътниково засичане'
        popup.appendChild(title)
        const details = document.createElement('p')
        details.textContent = `Не е потвърден пожар · ${props.detected_at ?? ''} · Увереност: ${props.confidence ?? 'няма данни'} · Яркост: ${props.brightness ?? 'няма данни'}`
        popup.appendChild(details)
        new maplibregl.Popup().setLngLat(event.lngLat).setDOMContent(popup).addTo(map)
      })
      map.on('mouseenter', 'firms-fires-points', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'firms-fires-points', () => { map.getCanvas().style.cursor = '' })
    }

    if (map.isStyleLoaded()) updateFires()
    else map.once('idle', updateFires)
    return () => {
      map.off('load', updateFires)
      map.off('idle', updateFires)
    }
  }, [fires, liveFires, mode, theme])

  // ── Симулация слоеве ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstance.current
    if (!map || !simData || mode !== 'simulate') return

    const updateSim = () => {
      const burnt = simData.cells.filter((c: any) => c.step <= simStep)
      const geojson = {
        type: 'FeatureCollection',
        features: (cells ?? []).filter((c: any) =>
          burnt.some((b: any) => b.id === c.id)
        ).map((c: any) => {
          const b = burnt.find((b: any) => b.id === c.id)
          return {
            type: 'Feature',
            geometry: c.geom,
            properties: { step: b?.step ?? 0 },
          }
        }),
      }

      if (map.getSource('sim-fire')) {
        (map.getSource('sim-fire') as maplibregl.GeoJSONSource).setData(geojson as any)
      } else {
        map.addSource('sim-fire', { type: 'geojson', data: geojson as any })
        map.addLayer({
          id: 'sim-fire-fill', type: 'fill', source: 'sim-fire',
          paint: {
            'fill-color': ['interpolate', ['linear'], ['get', 'step'], 0, '#ef4444', 12, '#f97316'],
            'fill-opacity': 0.75,
          },
        })
        map.addLayer({
          id: 'sim-fire-border', type: 'line', source: 'sim-fire',
          paint: { 'line-color': '#fbbf24', 'line-width': 1 },
        })
      }
    }

    if (map.isStyleLoaded()) updateSim()
    else map.on('load', updateSim)
  }, [simData, simStep, cells, mode, theme])

  // Изчистване при смяна на режим
  useEffect(() => {
    const map = mapInstance.current
    if (!map || modeRef.current === 'simulate') return
    if (map.getLayer('sim-fire-fill'))  map.removeLayer('sim-fire-fill')
    if (map.getLayer('sim-fire-border')) map.removeLayer('sim-fire-border')
    if (map.getSource('sim-fire'))      map.removeSource('sim-fire')
  }, [mode])

  // ── Alert маркери ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapInstance.current
    if (!map || !alerts) return
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []
    for (const a of alerts) {
      const color = a.status === 'confirmed' ? '#ef4444' : a.status === 'dismissed' ? '#64748b' : '#f97316'
      const el = document.createElement('div')
      el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;cursor:pointer`

      // XSS-safe popup за сигнали
      const container = document.createElement('div')
      container.className = 'popup'
      const title = document.createElement('strong')
      title.textContent = `Сигнал #${a.id}`
      container.appendChild(title)
      if (a.description) {
        const desc = document.createElement('p')
        desc.textContent = a.description  // textContent = без XSS
        container.appendChild(desc)
      }
      const meta = document.createElement('p')
      meta.style.cssText = 'font-size:0.75rem;color:#94a3b8'
      meta.textContent = `${new Date(a.created_at).toLocaleString('bg-BG')} · ${a.status}`
      container.appendChild(meta)

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([a.lon, a.lat])
        .setPopup(new maplibregl.Popup({ offset: 10 }).setDOMContent(container))
        .addTo(map)
      markersRef.current.push(marker)
    }
  }, [alerts, theme])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleReplay = () => {
    setReplayError('')
    if (!replayDate) return
    if (replayDate < REPLAY_START_DATE) {
      setReplayError('Тестовият период започва на 01.01.2024 г.')
      return
    }
    if (replayDate > replayMaxDate) {
      setReplayError('Избери дата преди днес.')
      return
    }
    setActiveReplayDate(replayDate)  // само тук се прави заявката
    switchMode('replay')
  }

  const handleDemoScenario = async () => {
    setDemoLoading(true)
    setReplayError('')
    try {
      const { data } = await axios.get('/api/risk/fires/top-date')
      setReplayDate(data.date)
      setActiveReplayDate(data.date)
      switchMode('replay')
    } catch (error) {
      setReplayError(axios.isAxiosError(error)
        ? error.response?.data?.error ?? 'Не успях да заредя демо датата.'
        : 'Не успях да заредя демо датата.')
    } finally {
      setDemoLoading(false)
    }
  }

  const switchMode = (nextMode: Mode) => {
    const previousMode = modeRef.current
    const modeChanged = previousMode !== nextMode

    if (nextMode === 'live' && previousMode !== 'live') {
      const emptyFeatures = { type: 'FeatureCollection', features: [] }
      const cellSource = mapInstance.current?.getSource('cells') as maplibregl.GeoJSONSource | undefined
      cellSource?.setData(emptyFeatures as any)
      const fireSource = mapInstance.current?.getSource('firms-fires') as maplibregl.GeoJSONSource | undefined
      fireSource?.setData(emptyFeatures as any)
      queryClient.removeQueries({ queryKey: ['cells'], exact: true })
      queryClient.removeQueries({ queryKey: ['live-fires'], exact: true })
    }

    modeRef.current = nextMode
    if (modeChanged && nextMode !== 'replay') {
      const fireSource = mapInstance.current?.getSource('firms-fires') as maplibregl.GeoJSONSource | undefined
      fireSource?.setData({ type: 'FeatureCollection', features: [] })
    }

    if (nextMode !== 'simulate') {
      setSimData(null)
      setSimCellId(null)
      setSimStep(0)
      simStepRef.current = 0
      setIsPickingCell(false)
      setIsSimPlaying(false)
      if (simTimerRef.current) {
        clearInterval(simTimerRef.current)
        simTimerRef.current = null
      }
    }
    setMode(nextMode)
  }

  const handleStartSim = useCallback(() => {
    if (!simCellId) return
    if (simTimerRef.current) clearInterval(simTimerRef.current)
    simulate.mutate({ cell_id: simCellId, wind_dir: windDir, wind_speed: windSpeed, steps: 12 })
  }, [simCellId, windDir, windSpeed, simulate])

  const handlePlaySim = () => {
    if (!simData) return
    if (simTimerRef.current) {
      clearInterval(simTimerRef.current)
      simTimerRef.current = null
      setIsSimPlaying(false)
      return
    }
    setIsSimPlaying(true)
    simTimerRef.current = setInterval(() => {
      const nextStep = simStepRef.current + 1
      simStepRef.current = nextStep
      setSimStep(nextStep)
      if (nextStep >= simData.steps_run) {
        clearInterval(simTimerRef.current!)
        simTimerRef.current = null
        setIsSimPlaying(false)
      }
    }, 900)
  }

  const visibleReplayError = replayError ||
    (replayIsError && replayErr instanceof Error ? replayErr.message : '') ||
    (firesError ? 'FIRMS засичанията не могат да се заредят.' : '')

  const formatTime = (d: Date) =>
    d.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="map-page">
      <div ref={mapRef} className="map-container" />

      {/* Показва се последната успешна прогноза, ако обновяването е спряло. */}
      {mode === 'live' && (liveError || forecastIsStale) && (
        <div className="meteo-error-banner">
          <Icon name="alert" size={16} />
          {lastUpdateTime
            ? <>Прогнозата не е обновена наскоро — показват се данни от {formatTime(lastUpdateTime)}</>
            : 'Няма налична прогноза от Open-Meteo.'}
        </div>
      )}

      {/* Loading overlay за replay */}
      {mode === 'replay' && (replayFetching || firesFetching) && (
        <div className="replay-loading">
          <div className="loading-spinner" />
          <span>Зареждам исторически данни от Open-Meteo Archive...</span>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="map-toolbar">
        <div className="mode-tabs">
          <button className={mode === 'live' ? 'active active-live' : ''} onClick={() => switchMode('live')}>
            <Icon name="radio" size={15} /> Живо
          </button>
          <button className={mode === 'replay' ? 'active active-replay' : ''} onClick={() => switchMode('replay')}>
            <Icon name="history" size={15} /> Повторение
          </button>
          <button className={mode === 'simulate' ? 'active active-simulate' : ''} onClick={() => switchMode('simulate')}>
            <Icon name="flame" size={15} /> Симулация
          </button>
        </div>

        {/* Бутон Демо сценарий — винаги видим */}
        <button className="btn-demo" onClick={handleDemoScenario} disabled={demoLoading} title="Покажи деня с най-много FIRMS засичания от 2024 г. насам">
          {demoLoading
            ? <><span className="loading-spinner-small" /> Зареждам...</>
            : <><Icon name="play" size={15} /> Демо сценарий</>}
        </button>

        {/* Replay controls */}
        {mode === 'replay' && (
          <div className="toolbar-section">
            <input
              type="date"
              value={replayDate}
              max={replayMaxDate}
              min={REPLAY_START_DATE}
              onChange={e => { setReplayDate(e.target.value); setReplayError('') }}
              className="date-input"
            />
            <span className="toolbar-info">Тестов период: от 01.01.2024 г.</span>
            <button className="btn-action" onClick={handleReplay} disabled={!replayDate || replayFetching}>
              {replayFetching ? <span className="loading-spinner-small" /> : <Icon name="play" size={15} />}
              {!replayFetching && 'Покажи'}
            </button>
            {visibleReplayError && <span className="toolbar-error">{visibleReplayError}</span>}
          </div>
        )}

        {/* Simulate controls */}
        {mode === 'simulate' && (
          <div className="toolbar-section">
            <button
              className={`btn-pick ${isPickingCell ? 'picking' : ''}`}
              onClick={() => setIsPickingCell(p => !p)}
            >
              {isPickingCell
                ? <><Icon name="target" size={15} /> Кликни клетка...</>
                : simCellId
                  ? `Клетка #${simCellId}`
                  : <><Icon name="map-pin" size={15} /> Избери клетка</>}
            </button>
            <label className="toolbar-label">
              Вятър
              <select value={windDir} onChange={e => setWindDir(+e.target.value)} className="date-input" style={{ width: 90 }}>
                <option value={0}>С (0°)</option>
                <option value={90}>И (90°)</option>
                <option value={180}>Ю (180°)</option>
                <option value={270}>З (270°)</option>
                <option value={45}>СИ</option>
                <option value={315}>СЗ</option>
              </select>
            </label>
            <label className="toolbar-label">
              км/ч
              <input type="number" value={windSpeed} min={0} max={100}
                onChange={e => setWindSpeed(+e.target.value)} className="date-input" style={{ width: 60 }} />
            </label>
            <button className="btn-action" onClick={handleStartSim} disabled={!simCellId || simulate.isPending}>
              {simulate.isPending ? <span className="loading-spinner-small" /> : <Icon name="play" size={15} />}
              {!simulate.isPending && 'Пусни'}
            </button>
            {simData && (
              <>
                <button className="btn-action" onClick={handlePlaySim}>
                  <Icon name={isSimPlaying ? 'pause' : 'play'} size={15} /> Анимация
                </button>
                <span className="toolbar-info">
                  Стъпка {simStep}/{simData.steps_run} · {simData.cells.filter((c: any) => c.step <= simStep).length} клетки
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Легенда ── */}
      <div className="legend">
        {/* Режим badge */}
        <div className={`mode-badge mode-badge-${mode}`}>
          <span className="icon-heading">
            <Icon name={mode === 'live' ? 'radio' : mode === 'replay' ? 'history' : 'flame'} size={14} />
            {mode === 'live' ? 'ЖИВО' : mode === 'replay' ? activeReplayDate || 'ПОВТОРЕНИЕ' : 'СИМУЛАЦИЯ'}
          </span>
        </div>

        <h3>Относителен риск от пожар</h3>
        <p className="risk-score-note">Процентите са ориентировъчни оценки на модела.</p>
        {mode === 'live' && (
          <>
            <p className="risk-score-note">Спътникови засичания, не потвърдени пожари</p>
            {liveFiresError && <p className="toolbar-error">FIRMS временно е недостъпен; показват се последните налични данни.</p>}
            {!liveFiresError && !liveFiresFetching && liveFires?.length === 0 && (
              <p className="firms-empty-state">Няма спътникови засичания за последните 48 часа. Нови данни се зареждат при зададен FIRMS_MAP_KEY.</p>
            )}
          </>
        )}
        <div className="legend-levels">
          {Object.entries(RISK_COLORS).map(([level, color]) => (
            <div key={level} className="legend-item">
              <span className="legend-dot" style={{ background: color }} />
              <span>{RISK_BG[level]}</span>
            </div>
          ))}
        </div>

        {/* Симулация легенда */}
        {mode === 'simulate' && simData && (
          <>
            <div style={{ borderTop: '1px solid #2a2d3a', margin: '0.5rem 0' }} />
            <div className="legend-item"><span className="legend-dot" style={{ background: '#ef4444' }} /><span>Начало</span></div>
            <div className="legend-item"><span className="legend-dot" style={{ background: '#f97316' }} /><span>Разпространение</span></div>
            <p style={{ fontSize: '0.68rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
              Учебна симулация — не е прогноза
            </p>
          </>
        )}

        {/* Сигнали легенда */}
        {(role === 'dispatcher' || role === 'admin') && alerts?.length > 0 && (
          <>
            <div style={{ borderTop: '1px solid #2a2d3a', margin: '0.5rem 0' }} />
            <div className="legend-item"><span className="legend-dot" style={{ background: '#ef4444', borderRadius: '50%' }} /><span>Потвърден сигнал</span></div>
            <div className="legend-item"><span className="legend-dot" style={{ background: '#f97316', borderRadius: '50%' }} /><span>Чакащ сигнал</span></div>
          </>
        )}

        {/* Последно обновяване */}
        {mode === 'live' && (
          <p style={{ fontSize: '0.68rem', color: 'var(--muted)', marginTop: '0.5rem', borderTop: '1px solid #2a2d3a', paddingTop: '0.4rem' }}>
            {lastUpdateTime ? `Обновено: ${formatTime(lastUpdateTime)}` : 'Няма данни за час на обновяване'}
          </p>
        )}
      </div>
    </div>
  )
}
