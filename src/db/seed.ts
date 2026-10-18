import type { Database } from 'sql.js';
import { DEFAULT_RULES } from '../engine/rules';
import { DESTINATION_ROWS, DUMMY_SKUS, TRUCKS, vehicleCodes } from './seed-data';

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

  const insertDest = db.prepare('INSERT INTO destinations (ship_to_no, customer, city, zone, vehicle_type_raw) VALUES (?, ?, ?, ?, ?)');
  const insertLink = db.prepare('INSERT OR IGNORE INTO destination_trucks (destination_id, truck_type_id) VALUES (?, ?)');
  for (const [shipTo, customer, city, vehicle, zone] of DESTINATION_ROWS) {
    insertDest.run([shipTo, customer, city, zone, vehicle]);
    const destId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;
    for (const code of vehicleCodes(vehicle)) insertLink.run([destId, truckIds.get(code)!]);
  }
  insertDest.free();
  insertLink.free();

  const insertSku = db.prepare(
    `INSERT INTO skus (code, name, length_cm, width_cm, height_cm, mod_length_cm, mod_width_cm, mod_height_cm, weight_kg, safe_stack_layers, can_lie_down, packaging, product_group, is_dummy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const s of DUMMY_SKUS) insertSku.run([s.code, s.name, ...s.dims, ...s.mod, s.kg, s.safeLayers, s.lie ? 1 : 0, s.packaging, s.group]);
  insertSku.free();

  const insertRules = db.prepare('INSERT INTO model_settings (model, rules_json) VALUES (?, ?)');
  for (const [model, rules] of Object.entries(DEFAULT_RULES)) insertRules.run([model, JSON.stringify(rules)]);
  insertRules.free();
  db.exec('COMMIT');
}
