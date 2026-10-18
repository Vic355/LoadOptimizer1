// SQLite schema. Kept as plain SQL so the same tables can move to Cloudflare D1
// or an intranet SQL server later. Lengths in cm, weights in kg, volumes in m³.

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS truck_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  est_volume_min REAL,
  est_volume_max REAL,
  inner_length_cm REAL,
  inner_width_cm REAL,
  inner_height_cm REAL,
  max_payload_kg REAL,
  dims_estimated INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_to_no TEXT,
  customer TEXT NOT NULL,
  city TEXT NOT NULL,
  zone TEXT,
  vehicle_type_raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_destinations_ship_to ON destinations(ship_to_no);

-- Vehicles allowed at a destination (a destination may accept several, e.g. "Tronton Built Up-70 / Semitrailer").
CREATE TABLE IF NOT EXISTS destination_trucks (
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  truck_type_id INTEGER NOT NULL REFERENCES truck_types(id) ON DELETE CASCADE,
  PRIMARY KEY (destination_id, truck_type_id)
);

CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  length_cm REAL NOT NULL,
  width_cm REAL NOT NULL,
  height_cm REAL NOT NULL,
  weight_kg REAL,
  safe_stack_height_cm REAL NOT NULL,
  can_lie_down INTEGER NOT NULL DEFAULT 0,
  packaging TEXT NOT NULL DEFAULT 'carton' CHECK (packaging IN ('carton', 'bale')),
  volume_m3 REAL GENERATED ALWAYS AS (length_cm * width_cm * height_cm / 1000000.0) VIRTUAL,
  is_dummy INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  so_number TEXT,
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS shipment_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  qty INTEGER,
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS load_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (model IN ('free', 'standard', 'mixed')),
  total_cartons INTEGER NOT NULL,
  tier_count INTEGER NOT NULL,
  volume_utilization REAL NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;
