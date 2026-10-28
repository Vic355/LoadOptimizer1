// SQLite schema. Kept as plain SQL so the same tables can move to Cloudflare D1
// or another SQL server later. Lengths in cm, weights in kg, volumes in m³.
import { skuFromSap } from './material';
import { SAP_SKU_ROWS } from './seed-skus';

export const SCHEMA_VERSION = 6;

/**
 * Splits every truck type that has a volume range (the logistics team's "min - max") into three
 * entries: Minimum and Rata-rata (average) are added, and the existing row becomes the Maksimum.
 * Width and height stay and the length scales with the volume, so the new dimensions are estimates.
 * Types with a single volume, and one-off trucks, are left alone.
 */
export const SPLIT_TRUCK_SIZES = `
  INSERT INTO truck_types (code, name, variant, body_type, est_volume_min, est_volume_max, inner_length_cm, inner_width_cm, inner_height_cm, dims_estimated, is_template, notes)
    SELECT code || '_MIN', name, 'Minimum', body_type, est_volume_min, est_volume_min, ROUND(inner_length_cm * est_volume_min / est_volume_max), inner_width_cm, inner_height_cm, dims_estimated, 0, notes
    FROM truck_types WHERE is_template = 0 AND variant IS NULL AND est_volume_min > 0 AND est_volume_max > est_volume_min;
  INSERT INTO truck_types (code, name, variant, body_type, est_volume_min, est_volume_max, inner_length_cm, inner_width_cm, inner_height_cm, dims_estimated, is_template, notes)
    SELECT code || '_AVG', name, 'Rata-rata', body_type, (est_volume_min + est_volume_max) / 2, (est_volume_min + est_volume_max) / 2, ROUND(inner_length_cm * (est_volume_min + est_volume_max) / 2 / est_volume_max), inner_width_cm, inner_height_cm, dims_estimated, 0, notes
    FROM truck_types WHERE is_template = 0 AND variant IS NULL AND est_volume_min > 0 AND est_volume_max > est_volume_min;
  UPDATE truck_types SET variant = 'Maksimum', est_volume_min = est_volume_max
    WHERE is_template = 0 AND variant IS NULL AND est_volume_min > 0 AND est_volume_max > est_volume_min;
`;

const sqlText = (v: string | number | null) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

/** The SKU columns written from SAP data, in insert order. */
const SAP_COLUMNS = [
  'code', 'name', 'length_cm', 'width_cm', 'height_cm', 'safe_stack_layers', 'can_lie_down', 'packaging', 'product_group', 'active', 'is_dummy', 'cbox_code', 'board_grade', 'material_desc',
] as const;

