import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { MIGRATIONS } from '../src/db/schema';

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
