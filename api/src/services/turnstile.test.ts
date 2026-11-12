import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyTurnstile } from './turnstile.js'

describe('verifyTurnstile', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accepts a successful Turnstile response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(verifyTurnstile('challenge-token', 'secret')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects unsuccessful challenges', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200 }),
    ))

    await expect(verifyTurnstile('invalid-token', 'secret')).resolves.toBe(false)
  })

  it('surfaces provider errors instead of accepting the report', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { status: 503 }),
    ))

    await expect(verifyTurnstile('challenge-token', 'secret'))
      .rejects.toThrow('Turnstile verification failed with status 503')
  })
})
