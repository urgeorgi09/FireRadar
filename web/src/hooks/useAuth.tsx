import { useState, useEffect, useCallback, type ReactNode } from 'react'
import axios from 'axios'
import { AuthContext } from './authContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => localStorage.getItem('fr_token'))
  const [role,  setRole]  = useState(() => localStorage.getItem('fr_role'))
  const [email, setEmail] = useState(() => localStorage.getItem('fr_email'))

  const login = useCallback((t: string, r: string, e: string) => {
    localStorage.setItem('fr_token', t)
    localStorage.setItem('fr_role',  r)
    localStorage.setItem('fr_email', e)
    setToken(t); setRole(r); setEmail(e)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('fr_token')
    localStorage.removeItem('fr_role')
    localStorage.removeItem('fr_email')
    setToken(null); setRole(null); setEmail(null)
  }, [])

  // Access token expires after 15 minutes; refresh it before expiry.
  useEffect(() => {
    if (!token) return

    // Проверяваме exp claim при всяко mount (включително tab wake от sleep)
    const tryRefresh = async () => {
      try {
        const payload = JSON.parse(atob(token.split('.')[1] ?? ''))
        const expiresInMs = payload.exp * 1000 - Date.now()
        // Ако изтича в следващите 2 минути — refresh веднага
        if (expiresInMs < 2 * 60 * 1000) {
          const res = await axios.post('/api/auth/refresh', {}, {
            headers: { Authorization: `Bearer ${token}` }
          })
          localStorage.setItem('fr_token', res.data.token)
          setToken(res.data.token)
          return
        }
      } catch {
        logout()
        return
      }
    }

    void tryRefresh()

    const refresh = async () => {
      try {
        const res = await axios.post('/api/auth/refresh', {}, {
          headers: { Authorization: `Bearer ${token}` }
        })
        const newToken = res.data.token
        localStorage.setItem('fr_token', newToken)
        setToken(newToken)
      } catch {
        logout()
      }
    }
    // Refresh на всеки 10 мин — токенът е 15 мин
    const id = setInterval(refresh, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [token, logout])

  // При зареждане: проверяваме дали токенът все още е валиден
  useEffect(() => {
    if (!token) return
    axios.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .catch(() => logout())
  }, [token, logout])

  return (
    <AuthContext.Provider value={{ token, role, email, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
