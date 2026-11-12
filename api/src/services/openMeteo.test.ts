import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchOpenMeteoArchive } from './openMeteo.js'

describe('fetchOpenMeteoArchive', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retries network failures and returns the successful response', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('network reset'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    const response = await fetchOpenMeteoArchive('https://archive-api.open-meteo.com/test')

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-transient client errors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))
    vi.stubGlobal('fetch', fetch)

    await expect(fetchOpenMeteoArchive('https://archive-api.open-meteo.com/test'))
      .rejects.toThrow('Open-Meteo Archive API върна 400')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails explicitly after transient errors are exhausted', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('network reset'))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })

    await expect(fetchOpenMeteoArchive('https://archive-api.open-meteo.com/test'))
      .rejects.toThrow('Open-Meteo Archive API е недостъпен след 4 опита')
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
