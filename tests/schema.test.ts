import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import v5Sql from './fixtures/schema-v5.sql?raw';
import { MIGRATIONS, SCHEMA_SQL } from '../src/db/schema';
import { TABLES, splitSql } from '../src/db/snapshot';

// A truck type with a volume range ("CDE 2 - 5") becomes three entries: Minimum, Rata-rata, Maksimum.
describe('truck entries per size', () => {
  it('migration 4 -> 5 adds the minimum and average entries and keeps the maximum row', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`CREATE TABLE truck_types (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, variant TEXT, body_type TEXT, est_volume_min REAL, est_volume_max REAL,
      inner_length_cm REAL, inner_width_cm REAL, inner_height_cm REAL, dims_estimated INTEGER, is_template INTEGER, notes TEXT);
      INSERT INTO truck_types (code, name, variant, body_type, est_volume_min, est_volume_max, inner_length_cm, inner_width_cm, inner_height_cm, dims_estimated, is_template) VALUES
        ('SEMI', 'Semitrailer', NULL, 'box', 40, 45, 735, 245, 250, 1, 0),
        ('BSEMI55', 'Big Semitrailer-55', NULL, 'box', 55, 55, 898, 245, 250, 1, 0),
        ('BSEMI_Z8', 'Big Semitrailer', 'Zone 8', 'box', 53, 53, 865, 245, 250, 1, 0),
        ('ODOL', 'Truk khusus', NULL, 'box', NULL, NULL, 500, 240, 240, 0, 1);`);
    db.exec(MIGRATIONS[4]);
    const rows = db.exec('SELECT code, variant, est_volume_min, est_volume_max, inner_length_cm, inner_width_cm, inner_height_cm FROM truck_types ORDER BY est_volume_max, code')[0].values;
    const by = Object.fromEntries(rows.map((r) => [r[0] as string, r]));
    // Minimum and average: single volumes, width and height unchanged, length scaled to the volume.
    expect(by.SEMI_MIN).toEqual(['SEMI_MIN', 'Minimum', 40, 40, 653, 245, 250]);
    expect(by.SEMI_AVG).toEqual(['SEMI_AVG', 'Rata-rata', 42.5, 42.5, 694, 245, 250]);
    // The existing row is now the maximum and keeps its code and dimensions.
    expect(by.SEMI).toEqual(['SEMI', 'Maksimum', 45, 45, 735, 245, 250]);
    // Single-volume types and one-off trucks get no extra entries.
    expect(Object.keys(by).sort()).toEqual(['BSEMI55', 'BSEMI_Z8', 'ODOL', 'SEMI', 'SEMI_AVG', 'SEMI_MIN']);
    expect(by.BSEMI55[1]).toBeNull();
  });
});

