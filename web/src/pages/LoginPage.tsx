import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../hooks/authContext'
import axios from 'axios'
import { Icon } from '../components/Icon'
import ThemeToggle from '../components/ThemeToggle'
import { isAdminHost, getPublicMapUrl } from '../utils/hosts'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const { data } = await axios.post('/api/auth/login', { email, password })
      login(data.token, data.role, data.email)
      navigate(data.role === 'admin' ? '/admin' : '/operations')
    } catch {
      setError('Грешен имейл или парола')
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Превключвател за тема в ъгъла */}
        <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem' }}>
          <ThemeToggle />
        </div>

        <div className="login-logo"><Icon name="flame" size={42} /></div>
        <h1>FireRadar</h1>
        <p>Вход за екипа</p>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Имейл"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <input
            type="password"
            placeholder="Парола"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            inputMode="text"
          />
          {error && <p className="error">{error}</p>}
          <button type="submit">Вход</button>
        </form>

        {/* Връзка назад към картата — ако сме на admin домейна, води към публичния домейн */}
        {isAdminHost() ? (
          <a
            href={getPublicMapUrl()}
            style={{
              display: 'block', marginTop: '1.25rem',
              color: 'var(--muted)', textDecoration: 'none', fontSize: '0.85rem'
            }}
          >
            ← Назад към картата
          </a>
        ) : (
          <Link
            to="/map"
            style={{
              display: 'block', marginTop: '1.25rem',
              color: 'var(--muted)', textDecoration: 'none', fontSize: '0.85rem'
            }}
          >
            ← Назад към картата
          </Link>
        )}
      </div>
    </div>
  )
}
