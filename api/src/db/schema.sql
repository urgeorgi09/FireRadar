-- Разширения
CREATE EXTENSION IF NOT EXISTS postgis;

-- Потребители
CREATE TABLE users (
  id        SERIAL PRIMARY KEY,
  email     TEXT UNIQUE NOT NULL,
  password  TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('citizen','dispatcher','admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Клетки на мрежата (~10×10 км)
CREATE TABLE cells (
  id       SERIAL PRIMARY KEY,
  geom     GEOMETRY(Polygon, 4326) NOT NULL,
  center   GEOMETRY(Point, 4326) NOT NULL,
  lat      FLOAT NOT NULL,
  lon      FLOAT NOT NULL,
  veg_type SMALLINT NOT NULL DEFAULT 4
);
CREATE INDEX cells_geom_idx ON cells USING GIST(geom);

-- Метео наблюдения
CREATE TABLE weather_obs (
  id         SERIAL PRIMARY KEY,
  cell_id    INT REFERENCES cells(id),
  observed_at TIMESTAMPTZ NOT NULL,
  temp       FLOAT,
  humidity   FLOAT,
  wind_speed FLOAT,
  precip     FLOAT,
  UNIQUE(cell_id, observed_at)
);

-- Пожари (от FIRMS)
CREATE TABLE fires (
  id         SERIAL PRIMARY KEY,
  lat        FLOAT NOT NULL,
  lon        FLOAT NOT NULL,
  detected_at DATE NOT NULL,
  brightness FLOAT,
  confidence TEXT,
  geom       GEOMETRY(Point, 4326),
  source_id  TEXT UNIQUE
);
CREATE INDEX fires_geom_idx ON fires USING GIST(geom);

-- Прогнози за риск
CREATE TABLE risk_forecasts (
  id         SERIAL PRIMARY KEY,
  cell_id    INT REFERENCES cells(id),
  forecast_at TIMESTAMPTZ NOT NULL,
  fwi        FLOAT,
  risk_level TEXT CHECK (risk_level IN ('low','moderate','high','extreme')),
  risk_score DOUBLE PRECISION,
  risk_source TEXT CHECK (risk_source IN ('model','fwi')),
  explanation TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cell_id, forecast_at)
);

-- Сигнали от граждани
CREATE TABLE alerts (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),
  lat         FLOAT NOT NULL,
  lon         FLOAT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CONSTRAINT alerts_status_check CHECK (status IN ('pending','confirmed','dismissed','extinguished')),
  drone_recon_id INT,
  drone_tanker_id INT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Наблюдателни кули
CREATE TABLE watch_towers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  lat         FLOAT NOT NULL,
  lon         FLOAT NOT NULL,
  geom        GEOMETRY(Point, 4326) NOT NULL,
  radius_km   FLOAT NOT NULL DEFAULT 15,   -- покривна зона
  cover_zone  GEOMETRY(Polygon, 4326),     -- изчислен кръг
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','maintenance')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX watch_towers_geom_idx ON watch_towers USING GIST(geom);

-- Сигнали от кули
CREATE TABLE tower_alerts (
  id          SERIAL PRIMARY KEY,
  tower_id    INT REFERENCES watch_towers(id) ON DELETE CASCADE,
  lat         FLOAT NOT NULL,
  lon         FLOAT NOT NULL,
  geom        GEOMETRY(Point, 4326) NOT NULL,
  confidence  FLOAT NOT NULL DEFAULT 0.8,  -- 0-1
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','confirmed','false_alarm','extinguished')),
  drone_recon_id  INT,  -- FK добавен след дефиниция на drones
  drone_tanker_id INT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX tower_alerts_geom_idx ON tower_alerts USING GIST(geom);

-- Дронове (разузнавателни и водоносни)
CREATE TABLE drones (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('recon','tanker')),
  base_lat    FLOAT NOT NULL,
  base_lon    FLOAT NOT NULL,
  base_geom   GEOMETRY(Point, 4326) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idle'
              CHECK (status IN ('idle','en_route','inspecting','firefighting','returning')),
  current_lat FLOAT,
  current_lon FLOAT,
  current_geom GEOMETRY(Point, 4326),
  mission_polygon GEOMETRY(Polygon, 4326),  -- маршрут/зона на мисия
  tower_alert_id  INT REFERENCES tower_alerts(id),
  citizen_alert_id INT REFERENCES alerts(id),
  capacity_l  FLOAT DEFAULT 200,            -- само за tanker
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX drones_geom_idx ON drones USING GIST(base_geom);

-- Добавяме FK обратно към tower_alerts
ALTER TABLE tower_alerts ADD CONSTRAINT fk_drone_recon  FOREIGN KEY (drone_recon_id)  REFERENCES drones(id);
ALTER TABLE tower_alerts ADD CONSTRAINT fk_drone_tanker FOREIGN KEY (drone_tanker_id) REFERENCES drones(id);
ALTER TABLE alerts ADD CONSTRAINT fk_alert_drone_recon FOREIGN KEY (drone_recon_id) REFERENCES drones(id);
ALTER TABLE alerts ADD CONSTRAINT fk_alert_drone_tanker FOREIGN KEY (drone_tanker_id) REFERENCES drones(id);

-- Поле за активен/деактивиран потребител
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

-- Audit log — журнал на административните действия
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  actor_id    INT REFERENCES users(id),
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,   -- 'change_role', 'deactivate_user', 'dispatch_drone', ...
  target_id   TEXT,            -- id на засегнатия ресурс (потребител, дрон, кула)
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS audit_log_time_idx  ON audit_log(created_at DESC);

-- API ключове за сензори (кули)
CREATE TABLE IF NOT EXISTS sensor_api_keys (
  id          SERIAL PRIMARY KEY,
  tower_id    INT REFERENCES watch_towers(id) ON DELETE CASCADE,
  api_key_hash TEXT NOT NULL,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sensor_api_keys_hash_idx ON sensor_api_keys(api_key_hash);
