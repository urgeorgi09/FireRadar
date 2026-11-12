import { useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getBasemapStyle, maplibregl } from '../lib/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import axios from 'axios'
import { useAuth } from '../hooks/authContext'
import { useTheme } from '../hooks/useTheme'
import { Icon } from '../components/Icon'
import { createIconElement } from '../components/iconDom'
import type { IconName } from '../components/iconPaths'

const STATUS_COLOR: Record<string, string> = {
  pending:      '#f97316',
  confirmed:    '#ef4444',
  false_alarm:  '#64748b',
  extinguished: '#22c55e',
}
const DRONE_COLOR: Record<string, string> = {
  idle:        '#64748b',
  en_route:    '#3b82f6',
  inspecting:  '#a855f7',
  firefighting:'#ef4444',
  returning:   '#22c55e',
}
const DRONE_ICON: Record<string, IconName> = {
  recon: 'search',
  tanker: 'droplet',
}
const CITIZEN_ALERT_COLOR: Record<string, string> = {
  pending: '#f97316',
  confirmed: '#ef4444',
  dismissed: '#64748b',
  extinguished: '#22c55e',
}
const CITIZEN_ALERT_LABEL: Record<string, string> = {
  pending: 'Чакащ',
  confirmed: 'Потвърден',
  dismissed: 'Отхвърлен',
  extinguished: 'Угасен',
}

function createPopup(titleText: string, lines: string[], titleColor?: string) {
  const container = document.createElement('div')
  container.className = 'popup'
  const title = document.createElement('strong')
  title.textContent = titleText
  if (titleColor) title.style.color = titleColor
  container.appendChild(title)
  for (const text of lines) {
    const line = document.createElement('p')
    line.textContent = text
    container.appendChild(line)
  }
  return container
}

