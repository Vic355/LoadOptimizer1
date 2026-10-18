// Seed data shared by the in-browser database and a future server database.
// Plain data only, so it can be imported on both sides.
export { DESTINATION_ROWS } from './seed-destinations';

export type BodyType = 'box' | 'wingbox' | 'open' | 'container';

// Volumes come from the logistics team. Inner dimensions keep a standard width and height and
// shorten the length to match the upper volume; all are estimates to replace with tape-measured values.
export const TRUCKS: {
  code: string;
  name: string;
  variant: string | null;
  body: BodyType;
  min: number;
  max: number;
  dims: [number, number, number];
}[] = [
  { code: 'CDE', name: 'CDE', variant: null, body: 'box', min: 2, max: 5, dims: [173, 170, 170] },
  { code: 'CDD', name: 'CDD', variant: null, body: 'box', min: 6, max: 10, dims: [263, 200, 190] },
  { code: 'ENGKEL', name: 'Engkel', variant: null, body: 'box', min: 16, max: 20, dims: [476, 200, 210] },
  { code: 'TRONTON', name: 'Tronton', variant: null, body: 'box', min: 26, max: 30, dims: [490, 245, 250] },
  { code: 'SEMI', name: 'Semitrailer', variant: null, body: 'box', min: 40, max: 45, dims: [735, 245, 250] },
  { code: 'BSEMI_Z8', name: 'Big Semitrailer', variant: 'Zone 8', body: 'box', min: 53, max: 53, dims: [865, 245, 250] },
  { code: 'BSEMI55', name: 'Big Semitrailer-55', variant: null, body: 'box', min: 55, max: 55, dims: [898, 245, 250] },
  { code: 'TBU65', name: 'Tronton Built Up-65', variant: null, body: 'box', min: 65, max: 65, dims: [1061, 245, 250] },
  { code: 'BSEMI_Z1', name: 'Big Semitrailer', variant: 'Zone 1', body: 'box', min: 70, max: 70, dims: [1143, 245, 250] },
  { code: 'TBU70', name: 'Tronton Built Up-70', variant: null, body: 'box', min: 70, max: 70, dims: [1143, 245, 250] },
  { code: 'C20', name: "Kontainer 20'", variant: null, body: 'container', min: 27, max: 30, dims: [534, 235, 239] },
  { code: 'C40', name: "Kontainer 40'", variant: null, body: 'container', min: 60, max: 67, dims: [1193, 235, 239] },
];

/** Maps the vehicle names used in the destination list to truck codes ("Split MT" is no longer used). */
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
};

export function vehicleCodes(raw: string): string[] {
  return raw
    .split('/')
    .map((part) => VEHICLE_ALIASES[part.trim().toLowerCase()])
    .filter((c): c is string => !!c);
}

export type Packaging = 'carton' | 'bundle';

// Dummy tissue SKUs until the real master data is loaded. Sizes are plausible, not real.
// Size modifiers: + for packs that bulge, - for packs that shrink.
export const DUMMY_SKUS: {
  code: string;
  name: string;
  dims: [number, number, number];
  mod: [number, number, number];
  kg: number;
  safeLayers: number;
  lie: boolean;
  packaging: Packaging;
  group: string;
}[] = [
  { code: 'DUM-001', name: 'Facial Tissue 250s isi 48', dims: [60, 40, 35], mod: [0, 0, 0], kg: 6.5, safeLayers: 6, lie: false, packaging: 'carton', group: 'Facial' },
  { code: 'DUM-002', name: 'Facial Tissue 180s isi 40', dims: [55, 38, 30], mod: [0, 0, 0], kg: 5.0, safeLayers: 7, lie: false, packaging: 'carton', group: 'Facial' },
  { code: 'DUM-003', name: 'Toilet Roll 10 roll isi 8 (bal)', dims: [50, 45, 40], mod: [1, 1, 2], kg: 4.8, safeLayers: 6, lie: true, packaging: 'bundle', group: 'Toilet' },
  { code: 'DUM-004', name: 'Kitchen Towel 2 roll isi 12', dims: [45, 30, 28], mod: [0, 0, 0], kg: 4.2, safeLayers: 7, lie: true, packaging: 'carton', group: 'Towel' },
  { code: 'DUM-005', name: 'Napkin 1/4 lipat 100s isi 60', dims: [52, 36, 26], mod: [0, 0, 0], kg: 7.8, safeLayers: 6, lie: false, packaging: 'carton', group: 'Napkin' },
  { code: 'DUM-006', name: 'Pocket Tissue 10s isi 120', dims: [40, 30, 25], mod: [0, 0, 0], kg: 3.6, safeLayers: 8, lie: true, packaging: 'carton', group: 'Facial' },
  { code: 'DUM-007', name: 'Jumbo Roll Tissue isi 12', dims: [58, 39, 30], mod: [0, 0, 0], kg: 9.0, safeLayers: 5, lie: false, packaging: 'carton', group: 'Away From Home' },
  { code: 'DUM-008', name: 'Hand Towel M-fold isi 20', dims: [42, 34, 28], mod: [0, 0, 0], kg: 8.0, safeLayers: 6, lie: false, packaging: 'carton', group: 'Away From Home' },
  { code: 'DUM-009', name: 'Toilet Roll 4 roll isi 12 (bal)', dims: [62, 42, 48], mod: [0, 0, -1], kg: 5.5, safeLayers: 5, lie: true, packaging: 'bundle', group: 'Toilet' },
  { code: 'DUM-010', name: 'Facial Tissue Travel 50s isi 96', dims: [48, 32, 30], mod: [0, 0, 0], kg: 4.4, safeLayers: 7, lie: false, packaging: 'carton', group: 'Facial' },
  { code: 'DUM-011', name: 'Wet Tissue 50s isi 24', dims: [44, 32, 27], mod: [0, 0, 0], kg: 9.5, safeLayers: 5, lie: false, packaging: 'carton', group: 'Wet Tissue' },
  { code: 'DUM-012', name: 'Interfold Towel 150s isi 30', dims: [48, 40, 30], mod: [0, 0, 0], kg: 8.6, safeLayers: 6, lie: false, packaging: 'carton', group: 'Away From Home' },
];
