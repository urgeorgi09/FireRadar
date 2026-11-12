import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/authContext'
import { Icon } from './Icon'
import ThemeToggle from './ThemeToggle'
import { getAdminUrl, isAdminHost } from '../utils/hosts'

const ROLE_BG: Record<string, string> = {
  citizen:    'Гражданин',
  dispatcher: 'Диспечер',
  admin:      'Администратор',
}

export default function Navbar() {
  const { role, email, logout } = useAuth()
  const navigate = useNavigate()
  const adminHost = isAdminHost()

  return (
    <nav className="navbar">
      <div className="nav-brand"><Icon name="flame" size={19} /> FireRadar</div>
      <div className="nav-links">
        {adminHost ? (
          <>
            <Link to="/map">Карта</Link>
            <Link to="/alerts">Сигнали</Link>
            {(role === 'dispatcher' || role === 'admin') && <Link to="/operations">Операции</Link>}
            {role === 'admin' && <Link to="/admin">Администрация</Link>}
            <span className="nav-role" title={email ?? ''}>{ROLE_BG[role ?? ''] ?? role}</span>
            <ThemeToggle />
            <button onClick={() => { logout(); navigate('/login') }}>Изход</button>
          </>
        ) : (
          <>
            <Link to="/map">Карта</Link>
            <Link to="/alerts">Сигнали</Link>
            <a href={getAdminUrl()}>Вход за екипа</a>
            <ThemeToggle />
          </>
        )}
      </div>
    </nav>
  )
}
