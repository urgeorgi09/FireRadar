export async function fetchOpenMeteoArchive(url: string): Promise<Response> {
  const maxAttempts = 4
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts - 1)
        await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)))
      continue
    }

    if (response.ok) return response

    lastError = new Error(`Open-Meteo Archive API върна ${response.status}`)
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === maxAttempts - 1) throw lastError
    await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)))
  }

  throw new Error(`Open-Meteo Archive API е недостъпен след ${maxAttempts} опита`, {
    cause: lastError,
  })
}
