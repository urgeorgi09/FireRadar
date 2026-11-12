import { useTheme } from '../hooks/useTheme'
import { Icon } from './Icon'

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const label = theme === 'dark' ? 'Превключи към светла тема' : 'Превключи към тъмна тема'

  return (
    <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={label} title={label}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
      <span className="theme-toggle-label">{theme === 'dark' ? 'Светла тема' : 'Тъмна тема'}</span>
    </button>
  )
}
