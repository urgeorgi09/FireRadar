import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useAuth } from '../hooks/authContext'
import { Icon } from '../components/Icon'
import type { IconName } from '../components/iconPaths'

const ROLE_BG: Record<string, string> = {
  citizen:    'Гражданин',
  dispatcher: 'Диспечер',
  admin:      'Администратор',
}

export default function AdminPage() {
  const { token, role } = useAuth()
  const qc = useQueryClient()
  const headers = { Authorization: `Bearer ${token}` }
  const [activeTab, setActiveTab] = useState<'users' | 'audit' | 'stats' | 'sensors'>('users')
  const [simMsg, setSimMsg]       = useState('')
  const tabs: { id: 'users' | 'audit' | 'stats' | 'sensors'; label: string; icon: IconName }[] = [
    { id: 'users', label: 'Потребители', icon: 'users' },
    { id: 'audit', label: 'Журнал', icon: 'file-list' },
    { id: 'stats', label: 'Статистика', icon: 'chart' },
    { id: 'sensors', label: 'Сензори', icon: 'radio' },
  ]

  const { data: users }  = useQuery({ queryKey: ['admin-users'],  queryFn: () => axios.get('/api/admin/users',  { headers }).then(r => r.data), enabled: role === 'admin' })
  const { data: audit }  = useQuery({ queryKey: ['admin-audit'],  queryFn: () => axios.get('/api/admin/audit?limit=30', { headers }).then(r => r.data), enabled: role === 'admin' && activeTab === 'audit' })
  const { data: stats }  = useQuery({ queryKey: ['admin-stats'],  queryFn: () => axios.get('/api/admin/stats',  { headers }).then(r => r.data), enabled: role === 'admin' && activeTab === 'stats', refetchInterval: 30000 })
  const { data: towers } = useQuery({ queryKey: ['towers'],       queryFn: () => axios.get('/api/towers',       { headers }).then(r => r.data), enabled: role === 'admin' })

  const changeRole = useMutation({
    mutationFn: ({ id, role: r }: { id: number; role: string }) =>
      axios.patch(`/api/admin/users/${id}/role`, { role: r }, { headers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  const toggleUser = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      axios.patch(`/api/admin/users/${id}/status`, { active }, { headers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  const simulateSensor = useMutation({
    mutationFn: (tower_id: number) =>
      axios.post(`/api/sensors/simulate/${tower_id}`, {}, { headers }),
    onSuccess: (res) => {
      setSimMsg(`Сигнал изпратен от "${res.data.alert?.tower_id ? 'кула' : ''}" — увереност ${Math.round(res.data.alert?.confidence * 100)}%`)
      qc.invalidateQueries({ queryKey: ['tower-alerts'] })
      setTimeout(() => setSimMsg(''), 4000)
    },
  })

  if (role !== 'admin') return (
    <div style={{ padding: '2rem', color: 'var(--muted)' }}>
      Само администратори имат достъп до тази страница.
    </div>
  )

  return (
    <div className="alerts-page" style={{ maxWidth: 960 }}>
      <h2 className="icon-heading"><Icon name="settings" /> Администраторски панел</h2>

      {/* Табове */}
      <div className="mode-tabs" style={{ marginBottom: '1.5rem', marginTop: '1rem', justifyContent: 'flex-start' }}>
        {tabs.map(t => (
          <button key={t.id} className={activeTab === t.id ? 'active' : ''} onClick={() => setActiveTab(t.id)}>
            <Icon name={t.icon} size={16} /> {t.label}
          </button>
        ))}
      </div>

      {/* Потребители */}
      {activeTab === 'users' && (
        <div>
          <h3 style={{ marginBottom: '0.75rem' }}>Потребители</h3>
          {(users ?? []).map((u: any) => (
            <div key={u.id} className={`card alert-card ${u.active ? '' : 'status-dismissed'}`} style={{ marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div>
                  <strong>{u.email}</strong>
                  <span className="nav-role" style={{ marginLeft: '0.5rem' }}>{ROLE_BG[u.role] ?? u.role}</span>
                  {!u.active && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--extreme)' }}>ДЕАКТИВИРАН</span>}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <select
                    value={u.role}
                    onChange={e => changeRole.mutate({ id: u.id, role: e.target.value })}
                    className="date-input"
                    style={{ fontSize: '0.8rem' }}
                  >
                    <option value="citizen">Гражданин</option>
                    <option value="dispatcher">Диспечер</option>
                    <option value="admin">Администратор</option>
                  </select>
                  <button
                    className={`btn-sm ${u.active ? 'btn-dismiss' : 'btn-confirm'}`}
                    onClick={() => toggleUser.mutate({ id: u.id, active: !u.active })}
                  >
                    <Icon name={u.active ? 'lock' : 'unlock'} size={15} />
                    {u.active ? 'Деактивирай' : 'Активирай'}
                  </button>
                </div>
              </div>
              <p className="meta">{new Date(u.created_at).toLocaleString('bg-BG')}</p>
            </div>
          ))}
        </div>
      )}

      {/* Журнал */}
      {activeTab === 'audit' && (
        <div>
          <h3 style={{ marginBottom: '0.75rem' }}>Последни 30 действия</h3>
          {!(audit?.length) && <p style={{ color: 'var(--muted)' }}>Няма записи</p>}
          {(audit ?? []).map((a: any) => (
            <div key={a.id} className="card" style={{ marginBottom: '0.4rem', padding: '0.6rem 1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span><strong>{a.actor_email}</strong> · <code style={{ color: 'var(--primary)' }}>{a.action}</code>{a.target_id ? ` #${a.target_id}` : ''}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{new Date(a.created_at).toLocaleString('bg-BG')}</span>
              </div>
              {a.details && <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 2 }}>{JSON.stringify(a.details)}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Статистика */}
      {activeTab === 'stats' && stats && (
        <div>
          <h3 style={{ marginBottom: '0.75rem' }}>Системна статистика</h3>
          <div className="ops-stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            {[
              ['Потребители', stats.total_users],
              ['Граждани', stats.citizens],
              ['Диспечери', stats.dispatchers],
              ['Клетки', stats.total_cells],
              ['Прогнози', stats.total_forecasts],
              ['Сигнали', stats.total_alerts],
              ['Потвърдени', stats.confirmed_alerts],
              ['Сигнали от кули', stats.tower_alerts],
              ['Активни дронове', stats.active_drones],
            ].map(([label, val]) => (
              <div key={label as string} className="stat-box">
                <span>{val ?? '—'}</span>
                <label>{label}</label>
              </div>
            ))}
          </div>
          {stats.last_forecast_at && (
            <p style={{ marginTop: '1rem', fontSize: '0.82rem', color: 'var(--muted)' }}>
              Последна прогноза: {new Date(stats.last_forecast_at).toLocaleString('bg-BG')}
            </p>
          )}
        </div>
      )}

      {/* Сензори */}
      {activeTab === 'sensors' && (
        <div>
          <h3 style={{ marginBottom: '0.5rem' }}>Симулатор на сензорни сигнали</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1rem', lineHeight: 1.5 }}>
            При реална работа кулите изпращат сигнали към <code>POST /sensors/tower-alert</code> с <code>X-API-Key</code> header.
            Тук можеш да симулираш такъв сигнал от избрана кула — демонстрира оперативна съвместимост.
          </p>
          {simMsg && <p className="icon-heading" style={{ color: 'var(--low)', marginBottom: '0.75rem' }}><Icon name="check" size={16} /> {simMsg}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {(towers ?? []).map((t: any) => (
              <div key={t.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 1rem' }}>
                <div>
                  <strong className="icon-heading"><Icon name="tower" size={17} /> {t.name}</strong>
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)', marginLeft: '0.5rem' }}>
                    {Number(t.lat).toFixed(3)}, {Number(t.lon).toFixed(3)} · {t.radius_km} км
                  </span>
                </div>
                <button
                  className="btn-sm btn-recon"
                  onClick={() => simulateSensor.mutate(t.id)}
                  disabled={simulateSensor.isPending}
                >
                  <Icon name="radio" size={15} /> Симулирай сигнал
                </button>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginTop: '1rem', fontSize: '0.82rem', color: 'var(--muted)' }}>
            <strong>Реален API endpoint:</strong>
            <pre style={{ marginTop: '0.5rem', background: 'var(--bg)', padding: '0.75rem', borderRadius: 6, overflowX: 'auto' }}>{`POST /sensors/tower-alert
Headers: X-API-Key: fr_<48-символен ключ>
Body: {
  "lat": 42.65,
  "lon": 23.28,
  "confidence": 0.87,
  "smoke_density": 0.6,
  "temperature": 85.5
}`}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
