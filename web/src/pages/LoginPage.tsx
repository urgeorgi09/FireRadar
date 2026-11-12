import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/authContext'
import axios from 'axios'
import { Icon } from '../components/Icon'
import ThemeToggle from '../components/ThemeToggle'

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
        <div className="login-logo"><Icon name="flame" size={42} /></div>
        <h1>FireRadar</h1>
        <p>Система за ранно предупреждение за горски пожари</p>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Имейл"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Парола"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          {error && <p className="error">{error}</p>}
          <button type="submit">Вход</button>
        </form>
        <ThemeToggle />
      </div>
    </div>
  )
}
