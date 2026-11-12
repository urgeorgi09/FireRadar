import { afterEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/client.js', () => ({ default: query }))

import { updateForecasts } from './updateForecasts.js'

describe('updateForecasts failure handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('leaves stored forecasts untouched when Open-Meteo is unavailable', async () => {
    query.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('SELECT id, lat, lon, veg_type FROM cells'))
        return [{ id: 1, lat: 42.5, lon: 24, veg_type: 4 }]
      return []
    })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network reset')))
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      if (typeof callback === 'function') callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await updateForecasts()

    expect(fetch).toHaveBeenCalled()
    const statements = query.mock.calls.map(([strings]) =>
      Array.from(strings as TemplateStringsArray).join(''),
    )
    expect(statements.some(statement =>
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+risk_forecasts/i.test(statement),
    )).toBe(false)
  })
})