/** One INSERT for the SAP SKU list; SKUs already in the database are updated and keep their other fields. */
export function sapSkuInsert(): string {
  const rows = SAP_SKU_ROWS.map((r) => skuFromSap(...r)).filter((r): r is NonNullable<typeof r> => !!r);
  const values = rows.map((r) => `(${SAP_COLUMNS.map((c) => sqlText(r[c])).join(', ')})`).join(',\n    ');
  const update = SAP_COLUMNS.filter((c) => c !== 'code' && c !== 'safe_stack_layers').map((c) => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO skus (${SAP_COLUMNS.join(', ')}) VALUES\n    ${values}\n  ON CONFLICT(code) DO UPDATE SET ${update}`;
}

/**
 * Schema 5 -> 6. No table is rebuilt: D1 keeps ON DELETE CASCADE active during migrations, so
 * dropping shipments would delete every saved plan. Columns are added instead.
 * Each saved shipment gets a number: its reference when that is unique, otherwise TMP-<id> as a
 * draft. Its truck moves to the plan (truck 1). Bebas now builds tiers. The dummy SKUs make way
 * for the SAP list (saved plans keep their own copy of each SKU).
 */
const SHIPMENTS_AND_SKUS = `
  ALTER TABLE skus ADD COLUMN cbox_code TEXT;
  ALTER TABLE skus ADD COLUMN board_grade TEXT;
  ALTER TABLE skus ADD COLUMN material_desc TEXT;
  CREATE TABLE IF NOT EXISTS trucks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plate_no TEXT NOT NULL UNIQUE,
    truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL,
    inner_length_cm REAL,
    inner_width_cm REAL,
    inner_height_cm REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT
  );
  ALTER TABLE shipments ADD COLUMN shipment_no TEXT;
  ALTER TABLE shipments ADD COLUMN is_temp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE shipments ADD COLUMN updated_at TEXT;
  UPDATE shipments SET
    shipment_no = CASE WHEN TRIM(COALESCE(reference, '')) <> '' AND (SELECT COUNT(*) FROM shipments o WHERE TRIM(o.reference) = TRIM(shipments.reference)) = 1 THEN TRIM(reference) ELSE 'TMP-' || id END,
    is_temp = CASE WHEN TRIM(COALESCE(reference, '')) <> '' AND (SELECT COUNT(*) FROM shipments o WHERE TRIM(o.reference) = TRIM(shipments.reference)) = 1 THEN 0 ELSE 1 END,
    updated_at = created_at;
  CREATE UNIQUE INDEX IF NOT EXISTS shipments_no ON shipments (shipment_no);
  ALTER TABLE load_plans ADD COLUMN truck_seq INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE load_plans ADD COLUMN truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL;
  ALTER TABLE load_plans ADD COLUMN plate_no TEXT REFERENCES trucks(plate_no) ON UPDATE CASCADE ON DELETE SET NULL;
  ALTER TABLE load_plans ADD COLUMN truck_json TEXT;
  UPDATE load_plans SET
    truck_type_id = (SELECT s.truck_type_id FROM shipments s WHERE s.id = load_plans.shipment_id),
    truck_json = (SELECT s.truck_json FROM shipments s WHERE s.id = load_plans.shipment_id);
  UPDATE model_settings SET rules_json = json_set(rules_json, '$.tiers', json('true')) WHERE model = 'free';
  DELETE FROM skus WHERE is_dummy = 1;
  ${sapSkuInsert()};
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
  is_dummy INTEGER NOT NULL DEFAULT 0,
  -- From SAP: carton number, board grade (K liner / M medium, g/m²) and the material description as supplied.
  cbox_code TEXT,
  board_grade TEXT,
  material_desc TEXT
);

-- Real vehicles by plate number (nomor polisi), with the inner size last used or measured, so
-- every plan for the same truck starts from the same dimensions.
CREATE TABLE IF NOT EXISTS trucks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_no TEXT NOT NULL UNIQUE,
  truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL,
  inner_length_cm REAL,
  inner_width_cm REAL,
  inner_height_cm REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT
);

-- A shipment is one sales order (shipment_no, e.g. the SO number) and may need several trucks;
-- each truck's plan is a row in load_plans. Drafts saved without a number get a temporary one
-- (is_temp = 1). reference is the planner's note. truck_type_id and truck_json are from before
-- schema 6, when a shipment had one truck: SQLite cannot drop them, so new rows write '{}'.
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT,
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL,
  truck_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  shipment_no TEXT,
  is_temp INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS shipments_no ON shipments (shipment_no);

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

-- One row per truck of a shipment (truck_seq 1, 2, ...). truck_json keeps the dimensions used, so
-- plans stay reproducible; plate_no links the plan to the vehicle register.
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  truck_seq INTEGER NOT NULL DEFAULT 1,
  truck_type_id INTEGER REFERENCES truck_types(id) ON DELETE SET NULL,
  plate_no TEXT REFERENCES trucks(plate_no) ON UPDATE CASCADE ON DELETE SET NULL,
  truck_json TEXT
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
  // 4 -> 5: truck types with a volume range become separate Minimum, Rata-rata and Maksimum entries.
  4: SPLIT_TRUCK_SIZES,
  // 5 -> 6: shipment numbers, several trucks per shipment, the vehicle register, Bebas in tiers, real SKUs.
  5: SHIPMENTS_AND_SKUS,
};
