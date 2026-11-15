import { useEffect, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getBasemapStyle, maplibregl } from '../lib/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import axios from 'axios'
import { useAuth } from '../hooks/authContext'
import { useTheme } from '../hooks/useTheme'
import { Icon } from '../components/Icon'
import Turnstile from '../components/Turnstile'

export default function AlertsPage() {
  const { token, role } = useAuth()
  const { theme } = useTheme()
  const qc = useQueryClient()
  const [lat, setLat] = useState('')
  const [lon, setLon] = useState('')
  const [desc, setDesc] = useState('')
  const [success, setSuccess] = useState(false)
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaEpoch, setCaptchaEpoch] = useState(0)
  const [locating, setLocating] = useState(false)
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstance = useRef<maplibregl.Map | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  const mapViewRef = useRef<{
    center: [number, number]
    zoom: number
    bearing: number
    pitch: number
  } | null>(null)

  const headers = { Authorization: `Bearer ${token}` }

  const { data: alerts, isLoading: alertsLoading } = useQuery({
    queryKey: ['alerts'],
    queryFn: () => axios.get('/api/alerts', { headers }).then(r => r.data),
    enabled: role === 'dispatcher' || role === 'admin',
  })

  const submit = useMutation({
    mutationFn: () => axios.post('/api/alerts', {
      lat: +lat,
      lon: +lon,
      description: desc,
      captchaToken,
    }, { headers: token ? headers : undefined }),
    onSuccess: () => {
      setLat(''); setLon(''); setDesc(''); setCaptchaToken(''); setCaptchaEpoch(epoch => epoch + 1); setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    },
    onError: () => {
      setCaptchaToken('')
      setCaptchaEpoch(epoch => epoch + 1)
    },
  })

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      axios.patch(`/api/alerts/${id}`, { status }, { headers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  })

  // Geolocation API — "Използвай моето местоположение"
  const useMyLocation = () => {
    if (!navigator.geolocation) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(5))
        setLon(pos.coords.longitude.toFixed(5))
        setLocating(false)
      },
      (err) => {
        console.warn('Geolocation error:', err.message)
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  // Мини-карта за избор на координати (само за граждани)
  useEffect(() => {
    if ((role !== 'citizen' && role !== null) || !mapRef.current) return
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: getBasemapStyle(theme),
      attributionControl: false,  // добавяме ръчно с compact
      ...(mapViewRef.current ?? { center: [25.5, 42.7] as [number, number], zoom: 6.5, bearing: 0, pitch: 0 }),
    })
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.on('load', () => {
      mapRef.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show')
    })
    mapInstance.current = map
    map.on('click', (e) => {
      const { lat: y, lng: x } = e.lngLat
      setLat(y.toFixed(5))
      setLon(x.toFixed(5))
    })
    return () => {
      const center = map.getCenter()
      mapViewRef.current = {
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      }
      markerRef.current?.remove()
      markerRef.current = null
      map.remove()
      if (mapInstance.current === map) mapInstance.current = null
    }
  }, [role, theme])

  useEffect(() => {
    const map = mapInstance.current
    markerRef.current?.remove()
    markerRef.current = null
    if (!map || !lat || !lon || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return
    markerRef.current = new maplibregl.Marker({ color: '#ef4444' })
      .setLngLat([Number(lon), Number(lat)])
      .addTo(map)
  }, [lat, lon, role, theme])

  const isPublicReporter = role === null || role === 'citizen'

  return (
    <div className="alerts-page">
      {isPublicReporter && (
        <div className="alert-form card">
          {/* Бележка за спешни случаи */}
          <div className="alert-112-notice">
            <Icon name="flame" size={16} /> При опасност за живот се обади на <strong>112</strong>
          </div>

          <h2>Подай сигнал за пожар</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>
            Кликни на картата или използвай местоположението си
          </p>

          {/* Мини-карта */}
          <div ref={mapRef} style={{ height: 220, borderRadius: 8, marginBottom: '0.6rem', border: '1px solid var(--border)' }} />

          {/* Бутон за геолокация */}
          <button
            className="btn-locate"
            onClick={useMyLocation}
            disabled={locating}
            style={{ marginBottom: '0.5rem' }}
          >
            {locating ? '⌛ Намиране…' : (<><Icon name="map-pin" size={18} /> Използвай моето местоположение</>)}
          </button>

          {/* Координати — на компютър: две полета, на мобилни: един ред "Избрано място" */}
          <div className="alert-coords-desktop" style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
            <input
              placeholder="Ширина"
              value={lat ? `${lat}°N` : ''}
              readOnly
              style={{ flex: 1, opacity: lat ? 1 : 0.4 }}
              aria-label="Географска ширина"
            />
            <input
              placeholder="Дължина"
              value={lon ? `${lon}°E` : ''}
              readOnly
              style={{ flex: 1, opacity: lon ? 1 : 0.4 }}
              aria-label="Географска дължина"
            />
          </div>
          {/* На мобилни: един ред с избраното място */}
          <div className="alert-coords-mobile">
            {lat && lon ? (
              <p className="alert-selected-place"><Icon name="map-pin" size={16} /> Избрано място: {lat}°N, {lon}°E</p>
            ) : (
              <p className="alert-selected-place" style={{ opacity: 0.5 }}>Местоположението не е избрано</p>
            )}
          </div>

          <textarea
            placeholder="Описание (незадължително)"
            value={desc}
            onChange={e => setDesc(e.target.value)}
            maxLength={500}
          />

          <Turnstile key={captchaEpoch} onToken={setCaptchaToken} />

          {success && <p className="icon-heading" style={{ color: 'var(--low)', fontSize: '0.85rem' }}><Icon name="check" size={16} /> Сигналът е изпратен успешно</p>}
          {submit.isError && <p className="error">{axios.isAxiosError(submit.error) ? submit.error.response?.data?.error ?? 'Сигналът не можа да бъде изпратен.' : 'Сигналът не можа да бъде изпратен.'}</p>}

          {/* Sticky submit бутон */}
          <div className="alert-submit-sticky">
            <button
              onClick={() => submit.mutate()}
              disabled={!lat || !lon || !captchaToken || submit.isPending}
            >
              {submit.isPending ? 'Изпращане...' : 'Изпрати сигнал'}
            </button>
          </div>
        </div>
      )}

      {(role === 'dispatcher' || role === 'admin') && (
        <div className="alerts-list">
          <h2>Сигнали от граждани</h2>
          {alertsLoading && <p style={{ color: 'var(--muted)' }}>Зареждане…</p>}
          {!alertsLoading && !alerts?.length && <p style={{ color: 'var(--muted)' }}>Няма сигнали</p>}
          {alerts?.map((a: any) => (
            <div key={a.id} className={`alert-card card status-${a.status}`}>
              <p>
                <strong>#{a.id}</strong> —{' '}
                <a
                  href={`https://www.google.com/maps?q=${a.lat},${a.lon}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--primary)' }}
                >
                  {Number(a.lat).toFixed(4)}, {Number(a.lon).toFixed(4)}
                </a>
              </p>
              {a.description && <p style={{ marginTop: 4 }}>{a.description}</p>}
              <p className="meta">{new Date(a.created_at).toLocaleString('bg-BG')} · <strong>{a.status}</strong></p>
              {a.status === 'pending' && (
                <div className="actions">
                  <button className="confirm" onClick={() => updateStatus.mutate({ id: a.id, status: 'confirmed' })}><Icon name="check" size={14} /> Потвърди</button>
                  <button className="dismiss" onClick={() => updateStatus.mutate({ id: a.id, status: 'dismissed' })}><Icon name="x" size={14} /> Отхвърли</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
