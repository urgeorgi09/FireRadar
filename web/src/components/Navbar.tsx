import { Link, useNavigate, useLocation } from 'react-router-dom'
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
  const location = useLocation()
  const adminHost = isAdminHost()

  const isActive = (path: string) => location.pathname.startsWith(path)

  return (
    <>
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

      {/* Bottom navigation — само на мобилни (CSS control) */}
      <nav className="bottom-nav">
        <div className="bottom-nav-inner">
          <Link to="/map" className={`bottom-nav-item ${isActive('/map') ? 'active' : ''}`}>
            <Icon name="map-pin" size={22} />
            Карта
          </Link>
          <Link to="/alerts" className={`bottom-nav-item ${isActive('/alerts') ? 'active' : ''}`}>
            <Icon name="flame" size={22} />
            Сигнали
          </Link>
          {adminHost && (
            <Link to="/operations" className={`bottom-nav-item ${isActive('/operations') || isActive('/admin') ? 'active' : ''}`}>
              <Icon name="shield" size={22} />
              Екип
            </Link>
          )}
          {!adminHost && (
            <a href={getAdminUrl()} className="bottom-nav-item">
              <Icon name="shield" size={22} />
              Вход
            </a>
          )}
        </div>
      </nav>
    </>
  )
}
