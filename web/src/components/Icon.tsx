import type { SVGProps } from 'react'
import { ICON_PATHS, type IconName } from './iconPaths'

export function Icon({
  name,
  size = 18,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {ICON_PATHS[name].map(path => <path key={path} d={path} />)}
    </svg>
  )
}
