import { createContext, useContext } from 'react'

export interface AuthCtx {
  token: string | null
  role: string | null
  email: string | null
  login: (token: string, role: string, email: string) => void
  logout: () => void
}

export const AuthContext = createContext<AuthCtx>(null!)

export const useAuth = () => useContext(AuthContext)
