import { createHash, randomBytes } from 'node:crypto'

export function generateSensorApiKey(): string {
  return `fr_${randomBytes(24).toString('hex')}`
}

export function hashSensorApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
