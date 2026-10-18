import type { SqlValue } from 'sql.js';
import { execute, query } from './database';
import type { EngineSku, EngineTruck, PlanResult } from '../engine';

export interface TruckType {
  id: number;
  code: string;
  name: string;
  est_volume_min: number | null;
  est_volume_max: number | null;
  inner_length_cm: number | null;
  inner_width_cm: number | null;
  inner_height_cm: number | null;
  max_payload_kg: number | null;
  dims_estimated: number;
  notes: string | null;
}

export interface Destination {
  id: number;
  ship_to_no: string | null;
  customer: string;
  city: string;
  zone: string | null;
  vehicle_type_raw: string | null;
}

export interface Sku {
  id: number;
  code: string;
  name: string;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  weight_kg: number | null;
  safe_stack_height_cm: number;
  can_lie_down: number;
  packaging: 'carton' | 'bale';
  volume_m3: number;
  is_dummy: number;
}

export interface SavedPlan {
  id: number;
  shipment_id: number;
  so_number: string | null;
  customer: string | null;
  city: string | null;
  truck_name: string | null;
  model: string;
  total_cartons: number;
  tier_count: number;
  volume_utilization: number;
  created_at: string;
}

// ---- Trucks ----

export const listTrucks = () => query<TruckType>('SELECT * FROM truck_types ORDER BY COALESCE(est_volume_max, 0), name');

export function truckHasDims(t: TruckType): boolean {
  return !!(t.inner_length_cm && t.inner_width_cm && t.inner_height_cm);
}

export function toEngineTruck(t: TruckType): EngineTruck {
  return { length: t.inner_length_cm ?? 0, width: t.inner_width_cm ?? 0, height: t.inner_height_cm ?? 0 };
}

export function truckVolume(t: TruckType): number | null {
  return truckHasDims(t) ? (t.inner_length_cm! * t.inner_width_cm! * t.inner_height_cm!) / 1e6 : null;
}

