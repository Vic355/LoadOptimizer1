import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { MIGRATIONS, SCHEMA_SQL } from '../src/db/schema';

// Truck sizes: the logistics team gives a volume range per truck type, so a type's smaller sizes
// are the same width and height with a proportionally shorter length.
describe('truck minimum and average dimensions', () => {
  it('migration 4 -> 5 fills them from the volume range and keeps the maximum', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`CREATE TABLE truck_types (id INTEGER PRIMARY KEY, code TEXT, est_volume_min REAL, est_volume_max REAL, inner_length_cm REAL, inner_width_cm REAL, inner_height_cm REAL);
      INSERT INTO truck_types VALUES (1, 'SEMI', 40, 45, 735, 245, 250), (2, 'BSEMI55', 55, 55, 898, 245, 250), (3, 'ODOL', NULL, NULL, 500, 240, 240);`);
    db.exec(MIGRATIONS[4]);
    const rows = db.exec('SELECT code, min_length_cm, avg_length_cm, inner_length_cm, min_width_cm, avg_height_cm FROM truck_types ORDER BY id')[0].values;
    expect(rows[0]).toEqual(['SEMI', 653, 694, 735, 245, 250]);
    // A single volume, or no volume at all, leaves every size equal to the maximum.
    expect(rows[1]).toEqual(['BSEMI55', 898, 898, 898, 245, 250]);
    expect(rows[2]).toEqual(['ODOL', 500, 500, 500, 240, 240]);
  });

  it('a fresh database has the same columns', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(SCHEMA_SQL);
    const columns = db.exec('PRAGMA table_info(truck_types)')[0].values.map((v) => v[1]);
    for (const c of ['min_length_cm', 'min_width_cm', 'min_height_cm', 'avg_length_cm', 'avg_width_cm', 'avg_height_cm']) expect(columns).toContain(c);
  });
});
