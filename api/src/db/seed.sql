-- Наблюдателни кули (реални горски масиви в България)
INSERT INTO watch_towers (name, lat, lon, geom, radius_km, cover_zone) VALUES
  ('Витоша-Север',    42.650, 23.280, ST_SetSRID(ST_MakePoint(23.280, 42.650), 4326), 15,
   ST_Buffer(ST_SetSRID(ST_MakePoint(23.280, 42.650), 4326)::geography, 15000)::geometry),
  ('Рила-Самоков',    42.300, 23.550, ST_SetSRID(ST_MakePoint(23.550, 42.300), 4326), 20,
   ST_Buffer(ST_SetSRID(ST_MakePoint(23.550, 42.300), 4326)::geography, 20000)::geometry),
  ('Родопи-Пловдив',  41.900, 24.500, ST_SetSRID(ST_MakePoint(24.500, 41.900), 4326), 18,
   ST_Buffer(ST_SetSRID(ST_MakePoint(24.500, 41.900), 4326)::geography, 18000)::geometry),
  ('Странджа-Малко',  42.100, 27.500, ST_SetSRID(ST_MakePoint(27.500, 42.100), 4326), 15,
   ST_Buffer(ST_SetSRID(ST_MakePoint(27.500, 42.100), 4326)::geography, 15000)::geometry),
  ('Стара-Загора',    42.430, 25.640, ST_SetSRID(ST_MakePoint(25.640, 42.430), 4326), 12,
   ST_Buffer(ST_SetSRID(ST_MakePoint(25.640, 42.430), 4326)::geography, 12000)::geometry),
  ('Пирин-Банско',    41.830, 23.480, ST_SetSRID(ST_MakePoint(23.480, 41.830), 4326), 20,
   ST_Buffer(ST_SetSRID(ST_MakePoint(23.480, 41.830), 4326)::geography, 20000)::geometry),
  ('Шумен-Провадия',  43.200, 27.000, ST_SetSRID(ST_MakePoint(27.000, 43.200), 4326), 15,
   ST_Buffer(ST_SetSRID(ST_MakePoint(27.000, 43.200), 4326)::geography, 15000)::geometry),
  ('Врачански-Балкан',43.200, 23.600, ST_SetSRID(ST_MakePoint(23.600, 43.200), 4326), 18,
   ST_Buffer(ST_SetSRID(ST_MakePoint(23.600, 43.200), 4326)::geography, 18000)::geometry);

-- Дронове — разузнавателни (recon) и водоносни (tanker)
INSERT INTO drones (name, type, base_lat, base_lon, base_geom, capacity_l) VALUES
  ('Реконс-1', 'recon',  42.650, 23.280, ST_SetSRID(ST_MakePoint(23.280, 42.650), 4326), NULL),
  ('Реконс-2', 'recon',  41.900, 24.500, ST_SetSRID(ST_MakePoint(24.500, 41.900), 4326), NULL),
  ('Реконс-3', 'recon',  42.100, 27.500, ST_SetSRID(ST_MakePoint(27.500, 42.100), 4326), NULL),
  ('Реконс-4', 'recon',  41.830, 23.480, ST_SetSRID(ST_MakePoint(23.480, 41.830), 4326), NULL),
  ('Водоноска-1', 'tanker', 42.650, 23.280, ST_SetSRID(ST_MakePoint(23.280, 42.650), 4326), 200),
  ('Водоноска-2', 'tanker', 41.900, 24.500, ST_SetSRID(ST_MakePoint(24.500, 41.900), 4326), 200),
  ('Водоноска-3', 'tanker', 42.100, 27.500, ST_SetSRID(ST_MakePoint(27.500, 42.100), 4326), 400),
  ('Водоноска-4', 'tanker', 41.830, 23.480, ST_SetSRID(ST_MakePoint(23.480, 41.830), 4326), 200);