export function saveTruck(t: Omit<TruckType, 'id'> & { id?: number }): number {
  const values: SqlValue[] = [t.code, t.name, t.est_volume_min, t.est_volume_max, t.inner_length_cm, t.inner_width_cm, t.inner_height_cm, t.max_payload_kg, t.dims_estimated, t.notes];
  if (t.id) {
    execute(
      `UPDATE truck_types SET code=?, name=?, est_volume_min=?, est_volume_max=?, inner_length_cm=?, inner_width_cm=?, inner_height_cm=?, max_payload_kg=?, dims_estimated=?, notes=? WHERE id=?`,
      [...values, t.id],
    );
    return t.id;
  }
  return execute(
    `INSERT INTO truck_types (code, name, est_volume_min, est_volume_max, inner_length_cm, inner_width_cm, inner_height_cm, max_payload_kg, dims_estimated, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    values,
  );
}

export const deleteTruck = (id: number) => execute('DELETE FROM truck_types WHERE id = ?', [id]);

// ---- Destinations ----

export function searchDestinations(text: string, limit = 12): Destination[] {
  const q = `%${text.trim()}%`;
  return query<Destination>(
    `SELECT * FROM destinations
     WHERE ship_to_no LIKE ? OR customer LIKE ? OR city LIKE ? OR zone LIKE ?
     ORDER BY customer, city LIMIT ?`,
    [q, q, q, q, limit],
  );
}

export const listDestinations = () => query<Destination>('SELECT * FROM destinations ORDER BY zone, customer, city');

export const allowedTrucks = (destinationId: number) =>
  query<TruckType>(
    `SELECT t.* FROM truck_types t JOIN destination_trucks dt ON dt.truck_type_id = t.id
     WHERE dt.destination_id = ? ORDER BY COALESCE(t.est_volume_max, 0) DESC`,
    [destinationId],
  );

/** The largest vehicle the destination accepts (the first of `allowedTrucks`). */
export const maxTruckFor = (destinationId: number): TruckType | null => allowedTrucks(destinationId)[0] ?? null;

export function saveDestination(d: Omit<Destination, 'id'> & { id?: number }, truckIds: number[]): number {
  const values: SqlValue[] = [d.ship_to_no, d.customer, d.city, d.zone, d.vehicle_type_raw];
  let id = d.id;
  if (id) execute('UPDATE destinations SET ship_to_no=?, customer=?, city=?, zone=?, vehicle_type_raw=? WHERE id=?', [...values, id]);
  else id = execute('INSERT INTO destinations (ship_to_no, customer, city, zone, vehicle_type_raw) VALUES (?,?,?,?,?)', values);
  execute('DELETE FROM destination_trucks WHERE destination_id = ?', [id]);
  for (const t of truckIds) execute('INSERT INTO destination_trucks (destination_id, truck_type_id) VALUES (?, ?)', [id, t]);
  return id;
}

export const deleteDestination = (id: number) => execute('DELETE FROM destinations WHERE id = ?', [id]);

// ---- SKUs ----

export function searchSkus(text: string, limit = 12): Sku[] {
  const q = `%${text.trim()}%`;
  return query<Sku>('SELECT * FROM skus WHERE code LIKE ? OR name LIKE ? ORDER BY name LIMIT ?', [q, q, limit]);
}

export const listSkus = () => query<Sku>('SELECT * FROM skus ORDER BY code');

export function toEngineSku(s: Sku): EngineSku {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    length: s.length_cm,
    width: s.width_cm,
    height: s.height_cm,
    weight: s.weight_kg ?? 0,
    safeStackHeight: s.safe_stack_height_cm,
    canLieDown: !!s.can_lie_down,
    packaging: s.packaging,
  };
}

export function saveSku(s: Omit<Sku, 'id' | 'volume_m3'> & { id?: number }): number {
  const values: SqlValue[] = [s.code, s.name, s.length_cm, s.width_cm, s.height_cm, s.weight_kg, s.safe_stack_height_cm, s.can_lie_down, s.packaging, s.is_dummy];
  if (s.id) {
    execute(
      `UPDATE skus SET code=?, name=?, length_cm=?, width_cm=?, height_cm=?, weight_kg=?, safe_stack_height_cm=?, can_lie_down=?, packaging=?, is_dummy=? WHERE id=?`,
      [...values, s.id],
    );
    return s.id;
  }
  return execute(
    `INSERT INTO skus (code, name, length_cm, width_cm, height_cm, weight_kg, safe_stack_height_cm, can_lie_down, packaging, is_dummy) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    values,
  );
}

export const deleteSku = (id: number) => execute('DELETE FROM skus WHERE id = ?', [id]);

// ---- Shipments and saved plans ----

export function saveShipmentPlan(
  so: string | null,
  destinationId: number | null,
  truckId: number,
  lines: { skuId: number; qty: number | null }[],
  plan: PlanResult,
): number {
  const shipmentId = execute('INSERT INTO shipments (so_number, destination_id, truck_type_id) VALUES (?, ?, ?)', [so, destinationId, truckId]);
  lines.forEach((l, i) => execute('INSERT INTO shipment_lines (shipment_id, sku_id, qty, position) VALUES (?, ?, ?, ?)', [shipmentId, l.skuId, l.qty, i]));
  execute(
    'INSERT INTO load_plans (shipment_id, model, total_cartons, tier_count, volume_utilization, result_json) VALUES (?, ?, ?, ?, ?, ?)',
    [shipmentId, plan.model, plan.totalCartons, plan.tiers.length, plan.volumeUtilization, JSON.stringify(plan)],
  );
  return shipmentId;
}

export const listSavedPlans = () =>
  query<SavedPlan>(
    `SELECT p.id, p.shipment_id, s.so_number, d.customer, d.city, t.name AS truck_name, p.model, p.total_cartons, p.tier_count, p.volume_utilization, p.created_at
     FROM load_plans p JOIN shipments s ON s.id = p.shipment_id
     LEFT JOIN destinations d ON d.id = s.destination_id
     LEFT JOIN truck_types t ON t.id = s.truck_type_id
     ORDER BY p.id DESC`,
  );

export const deleteShipment = (shipmentId: number) => execute('DELETE FROM shipments WHERE id = ?', [shipmentId]);
