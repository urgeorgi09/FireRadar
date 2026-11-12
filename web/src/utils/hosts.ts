export function isAdminHost() {
  return window.location.hostname.startsWith('admin.')
}

export function getAdminUrl() {
  const hostname = window.location.hostname.replace(/^www\./, '')
  return `${window.location.protocol}//admin.${hostname}${window.location.port ? `:${window.location.port}` : ''}/login`
}
