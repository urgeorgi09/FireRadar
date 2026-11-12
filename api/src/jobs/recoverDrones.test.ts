import { afterEach, describe, expect, it, vi } from 'vitest'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../db/client.js', () => ({ default: query }))

import { recoverDrones } from './recoverDrones.js'

describe('recoverDrones', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('resets active missions to their base location after restart', async () => {
    query.mockResolvedValue([{ id: 4 }])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await recoverDrones()

    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0][0].join('')).toContain("status = 'idle'")
    expect(query.mock.calls[0][0].join('')).toContain('current_geom = base_geom')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('1 дрона'))
  })
})
