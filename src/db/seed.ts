import type { Database } from 'sql.js';
import { DEFAULT_RULES } from '../engine/rules';
import { SPLIT_TRUCK_SIZES, sapSkuInsert } from './schema';
import { DESTINATION_ROWS, TRUCKS, vehicleCodes } from './seed-data';

export function seedDatabase(db: Database): void {
  db.exec('BEGIN');
  const truckIds = new Map<string, number>();
  const insertTruck = db.prepare(
    `INSERT INTO truck_types (code, name, variant, body_type, est_volume_min, est_volume_max, inner_length_cm, inner_width_cm, inner_height_cm, dims_estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const tr of TRUCKS) {
    insertTruck.run([tr.code, tr.name, tr.variant, tr.body, tr.min, tr.max, ...tr.dims]);
    truckIds.set(tr.code, db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number);
  }
  insertTruck.free();
  // The destination list refers to the largest size of each type; add the smaller ones.
  db.exec(SPLIT_TRUCK_SIZES);

  const insertDest = db.prepare('INSERT INTO destinations (ship_to_no, customer, city, zone, vehicle_type_raw) VALUES (?, ?, ?, ?, ?)');
  const insertLink = db.prepare('INSERT OR IGNORE INTO destination_trucks (destination_id, truck_type_id) VALUES (?, ?)');
  for (const [shipTo, customer, city, vehicle, zone] of DESTINATION_ROWS) {
    insertDest.run([shipTo, customer, city, zone, vehicle]);
    const destId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
    for (const code of vehicleCodes(vehicle)) insertLink.run([destId, truckIds.get(code)!]);
  }
  insertDest.free();
  insertLink.free();

  // SKUs from the SAP list (data/skus.tsv).
  db.exec(sapSkuInsert());

  const insertRules = db.prepare('INSERT INTO model_settings (model, rules_json) VALUES (?, ?)');
  for (const [model, rules] of Object.entries(DEFAULT_RULES)) insertRules.run([model, JSON.stringify(rules)]);
  insertRules.free();
  db.exec('COMMIT');
}
