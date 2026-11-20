export function isAdminHost() {
  return window.location.hostname.startsWith('admin.')
}

export function getAdminUrl() {
  const hostname = window.location.hostname.replace(/^www\./, '')
  return `${window.location.protocol}//admin.${hostname}${window.location.port ? `:${window.location.port}` : ''}/login`
}

/** Връща URL на публичната карта — маха 'admin.' от hostname-а ако сме на admin поддомейн. */
export function getPublicMapUrl() {
  const hostname = window.location.hostname.replace(/^admin\./, '')
  return `${window.location.protocol}//${hostname}${window.location.port ? `:${window.location.port}` : ''}/map`
}
