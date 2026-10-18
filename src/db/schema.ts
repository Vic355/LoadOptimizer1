// SQLite schema. Kept as plain SQL so the same tables can move to Cloudflare D1
// or another SQL server later. Lengths in cm, weights in kg, volumes in m³.

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS truck_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  variant TEXT,
  body_type TEXT NOT NULL DEFAULT 'box' CHECK (body_type IN ('box', 'wingbox', 'open', 'container')),
  est_volume_min REAL,
  est_volume_max REAL,
  inner_length_cm REAL,
  inner_width_cm REAL,
  inner_height_cm REAL,
  dims_estimated INTEGER NOT NULL DEFAULT 1,
  -- One-off trucks (ODOL or modified) saved from the input screen.
  is_template INTEGER NOT NULL DEFAULT 0,
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

-- Vehicles listed for a destination. The largest is the maximum; smaller trucks are always allowed.
CREATE TABLE IF NOT EXISTS destination_trucks (
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  truck_type_id INTEGER NOT NULL REFERENCES truck_types(id) ON DELETE CASCADE,
  PRIMARY KEY (destination_id, truck_type_id)
);

-- code is the SAP material number. mod_* adjust each side for bulging (+) or shrinking (-) packs.
CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  length_cm REAL NOT NULL,
  width_cm REAL NOT NULL,
  height_cm REAL NOT NULL,
  mod_length_cm REAL NOT NULL DEFAULT 0,
  mod_width_cm REAL NOT NULL DEFAULT 0,
  mod_height_cm REAL NOT NULL DEFAULT 0,
  weight_kg REAL,
  safe_stack_layers INTEGER NOT NULL,
  max_top_load_kg REAL,
  can_lie_down INTEGER NOT NULL DEFAULT 0,
  packaging TEXT NOT NULL DEFAULT 'carton' CHECK (packaging IN ('carton', 'bundle')),
  product_group TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  volume_m3 REAL GENERATED ALWAYS AS ((length_cm + mod_length_cm) * (width_cm + mod_width_cm) * (height_cm + mod_height_cm) / 1000000.0) VIRTUAL,
  is_dummy INTEGER NOT NULL DEFAULT 0
);

-- truck_json keeps the dimensions used, so plans for one-off trucks stay reproducible.
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT,
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL,
  truck_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- sku_json is the SKU as planned (personal SKUs and edits never reach the skus table), so
-- sku_id is only a link back to master data and may point to a personal SKU (negative id).
CREATE TABLE IF NOT EXISTS shipment_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL,
  sku_json TEXT,
  qty INTEGER,
  position INTEGER NOT NULL
);

-- actual_json maps a tier number to the count the checker wrote on the loader sheet.
CREATE TABLE IF NOT EXISTS load_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (model IN ('free', 'standard', 'mixed')),
  rules_json TEXT NOT NULL,
  total_cartons INTEGER NOT NULL,
  tier_count INTEGER NOT NULL,
  volume_utilization REAL NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final', 'loaded')),
  planner_note TEXT,
  actual_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Optimizer rules per model, edited on the Model rules page (fields: engine/rules.ts).
CREATE TABLE IF NOT EXISTS model_settings (
  model TEXT PRIMARY KEY CHECK (model IN ('free', 'standard', 'mixed')),
  rules_json TEXT NOT NULL
);
`;

/** Upgrades a stored database one version at a time, keeping its data. */
export const MIGRATIONS: Record<number, string> = {
  // 2 -> 3: shipment lines keep a snapshot of the SKU and may refer to personal SKUs.
  2: `
    CREATE TABLE shipment_lines_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      sku_id INTEGER NOT NULL,
      sku_json TEXT,
      qty INTEGER,
      position INTEGER NOT NULL
    );
    INSERT INTO shipment_lines_v3 (id, shipment_id, sku_id, qty, position) SELECT id, shipment_id, sku_id, qty, position FROM shipment_lines;
    DROP TABLE shipment_lines;
    ALTER TABLE shipment_lines_v3 RENAME TO shipment_lines;
  `,
};
