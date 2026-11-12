import { createHash } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import postgres, { type Sql } from 'postgres'
import { runMigrations } from './migrate.js'

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL
const admin = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null
const schema = `migration_test_${process.pid}_${Date.now()}`
let isolatedDatabase: Sql | null = null

afterAll(async () => {
  if (isolatedDatabase) await isolatedDatabase.end()
  if (admin) {
    try {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.end()
    }
  }
})

describe('database migrations with PostgreSQL', () => {
  const migrationTest = databaseUrl ? it : it.skip

  migrationTest('can migrate the sensor key table twice', async () => {
    if (!admin) throw new Error('PostgreSQL test connection is unavailable')

    await admin.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public')
    await admin.unsafe(`CREATE SCHEMA "${schema}"`)
    isolatedDatabase = postgres(databaseUrl!, { max: 1 })
    await isolatedDatabase.unsafe(`SET search_path TO "${schema}", public`)
    await isolatedDatabase`
      CREATE TABLE sensor_api_keys (
        id SERIAL PRIMARY KEY,
        api_key TEXT NOT NULL
      )
    `
    await isolatedDatabase`
      CREATE TABLE alerts (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending'
          CONSTRAINT alerts_status_check CHECK (status IN ('pending','confirmed','dismissed')),
        drone_recon_id INT
      )
    `
    await isolatedDatabase`CREATE TABLE drones (id SERIAL PRIMARY KEY)`
    const key = 'migration-test-key'
    await isolatedDatabase`INSERT INTO sensor_api_keys (api_key) VALUES (${key})`

    await runMigrations(isolatedDatabase)
    await runMigrations(isolatedDatabase)

    const [result] = await isolatedDatabase<{ api_key_hash: string }[]>`
      SELECT api_key_hash FROM sensor_api_keys
    `
    const [migrationCount] = await isolatedDatabase<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM schema_migrations
      WHERE version = '001_sensor_api_key_hash'
    `
    const [citizenAlertDroneMigrationCount] = await isolatedDatabase<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM schema_migrations
      WHERE version = '002_citizen_alert_drone'
    `
    const [droneColumn] = await isolatedDatabase<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${schema}
          AND table_name = 'drones'
          AND column_name = 'citizen_alert_id'
      ) AS exists
    `
    const [tankerColumn] = await isolatedDatabase<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${schema}
          AND table_name = 'alerts'
          AND column_name = 'drone_tanker_id'
      ) AS exists
    `
    const [statusConstraint] = await isolatedDatabase<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'alerts'::regclass
        AND conname = 'alerts_status_check'
    `
    expect(result.api_key_hash).toBe(createHash('sha256').update(key).digest('hex'))
    expect(migrationCount.count).toBe(1)
    expect(citizenAlertDroneMigrationCount.count).toBe(1)
    expect(droneColumn.exists).toBe(true)
    expect(tankerColumn.exists).toBe(true)
    expect(statusConstraint.definition).toContain('extinguished')
  })
})
