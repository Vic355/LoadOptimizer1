// SQLite schema. Kept as plain SQL so the same tables can move to Cloudflare D1
// or another SQL server later. Lengths in cm, weights in kg, volumes in m³.

export const SCHEMA_VERSION = 5;

/**
 * Fills the minimum and average inner dimensions of trucks that have none. The inner dimensions are
 * the maximum; the length scales with the logistics team's volume range and width and height stay.
 */
export const BACKFILL_TRUCK_DIMS = `
  UPDATE truck_types SET
    min_length_cm = CASE WHEN est_volume_min > 0 AND est_volume_max > 0 THEN ROUND(inner_length_cm * est_volume_min / est_volume_max) ELSE inner_length_cm END,
    avg_length_cm = CASE WHEN est_volume_min > 0 AND est_volume_max > 0 THEN ROUND(inner_length_cm * (est_volume_min + est_volume_max) / 2 / est_volume_max) ELSE inner_length_cm END,
    min_width_cm = inner_width_cm, avg_width_cm = inner_width_cm,
    min_height_cm = inner_height_cm, avg_height_cm = inner_height_cm
  WHERE min_length_cm IS NULL AND avg_length_cm IS NULL;
`;

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
  -- inner_* is the maximum size; the minimum and average sizes are what a smaller truck of this type offers.
  min_length_cm REAL,
  min_width_cm REAL,
  min_height_cm REAL,
  avg_length_cm REAL,
  avg_width_cm REAL,
  avg_height_cm REAL,
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
-- outcome_json records how the load went (fields: PlanOutcome in db/repo.ts); it is kept as JSON so fields can change.
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
  outcome_json TEXT,
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
  // 3 -> 4: saved plans can record how the load went.
  3: `ALTER TABLE load_plans ADD COLUMN outcome_json TEXT;`,
  // 4 -> 5: trucks get minimum and average inner dimensions next to the maximum.
  4: `
    ALTER TABLE truck_types ADD COLUMN min_length_cm REAL;
    ALTER TABLE truck_types ADD COLUMN min_width_cm REAL;
    ALTER TABLE truck_types ADD COLUMN min_height_cm REAL;
    ALTER TABLE truck_types ADD COLUMN avg_length_cm REAL;
    ALTER TABLE truck_types ADD COLUMN avg_width_cm REAL;
    ALTER TABLE truck_types ADD COLUMN avg_height_cm REAL;
    ${BACKFILL_TRUCK_DIMS}
  `,
};