export default function OperationsPage() {
  const { token, role } = useAuth()
  const { theme } = useTheme()
  const qc = useQueryClient()
  const mapRef = useRef<HTMLDivElement>(null)
  const map    = useRef<maplibregl.Map | null>(null)
  const mapView = useRef<{
    center: [number, number]
    zoom: number
    bearing: number
    pitch: number
  } | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])

  const headers = { Authorization: `Bearer ${token}` }
  const isOps = role === 'dispatcher' || role === 'admin'

  const { data: towers }       = useQuery({ queryKey: ['towers'],        queryFn: () => axios.get('/api/towers',        { headers }).then(r => r.data), refetchInterval: 15000 })
  const { data: towerAlerts }  = useQuery({ queryKey: ['tower-alerts'],  queryFn: () => axios.get('/api/towers/alerts', { headers }).then(r => r.data), refetchInterval: 10000 })
  const { data: citizenAlerts } = useQuery({ queryKey: ['citizen-alerts'], queryFn: () => axios.get('/api/alerts', { headers }).then(r => r.data), refetchInterval: 10000 })
  const { data: drones }       = useQuery({ queryKey: ['drones'],        queryFn: () => axios.get('/api/drones',        { headers }).then(r => r.data), refetchInterval: 5000  })

  const updateAlertStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      axios.patch(`/api/towers/alerts/${id}`, { status }, { headers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tower-alerts'] }),
  })

  const dispatchRecon = useMutation({
    mutationFn: (tower_alert_id: number) =>
      axios.post('/api/drones/dispatch/recon', { tower_alert_id }, { headers }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['drones'] }); qc.invalidateQueries({ queryKey: ['tower-alerts'] }) },
  })

  const dispatchTanker = useMutation({
    mutationFn: (tower_alert_id: number) =>
      axios.post('/api/drones/dispatch/tanker', { tower_alert_id }, { headers }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['drones'] }); qc.invalidateQueries({ queryKey: ['tower-alerts'] }) },
  })

  const updateCitizenAlertStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      axios.patch(`/api/alerts/${id}`, { status }, { headers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['citizen-alerts'] }),
  })

  const dispatchCitizenRecon = useMutation({
    mutationFn: (alert_id: number) =>
      axios.post('/api/drones/dispatch/citizen-alert', { alert_id }, { headers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drones'] })
      qc.invalidateQueries({ queryKey: ['citizen-alerts'] })
    },
  })

  const dispatchCitizenTanker = useMutation({
    mutationFn: (alert_id: number) =>
      axios.post('/api/drones/dispatch/citizen-alert/tanker', { alert_id }, { headers }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drones'] })
      qc.invalidateQueries({ queryKey: ['citizen-alerts'] })
    },
  })

  const returnDrone = useMutation({
    mutationFn: (id: number) =>
      axios.patch(`/api/drones/${id}/status`, { status: 'idle' }, { headers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drones'] }),
  })

  // Инициализация на картата
  useEffect(() => {
    if (!mapRef.current) return
    const instance = new maplibregl.Map({
      container: mapRef.current,
      style: getBasemapStyle(theme),
      ...(mapView.current ?? { center: [25.5, 42.7] as [number, number], zoom: 7, bearing: 0, pitch: 0 }),
    })
    map.current = instance
    instance.addControl(new maplibregl.NavigationControl())
    return () => {
      const center = instance.getCenter()
      mapView.current = {
        center: [center.lng, center.lat],
        zoom: instance.getZoom(),
        bearing: instance.getBearing(),
        pitch: instance.getPitch(),
      }
      markers.current.forEach(marker => marker.remove())
      markers.current = []
      instance.remove()
      if (map.current === instance) map.current = null
    }
  }, [theme])

  // Рисуване на кули, зони, дронове
  useEffect(() => {
    const m = map.current
    if (!m) return

    const draw = () => {
      // Изчистваме стари маркери
      markers.current.forEach(mk => mk.remove())
      markers.current = []

      // Покривни зони на кулите
      const zonesGJ = {
        type: 'FeatureCollection',
        features: (towers ?? []).filter((t: any) => t.cover_zone).map((t: any) => ({
          type: 'Feature',
          geometry: t.cover_zone,
          properties: { name: t.name, status: t.status },
        })),
      }
      if (m.getSource('zones')) {
        (m.getSource('zones') as maplibregl.GeoJSONSource).setData(zonesGJ as any)
      } else {
        m.addSource('zones', { type: 'geojson', data: zonesGJ as any })
        m.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones',
          paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 } })
        m.addLayer({ id: 'zones-line', type: 'line', source: 'zones',
          paint: { 'line-color': '#3b82f6', 'line-width': 1.5, 'line-dasharray': [4, 3] } })
      }

      // Маршрутни полигони на дронове
      const missionGJ = {
        type: 'FeatureCollection',
        features: (drones ?? []).filter((d: any) => d.mission_polygon && d.status !== 'idle').map((d: any) => ({
          type: 'Feature',
          geometry: d.mission_polygon,
          properties: { type: d.type, status: d.status },
        })),
      }
      if (m.getSource('missions')) {
        (m.getSource('missions') as maplibregl.GeoJSONSource).setData(missionGJ as any)
      } else {
        m.addSource('missions', { type: 'geojson', data: missionGJ as any })
        m.addLayer({ id: 'missions-fill', type: 'fill', source: 'missions',
          paint: { 'fill-color': ['match', ['get', 'type'], 'recon', '#a855f7', 'tanker', '#ef4444', '#888888'],
                   'fill-opacity': 0.15 } })
        m.addLayer({ id: 'missions-line', type: 'line', source: 'missions',
          paint: { 'line-color': ['match', ['get', 'type'], 'recon', '#a855f7', 'tanker', '#ef4444', '#888888'],
                   'line-width': 1.5, 'line-dasharray': [3, 2] } })
      }

      // Маркери за кули
      for (const t of (towers ?? [])) {
        const el = document.createElement('div')
        el.className = 'map-marker-icon tower-marker'
        el.appendChild(createIconElement('tower'))
        const mk = new maplibregl.Marker({ element: el })
          .setLngLat([t.lon, t.lat])
          .setPopup(new maplibregl.Popup({ offset: 12 }).setDOMContent(
            createPopup(t.name, [`Радиус: ${t.radius_km} км · ${t.status}`, 'Демо данни'])
          ))
          .addTo(m)
        markers.current.push(mk)
      }

      // Маркери за сигнали от кули
      for (const a of (towerAlerts ?? [])) {
        const el = document.createElement('div')
        el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${STATUS_COLOR[a.status] ?? '#888'};border:2px solid white;cursor:pointer`
        if (a.status === 'pending' || a.status === 'confirmed') {
          el.style.animation = 'pulse 1.5s infinite'
        }
        const mk = new maplibregl.Marker({ element: el })
          .setLngLat([a.lon, a.lat])
          .setPopup(new maplibregl.Popup({ offset: 10 }).setDOMContent(
            createPopup(`Сигнал от ${a.tower_name}`, [
              `Увереност: ${Math.round(a.confidence * 100)}%`,
              `${new Date(a.created_at).toLocaleString('bg-BG')} · ${a.status}`,
            ])
          ))
          .addTo(m)
        markers.current.push(mk)
      }

      // Маркери за граждански сигнали
      for (const a of (citizenAlerts ?? [])) {
        const el = document.createElement('div')
        el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${CITIZEN_ALERT_COLOR[a.status] ?? '#888'};border:2px solid white;cursor:pointer`
        if (a.status === 'pending' || a.status === 'confirmed') el.style.animation = 'pulse 1.5s infinite'
        const mk = new maplibregl.Marker({ element: el })
          .setLngLat([a.lon, a.lat])
          .setPopup(new maplibregl.Popup({ offset: 10 }).setDOMContent(
            createPopup('Граждански сигнал', [
              a.description || 'Без описание',
              `${new Date(a.created_at).toLocaleString('bg-BG')} · ${a.status}`,
              a.drone_recon_name ? `Разузнавач: ${a.drone_recon_name} · ${a.drone_recon_status}` : 'Няма назначен разузнавач',
              a.drone_tanker_name ? `Водоноска: ${a.drone_tanker_name} · ${a.drone_tanker_status}` : 'Няма изпратена водоноска',
            ], CITIZEN_ALERT_COLOR[a.status])
          ))
          .addTo(m)
        markers.current.push(mk)
      }

      // Маркери за дронове
      for (const d of (drones ?? [])) {
        const pos = d.current_lat ? [d.current_lon, d.current_lat] : [d.base_lon, d.base_lat]
        const el = document.createElement('div')
        el.className = 'map-marker-icon drone-marker'
        el.style.color = DRONE_COLOR[d.status] ?? 'var(--muted)'
        el.appendChild(createIconElement(DRONE_ICON[d.type] ?? 'drone'))
        const mk = new maplibregl.Marker({ element: el })
          .setLngLat(pos as [number, number])
          .setPopup(new maplibregl.Popup({ offset: 10 }).setDOMContent(
            createPopup(d.name.replace('Реконс', 'Разузнаване'), [
              d.type === 'tanker' ? `Капацитет: ${d.capacity_l} л` : 'Разузнавателен',
              `Статус: ${d.status}`,
              'Демо данни',
            ], DRONE_COLOR[d.status])
          ))
          .addTo(m)
        markers.current.push(mk)
      }
    }

    if (m.isStyleLoaded()) draw()
    else m.on('load', draw)
  }, [towers, towerAlerts, citizenAlerts, drones, theme])

  if (!isOps) return (
    <div style={{ padding: '2rem', color: 'var(--muted)' }}>
      Само диспечери и администратори имат достъп до оперативния панел.
    </div>
  )

  const pendingAlerts = (towerAlerts ?? []).filter((a: any) => a.status === 'pending')
  const confirmedAlerts = (towerAlerts ?? []).filter((a: any) => a.status === 'confirmed')
  const pendingCitizenAlerts = (citizenAlerts ?? []).filter((a: any) => a.status === 'pending')
  const confirmedCitizenAlerts = (citizenAlerts ?? []).filter((a: any) => a.status === 'confirmed')
  const activeDrones = (drones ?? []).filter((d: any) => d.status !== 'idle')

  return (
    <div className="ops-page">
      {/* Карта */}
      <div ref={mapRef} className="ops-map" />

      {/* Панел */}
      <div className="ops-panel">
        <h2 className="icon-heading"><Icon name="shield" /> Оперативен панел</h2>

        {/* Статистика */}
        <div className="ops-stats">
          <div className="stat-box"><span>{(towers ?? []).length}</span><label>Кули</label></div>
          <div className="stat-box warn"><span>{pendingAlerts.length + pendingCitizenAlerts.length}</span><label>Чакащи</label></div>
          <div className="stat-box danger"><span>{confirmedAlerts.length + confirmedCitizenAlerts.length}</span><label>Потвърдени</label></div>
          <div className="stat-box info"><span>{activeDrones.length}</span><label>Активни дронове</label></div>
        </div>

        {/* Сигнали от кули */}
        <section>
          <h3 className="icon-heading"><Icon name="flame" size={16} /> Сигнали от кули <span className="meta">· демо данни</span></h3>
          {!(towerAlerts?.length) && <p className="muted-text">Няма сигнали</p>}
          {(towerAlerts ?? []).map((a: any) => (
            <div key={a.id} className={`ops-card status-${a.status}`}>
              <div className="ops-card-header">
                <strong>{a.tower_name}</strong>
                <span className={`badge badge-${a.status}`}>{a.status}</span>
              </div>
              <p className="ops-meta">{Number(a.lat).toFixed(4)}, {Number(a.lon).toFixed(4)} · {Math.round(a.confidence * 100)}% увереност</p>
              <p className="ops-meta">{new Date(a.created_at).toLocaleString('bg-BG')}</p>
              {a.status === 'pending' && (
                <div className="ops-actions">
                  <button className="btn-sm btn-confirm" onClick={() => updateAlertStatus.mutate({ id: a.id, status: 'confirmed' })}><Icon name="check" size={14} /> Потвърди</button>
                  <button className="btn-sm btn-dismiss" onClick={() => updateAlertStatus.mutate({ id: a.id, status: 'false_alarm' })}><Icon name="x" size={14} /> Фалшив</button>
                  <button className="btn-sm btn-recon"   onClick={() => dispatchRecon.mutate(a.id)}><Icon name="search" size={14} /> Разузнаване</button>
                </div>
              )}
              {a.status === 'confirmed' && (
                <div className="ops-actions">
                  <button className="btn-sm btn-tanker"  onClick={() => dispatchTanker.mutate(a.id)}><Icon name="droplet" size={14} /> Водоноска</button>
                  <button className="btn-sm btn-confirm" onClick={() => updateAlertStatus.mutate({ id: a.id, status: 'extinguished' })}><Icon name="check" size={14} /> Угасен</button>
                </div>
              )}
            </div>
          ))}
        </section>

        <section>
          <h3 className="icon-heading"><Icon name="flame" size={16} /> Граждански сигнали</h3>
          {dispatchCitizenRecon.error && (
            <p className="error" role="alert">
              {axios.isAxiosError(dispatchCitizenRecon.error)
                ? dispatchCitizenRecon.error.response?.data?.error ?? dispatchCitizenRecon.error.message
                : dispatchCitizenRecon.error.message}
            </p>
          )}
          {dispatchCitizenTanker.error && (
            <p className="error" role="alert">
              {axios.isAxiosError(dispatchCitizenTanker.error)
                ? dispatchCitizenTanker.error.response?.data?.error ?? dispatchCitizenTanker.error.message
                : dispatchCitizenTanker.error.message}
            </p>
          )}
          {updateCitizenAlertStatus.error && (
            <p className="error" role="alert">
              {axios.isAxiosError(updateCitizenAlertStatus.error)
                ? updateCitizenAlertStatus.error.response?.data?.error ?? updateCitizenAlertStatus.error.message
                : updateCitizenAlertStatus.error.message}
            </p>
          )}
          {!(citizenAlerts?.length) && <p className="muted-text">Няма граждански сигнали</p>}
          {(citizenAlerts ?? []).map((a: any) => (
            <div key={a.id} className={`ops-card status-${a.status}`}>
              <div className="ops-card-header">
                <strong>Сигнал #{a.id}</strong>
                <span className={`badge badge-${a.status}`}>{CITIZEN_ALERT_LABEL[a.status] ?? a.status}</span>
              </div>
              <p className="ops-meta">{Number(a.lat).toFixed(4)}, {Number(a.lon).toFixed(4)}</p>
              {a.description && <p>{a.description}</p>}
              <p className="ops-meta">{new Date(a.created_at).toLocaleString('bg-BG')}</p>
              <p className="ops-meta">
                {a.drone_recon_name
                  ? `Разузнавач: ${a.drone_recon_name} · ${a.drone_recon_status}`
                  : 'Чака свободен разузнавателен дрон'}
              </p>
              {a.drone_tanker_name && (
                <p className="ops-meta">
                  Водоноска: {a.drone_tanker_name} · {a.drone_tanker_status}
                </p>
              )}
              <div className="ops-actions">
                {!a.drone_recon_id && a.status !== 'dismissed' && (
                  <button className="btn-sm btn-recon" disabled={dispatchCitizenRecon.isPending}
                    onClick={() => dispatchCitizenRecon.mutate(a.id)}>
                    <Icon name="search" size={14} /> Изпрати разузнавач
                  </button>
                )}
                {a.status === 'pending' && (
                  <>
                    <button className="btn-sm btn-confirm" onClick={() => updateCitizenAlertStatus.mutate({ id: a.id, status: 'confirmed' })}><Icon name="check" size={14} /> Потвърди</button>
                    <button className="btn-sm btn-dismiss" onClick={() => updateCitizenAlertStatus.mutate({ id: a.id, status: 'dismissed' })}><Icon name="x" size={14} /> Отхвърли</button>
                  </>
                )}
                {a.status === 'confirmed' && !a.drone_tanker_id && (
                  <button className="btn-sm btn-tanker" disabled={dispatchCitizenTanker.isPending}
                    onClick={() => dispatchCitizenTanker.mutate(a.id)}>
                    <Icon name="droplet" size={14} /> Изпрати водоноска
                  </button>
                )}
                {a.status === 'confirmed' && (
                  <button className="btn-sm btn-confirm" disabled={updateCitizenAlertStatus.isPending}
                    onClick={() => updateCitizenAlertStatus.mutate({ id: a.id, status: 'extinguished' })}>
                    <Icon name="check" size={14} /> Угасен
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>

        {/* Дронове */}
        <section>
          <h3 className="icon-heading"><Icon name="drone" size={16} /> Дронове <span className="meta">· демо данни</span></h3>
          {(drones ?? []).map((d: any) => (
            <div key={d.id} className="ops-card">
              <div className="ops-card-header">
                <strong className="icon-heading"><Icon name={DRONE_ICON[d.type] ?? 'drone'} size={16} /> {d.name.replace('Реконс', 'Разузнаване')}</strong>
                <span className="badge" style={{ background: DRONE_COLOR[d.status] }}>{d.status}</span>
              </div>
              {d.type === 'tanker' && <p className="ops-meta">Капацитет: {d.capacity_l}л</p>}
              {d.status !== 'idle' && (
                <button className="btn-sm btn-dismiss" style={{ marginTop: '0.4rem' }} onClick={() => returnDrone.mutate(d.id)}><Icon name="arrow-return" size={14} /> Върни в база</button>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
