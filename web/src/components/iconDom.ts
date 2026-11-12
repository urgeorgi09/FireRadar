import { ICON_PATHS, type IconName } from './iconPaths'

export function createIconElement(name: IconName, className = ''): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(namespace, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  if (className) svg.setAttribute('class', className)

  for (const data of ICON_PATHS[name]) {
    const path = document.createElementNS(namespace, 'path')
    path.setAttribute('d', data)
    svg.appendChild(path)
  }
  return svg
}
