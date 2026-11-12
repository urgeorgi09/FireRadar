import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { useAuth } from './hooks/authContext'
import LoginPage      from './pages/LoginPage'
import MapPage        from './pages/MapPage'
import AlertsPage     from './pages/AlertsPage'
import OperationsPage from './pages/OperationsPage'
import AdminPage      from './pages/AdminPage'
import Navbar         from './components/Navbar'
import { ThemeProvider } from './hooks/ThemeProvider'
import { getAdminUrl, isAdminHost } from './utils/hosts'

function Inner() {
  const { token, role, logout } = useAuth()
  const adminHost = isAdminHost()

  useEffect(() => {
    if (adminHost && token && role !== 'admin' && role !== 'dispatcher') logout()
  }, [adminHost, token, role, logout])

  return (
    <div className="app">
      {(!adminHost || token) && <Navbar />}
      {adminHost ? (
        <Routes>
          <Route path="/login" element={
            token
              ? <Navigate to={role === 'admin' ? '/admin' : role === 'dispatcher' ? '/operations' : '/login'} />
              : <LoginPage />
          } />
          <Route path="/map" element={token && role !== 'citizen' ? <MapPage /> : <Navigate to="/login" />} />
          <Route path="/alerts" element={token && role !== 'citizen' ? <AlertsPage /> : <Navigate to="/login" />} />
          <Route path="/operations" element={
            token && (role === 'dispatcher' || role === 'admin') ? <OperationsPage /> : <Navigate to="/login" />
          } />
          <Route path="/admin" element={
            token && role === 'admin' ? <AdminPage /> : <Navigate to={token ? '/operations' : '/login'} />
          } />
          <Route path="*" element={
            <Navigate to={token ? (role === 'admin' ? '/admin' : '/operations') : '/login'} />
          } />
        </Routes>
      ) : (
        <Routes>
          <Route path="/map" element={<MapPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/login" element={<Navigate to={getAdminUrl()} />} />
          <Route path="*" element={<Navigate to="/map" />} />
        </Routes>
      )}
    </div>
  )
}

export default function App() {
  return <ThemeProvider><AuthProvider><Inner /></AuthProvider></ThemeProvider>
}
