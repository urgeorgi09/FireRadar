import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import axios from 'axios'
import App from './App'
import './index.css'

// ── Axios interceptor: 401 → logout + redirect ──────────────────────────────
// Хваща изтекъл или невалиден токен и изчиства localStorage,
// така че потребителят вижда login страница вместо ERR_CONNECTION_RESET.
axios.interceptors.response.use(
  res => res,
  err => {
    if (err?.response?.status === 401) {
      // Изчистваме сесията
      localStorage.removeItem('fr_token')
      localStorage.removeItem('fr_role')
      localStorage.removeItem('fr_email')
      // Пращаме на login само ако не сме вече там
      if (!window.location.pathname.includes('/login')) {
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        // Не retry при 401/403/404
        if ([401, 403, 404].includes(error?.response?.status)) return false
        return failureCount < 2
      },
      staleTime: 30_000,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
