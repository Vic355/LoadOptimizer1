import type { Database } from 'sql.js';
import { DESTINATION_ROWS } from './seed-destinations';

// Cubic-volume ranges come from the logistics team. Inner dimensions are estimates chosen to
// match the upper volume (except ISO containers, which use standard inner dimensions) and
// must be replaced with tape-measured values.
const TRUCKS: {
  code: string;
  name: string;
  min: number | null;
  max: number | null;
  dims: [number, number, number] | null;
  estimated: boolean;
  notes: string;
}[] = [
  { code: 'CDE', name: 'CDE', min: 2, max: 5, dims: [260, 160, 120], estimated: true, notes: '' },
  { code: 'CDD', name: 'CDD', min: 6, max: 10, dims: [420, 190, 125], estimated: true, notes: '' },
  { code: 'ENGKEL', name: 'Engkel', min: 16, max: 20, dims: [500, 200, 200], estimated: true, notes: '' },
  { code: 'TRONTON', name: 'Tronton', min: 26, max: 30, dims: [750, 240, 165], estimated: true, notes: '' },
  { code: 'SEMI', name: 'Semitrailer', min: 40, max: 45, dims: [940, 240, 200], estimated: true, notes: '' },
  { code: 'BSEMI_Z8', name: 'Big Semitrailer Zone 8', min: 53, max: 53, dims: [1200, 240, 185], estimated: true, notes: 'Juga dipakai untuk "Big Semitrailer-53".' },
  { code: 'BSEMI_Z1', name: 'Big Semitrailer Zone 1', min: 70, max: 70, dims: [1360, 245, 210], estimated: true, notes: '' },
  { code: 'BSEMI55', name: 'Big Semitrailer-55', min: 55, max: 55, dims: [1200, 240, 190], estimated: true, notes: 'Dari daftar tujuan Zone 07.' },
  { code: 'TBU65', name: 'Tronton Built Up-65', min: 65, max: 65, dims: [1150, 245, 230], estimated: true, notes: 'Dari daftar tujuan Zone 07.' },
  { code: 'TBU70', name: 'Tronton Built Up-70', min: 70, max: 70, dims: [1360, 245, 210], estimated: true, notes: 'Dari daftar tujuan; mungkin sama dengan Big Semitrailer Zone 1.' },
  { code: 'C20', name: "Kontainer 20'", min: 27, max: 30, dims: [589, 235, 239], estimated: false, notes: 'Dimensi dalam standar ISO.' },
  { code: 'C40', name: "Kontainer 40'", min: 60, max: 67, dims: [1203, 235, 239], estimated: false, notes: 'Dimensi dalam standar ISO.' },
  { code: 'SPLITMT', name: 'Split MT', min: null, max: null, dims: null, estimated: true, notes: 'Belum ada data kubikasi maupun dimensi.' },
];

/** Maps the vehicle names used in the destination list to truck codes. */
const VEHICLE_ALIASES: Record<string, string> = {
  semitrailer: 'SEMI',
  engkel: 'ENGKEL',
  tronton: 'TRONTON',
  cdd: 'CDD',
  cde: 'CDE',
  "20'": 'C20',
  "40'": 'C40',
  'tronton built up-70': 'TBU70',
  'tronton built up-65': 'TBU65',
  'big semitrailer-55': 'BSEMI55',
  'big semitrailer-53': 'BSEMI_Z8',
  'split mt': 'SPLITMT',
};

export function vehicleCodes(raw: string): string[] {
  return raw
    .split('/')
    .map((part) => VEHICLE_ALIASES[part.trim().toLowerCase()])
    .filter((c): c is string => !!c);
}

// Dummy tissue SKUs until the real master data is loaded. Sizes are plausible, not real.
const DUMMY_SKUS: [code: string, name: string, l: number, w: number, h: number, kg: number, safe: number, lie: boolean, packaging: 'carton' | 'bale'][] = [
  ['DUM-001', 'Facial Tissue 250s isi 48', 60, 40, 35, 6.5, 210, false, 'carton'],
  ['DUM-002', 'Facial Tissue 180s isi 40', 55, 38, 30, 5.0, 210, false, 'carton'],
  ['DUM-003', 'Toilet Roll 10 roll isi 8 (bal)', 50, 45, 40, 4.8, 240, true, 'bale'],
  ['DUM-004', 'Kitchen Towel 2 roll isi 12', 45, 30, 28, 4.2, 200, true, 'carton'],
  ['DUM-005', 'Napkin 1/4 lipat 100s isi 60', 52, 36, 26, 7.8, 180, false, 'carton'],
  ['DUM-006', 'Pocket Tissue 10s isi 120', 40, 30, 25, 3.6, 200, true, 'carton'],
  ['DUM-007', 'Jumbo Roll Tissue isi 12', 58, 39, 30, 9.0, 160, false, 'carton'],
  ['DUM-008', 'Hand Towel M-fold isi 20', 42, 34, 28, 8.0, 180, false, 'carton'],
  ['DUM-009', 'Toilet Roll 4 roll isi 12 (bal)', 62, 42, 48, 5.5, 240, true, 'bale'],
  ['DUM-010', 'Facial Tissue Travel 50s isi 96', 48, 32, 30, 4.4, 210, false, 'carton'],
  ['DUM-011', 'Wet Tissue 50s isi 24', 44, 32, 27, 9.5, 150, false, 'carton'],
  ['DUM-012', 'Interfold Towel 150s isi 30', 48, 40, 30, 8.6, 180, false, 'carton'],
];

export function seedDatabase(db: Database): void {
  db.exec('BEGIN');
  const truckIds = new Map<string, number>();
  const insertTruck = db.prepare(
    `INSERT INTO truck_types (code, name, est_volume_min, est_volume_max, inner_length_cm, inner_width_cm, inner_height_cm, dims_estimated, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of TRUCKS) {
    insertTruck.run([t.code, t.name, t.min, t.max, t.dims?.[0] ?? null, t.dims?.[1] ?? null, t.dims?.[2] ?? null, t.estimated ? 1 : 0, t.notes || null]);
    truckIds.set(t.code, db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number);
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
    `INSERT INTO skus (code, name, length_cm, width_cm, height_cm, weight_kg, safe_stack_height_cm, can_lie_down, packaging, is_dummy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (const [code, name, l, w, h, kg, safe, lie, packaging] of DUMMY_SKUS) insertSku.run([code, name, l, w, h, kg, safe, lie ? 1 : 0, packaging]);
  insertSku.free();
  db.exec('COMMIT');
}
