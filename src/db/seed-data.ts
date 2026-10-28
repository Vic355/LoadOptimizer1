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