// Schema 5 -> 6: shipment numbers, trucks per plan, the vehicle register, Bebas in tiers, SAP SKUs.
describe('shipments and SAP SKUs (schema 6)', () => {
  const v5 = v5Sql;

  async function oldDatabase() {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(v5);
    db.exec(`INSERT INTO truck_types (id, code, name, inner_length_cm, inner_width_cm, inner_height_cm) VALUES (11, 'C20', 'Kontainer 20''', 534, 235, 239);
      INSERT INTO skus (code, name, length_cm, width_cm, height_cm, safe_stack_layers, is_dummy) VALUES ('DUM-001', 'Dummy', 60, 40, 35, 6, 1);
      INSERT INTO skus (code, name, length_cm, width_cm, height_cm, safe_stack_layers, is_dummy) VALUES ('69921603', 'Old name', 30, 20, 10, 3, 0);
      INSERT INTO model_settings (model, rules_json) VALUES ('free', '{"tiers":false,"searchSeconds":3}'), ('standard', '{"tiers":true}');
      INSERT INTO shipments (id, reference, truck_type_id, truck_json) VALUES
        (1, NULL, 11, '{"name":"Kontainer 20''","length":534,"width":235,"height":239}'),
        (2, ' SO-77 ', 11, '{"name":"A","length":1,"width":1,"height":1}'),
        (3, 'X', NULL, '{"name":"B","length":2,"width":2,"height":2}'),
        (4, 'X', NULL, '{"name":"C","length":3,"width":3,"height":3}');
      INSERT INTO load_plans (shipment_id, model, rules_json, total_cartons, tier_count, volume_utilization, result_json) VALUES
        (1, 'free', '{}', 10, 2, 0.5, '{}'), (2, 'standard', '{}', 5, 1, 0.2, '{}');`);
    return db;
  }

  it('numbers old shipments, moves their truck to the plan and keeps every plan', async () => {
    const db = await oldDatabase();
    db.exec('PRAGMA foreign_keys = ON');
    for (const st of splitSql(MIGRATIONS[5])) db.run(st);
    const shipments = db.exec('SELECT id, shipment_no, is_temp FROM shipments ORDER BY id')[0].values;
    // A unique reference becomes the number; no reference or a repeated one gives a draft number.
    expect(shipments).toEqual([
      [1, 'TMP-1', 1],
      [2, 'SO-77', 0],
      [3, 'TMP-3', 1],
      [4, 'TMP-4', 1],
    ]);
    const plans = db.exec('SELECT shipment_id, truck_seq, truck_type_id, truck_json, plate_no FROM load_plans ORDER BY id')[0].values;
    expect(plans[0]).toEqual([1, 1, 11, '{"name":"Kontainer 20\'","length":534,"width":235,"height":239}', null]);
    expect(plans).toHaveLength(2);
    expect(JSON.parse(db.exec("SELECT rules_json FROM model_settings WHERE model = 'free'")[0].values[0][0] as string)).toEqual({ tiers: true, searchSeconds: 3 });
    // Dummy SKUs make way for the SAP list; a SKU already there is updated but keeps its stack limit.
    expect(db.exec('SELECT COUNT(*) FROM skus WHERE is_dummy = 1')[0].values[0][0]).toBe(0);
    expect(db.exec('SELECT COUNT(*) FROM skus')[0].values[0][0]).toBe(281);
    expect(db.exec("SELECT name, length_cm, width_cm, height_cm, safe_stack_layers, cbox_code, board_grade FROM skus WHERE code = '69921603'")[0].values[0]).toEqual([
      "Paseo Baby Puresoft Softpack 100s' x 3ply", 35.5, 21.5, 17.5, 3, '21170241', 'K150/M150',
    ]);
    // Shipment numbers are unique, and a plan's plate number must be in the vehicle register.
    expect(() => db.run("UPDATE shipments SET shipment_no = 'SO-77' WHERE id = 1")).toThrow();
    expect(() => db.run("UPDATE load_plans SET plate_no = 'B 1 XX' WHERE id = 1")).toThrow();
    db.run("INSERT INTO trucks (plate_no, truck_type_id) VALUES ('B 1 XX', 11)");
    db.run("UPDATE load_plans SET plate_no = 'B 1 XX' WHERE id = 1");
    db.run("UPDATE trucks SET plate_no = 'B 1 XY'");
    expect(db.exec('SELECT plate_no FROM load_plans WHERE id = 1')[0].values[0][0]).toBe('B 1 XY');
  });

  it('migration statements fit D1 limits and the new schema has the same columns as a migrated one', async () => {
    const statements = splitSql(MIGRATIONS[5]);
    for (const st of statements) expect(new TextEncoder().encode(st).length).toBeLessThan(100_000);
    // With the snapshot reads after it, one visit stays within the 50 queries a free Worker may run.
    expect(statements.length).toBeLessThan(25);
    const migrated = await oldDatabase();
    for (const st of statements) migrated.run(st);
    const SQL = await initSqlJs();
    const fresh = new SQL.Database();
    fresh.exec(SCHEMA_SQL);
    const columns = (db: typeof fresh, table: string) => db.exec(`SELECT name FROM pragma_table_xinfo('${table}') ORDER BY name`)[0].values.flat();
    for (const table of TABLES) expect(columns(fresh, table), table).toEqual(columns(migrated, table));
  });
});
