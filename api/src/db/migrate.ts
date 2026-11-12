import 'dotenv/config'
import type { Sql } from 'postgres'
import sql from './client.js'

const SENSOR_KEY_HASH_MIGRATION = '001_sensor_api_key_hash'
const CITIZEN_ALERT_DRONE_MIGRATION = '002_citizen_alert_drone'
const CITIZEN_ALERT_TANKER_MIGRATION = '003_citizen_alert_tanker'
const CITIZEN_ALERT_EXTINGUISHED_MIGRATION = '004_citizen_alert_extinguished'

export async function runMigrations(database: Sql = sql) {
  await database.begin(async tx => {
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
    const [sensorMigration] = await tx<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = ${SENSOR_KEY_HASH_MIGRATION}
    `
    if (!sensorMigration) {
      await tx`CREATE EXTENSION IF NOT EXISTS pgcrypto`
      await tx`ALTER TABLE sensor_api_keys ADD COLUMN IF NOT EXISTS api_key_hash TEXT`
      await tx`
        DO $migration$
        DECLARE
          crypto_schema TEXT;
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'sensor_api_keys'
              AND column_name = 'api_key'
          ) THEN
            SELECT n.nspname INTO crypto_schema
            FROM pg_extension e
            JOIN pg_namespace n ON n.oid = e.extnamespace
            WHERE e.extname = 'pgcrypto';
            IF crypto_schema IS NULL THEN
              RAISE EXCEPTION 'pgcrypto extension is not installed';
            END IF;
            EXECUTE format(
              'UPDATE sensor_api_keys SET api_key_hash = encode(%I.digest(api_key, %L), %L) WHERE api_key_hash IS NULL',
              crypto_schema, 'sha256', 'hex'
            );
            ALTER TABLE sensor_api_keys DROP COLUMN api_key;
          END IF;
        END
        $migration$;
      `
      await tx`CREATE UNIQUE INDEX IF NOT EXISTS sensor_api_keys_hash_idx ON sensor_api_keys(api_key_hash)`
      await tx`ALTER TABLE sensor_api_keys ALTER COLUMN api_key_hash SET NOT NULL`
      await tx`INSERT INTO schema_migrations (version) VALUES (${SENSOR_KEY_HASH_MIGRATION})`
    }

    const [citizenAlertDroneMigration] = await tx<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = ${CITIZEN_ALERT_DRONE_MIGRATION}
    `
    if (!citizenAlertDroneMigration) {
      await tx`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS drone_recon_id INT`
      await tx`ALTER TABLE drones ADD COLUMN IF NOT EXISTS citizen_alert_id INT REFERENCES alerts(id)`
      await tx`
        DO $migration$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'fk_alert_drone_recon'
              AND conrelid = 'alerts'::regclass
          ) THEN
            ALTER TABLE alerts ADD CONSTRAINT fk_alert_drone_recon
              FOREIGN KEY (drone_recon_id) REFERENCES drones(id);
          END IF;
        END
        $migration$;
      `
      await tx`INSERT INTO schema_migrations (version) VALUES (${CITIZEN_ALERT_DRONE_MIGRATION})`
    }

    const [citizenAlertTankerMigration] = await tx<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = ${CITIZEN_ALERT_TANKER_MIGRATION}
    `
    if (!citizenAlertTankerMigration) {
      await tx`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS drone_tanker_id INT`
      await tx`
        DO $migration$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'fk_alert_drone_tanker'
              AND conrelid = 'alerts'::regclass
          ) THEN
            ALTER TABLE alerts ADD CONSTRAINT fk_alert_drone_tanker
              FOREIGN KEY (drone_tanker_id) REFERENCES drones(id);
          END IF;
        END
        $migration$;
      `
      await tx`INSERT INTO schema_migrations (version) VALUES (${CITIZEN_ALERT_TANKER_MIGRATION})`
    }

    const [citizenAlertExtinguishedMigration] = await tx<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = ${CITIZEN_ALERT_EXTINGUISHED_MIGRATION}
    `
    if (!citizenAlertExtinguishedMigration) {
      await tx`ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_status_check`
      await tx`
        ALTER TABLE alerts
        ADD CONSTRAINT alerts_status_check
        CHECK (status IN ('pending','confirmed','dismissed','extinguished'))
      `
      await tx`INSERT INTO schema_migrations (version) VALUES (${CITIZEN_ALERT_EXTINGUISHED_MIGRATION})`
    }
  })
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/src/db/migrate.ts')) {
  try {
    await runMigrations()
  } finally {
    await sql.end()
  }
}
