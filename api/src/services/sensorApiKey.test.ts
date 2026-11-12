import { describe, expect, it } from 'vitest'
import { generateSensorApiKey, hashSensorApiKey } from './sensorApiKey.js'

describe('sensor API keys', () => {
  it('generates unique 192-bit keys and hashes them without retaining the original', () => {
    const first = generateSensorApiKey()
    const second = generateSensorApiKey()

    expect(first).toMatch(/^fr_[a-f0-9]{48}$/)
    expect(second).not.toBe(first)
    expect(hashSensorApiKey(first)).toMatch(/^[a-f0-9]{64}$/)
    expect(hashSensorApiKey(first)).not.toBe(first)
    expect(hashSensorApiKey(first)).toBe(hashSensorApiKey(first))
  })
})
