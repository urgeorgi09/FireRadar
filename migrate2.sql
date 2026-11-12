ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  actor_id    INT REFERENCES users(id),
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_id   TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS audit_log_time_idx  ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS sensor_api_keys (
  id          SERIAL PRIMARY KEY,
  tower_id    INT REFERENCES watch_towers(id) ON DELETE CASCADE,
  api_key_hash TEXT NOT NULL UNIQUE,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
