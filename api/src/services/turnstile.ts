export async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
  const body = new URLSearchParams({ secret, response: token })
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error(`Turnstile verification failed with status ${response.status}`)

  const result: unknown = await response.json()
  return typeof result === 'object' && result !== null && 'success' in result && result.success === true
}
