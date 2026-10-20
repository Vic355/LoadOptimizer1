import type { SqlValue } from 'sql.js';
import { execute, query } from './database';
import { discardPersonal, personal, personalRules, savePersonal } from './personal';
import { MODEL_ORDER, withDefaults, type EngineSku, type EngineTruck, type ModelId, type ModelRules, type PlanResult } from '../engine';

export type BodyType = 'box' | 'wingbox' | 'open' | 'container';
export type PlanStatus = 'draft' | 'final' | 'loaded';
export type PlanFollowed = 'yes' | 'changed';
export type PlanComplaint = 'none' | 'shifted' | 'damaged' | 'collapsed';

/** How a loaded plan went in real life; the history page records it so it can later train a model. */
export interface PlanOutcome {
  /** Date the truck was loaded (yyyy-mm-dd). */
  loadedOn?: string;
  /** Whether the loaders followed the plan or changed it. */
  followed?: PlanFollowed;
  complaint?: PlanComplaint;
  /** Cartons damaged or moved, when there was a complaint. */
  affectedCartons?: number | null;
  /** Free text: what happened, route, driver feedback. */
  note?: string;
}

export interface TruckType {
  id: number;
  code: string;
  name: string;
  variant: string | null;
  body_type: BodyType;
  est_volume_min: number | null;
  est_volume_max: number | null;
  inner_length_cm: number | null;
  inner_width_cm: number | null;
  inner_height_cm: number | null;
  dims_estimated: number;
  is_template: number;
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
  mod_length_cm: number;
  mod_width_cm: number;
  mod_height_cm: number;
  weight_kg: number | null;
  safe_stack_layers: number;
  max_top_load_kg: number | null;
  can_lie_down: number;
  packaging: 'carton' | 'bundle';
  product_group: string | null;
  active: number;
  volume_m3: number;
  is_dummy: number;
  /** Set on SKUs from the user's personal layer: a new SKU or a changed database SKU. */
  personal?: 'new' | 'edited';
}

export interface SavedPlan {
  id: number;
  shipment_id: number;
  reference: string | null;
  destination_id: number | null;
  customer: string | null;
  city: string | null;
  zone: string | null;
  truck_type_id: number | null;
  truck_name: string | null;
  truck_json: string;
  model: ModelId;
  total_cartons: number;
  tier_count: number;
  volume_utilization: number;
  status: PlanStatus;
  planner_note: string | null;
  actual_json: string | null;
  outcome_json: string | null;
  created_at: string;
}

export const truckLabel = (t: Pick<TruckType, 'name' | 'variant'>) => (t.variant ? `${t.name} (${t.variant})` : t.name);

// ---- Trucks ----

export const listTrucks = () => query<TruckType>('SELECT * FROM truck_types ORDER BY is_template, COALESCE(est_volume_max, 0), name, variant');

export function truckHasDims(t: Pick<TruckType, 'inner_length_cm' | 'inner_width_cm' | 'inner_height_cm'>): boolean {
  return !!(t.inner_length_cm && t.inner_width_cm && t.inner_height_cm);
}

export function toEngineTruck(t: Pick<TruckType, 'inner_length_cm' | 'inner_width_cm' | 'inner_height_cm'>): EngineTruck {
  return { length: t.inner_length_cm ?? 0, width: t.inner_width_cm ?? 0, height: t.inner_height_cm ?? 0 };
}

export function truckVolume(t: Pick<TruckType, 'inner_length_cm' | 'inner_width_cm' | 'inner_height_cm'>): number | null {
  return truckHasDims(t) ? (t.inner_length_cm! * t.inner_width_cm! * t.inner_height_cm!) / 1e6 : null;
}

/** Size used to compare trucks: the estimated volume, else the volume from the dimensions. */
export const truckSize = (t: TruckType) => t.est_volume_max ?? truckVolume(t) ?? 0;

const TRUCK_COLUMNS = ['code', 'name', 'variant', 'body_type', 'est_volume_min', 'est_volume_max', 'inner_length_cm', 'inner_width_cm', 'inner_height_cm', 'dims_estimated', 'is_template', 'notes'] as const;

export function saveTruck(t: Omit<TruckType, 'id'> & { id?: number }): number {
  const values = TRUCK_COLUMNS.map((c) => t[c] as SqlValue);
  if (t.id) {
    execute(`UPDATE truck_types SET ${TRUCK_COLUMNS.map((c) => `${c}=?`).join(', ')} WHERE id=?`, [...values, t.id]);
    return t.id;
  }
  return execute(`INSERT INTO truck_types (${TRUCK_COLUMNS.join(', ')}) VALUES (${TRUCK_COLUMNS.map(() => '?').join(',')})`, values);
}

export const deleteTruck = (id: number) => execute('DELETE FROM truck_types WHERE id = ?', [id]);

// ---- Destinations ----

export function searchDestinations(text: string, limit = 12): Destination[] {
  const q = `%${text.trim()}%`;
  return query<Destination>(
    `SELECT * FROM destinations WHERE customer LIKE ? OR city LIKE ? OR zone LIKE ? OR ship_to_no LIKE ?
     ORDER BY customer, city LIMIT ?`,
    [q, q, q, q, limit],
  );
}

export const listDestinations = () => query<Destination>('SELECT * FROM destinations ORDER BY zone, customer, city');

export const listedTrucks = (destinationId: number) =>
  query<TruckType>(
    `SELECT t.* FROM truck_types t JOIN destination_trucks dt ON dt.truck_type_id = t.id
     WHERE dt.destination_id = ? ORDER BY COALESCE(t.est_volume_max, 0) DESC`,
    [destinationId],
  );

/** The largest vehicle listed for the destination. Smaller trucks are always allowed. */
export const maxTruckFor = (destinationId: number): TruckType | null => listedTrucks(destinationId)[0] ?? null;

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

const volume = (s: Pick<Sku, 'length_cm' | 'width_cm' | 'height_cm' | 'mod_length_cm' | 'mod_width_cm' | 'mod_height_cm'>) =>
  ((s.length_cm + s.mod_length_cm) * (s.width_cm + s.mod_width_cm) * (s.height_cm + s.mod_height_cm)) / 1e6;

/** SKUs exactly as stored in the shared database, without personal changes. */
export const listMasterSkus = () => query<Sku>('SELECT * FROM skus ORDER BY code');

/** The SKUs the calculator uses: database SKUs with the user's personal changes, plus personal SKUs. */
export function listSkus(): Sku[] {
  const { added, edits } = personal();
  const merged = listMasterSkus().map((s) => {
    const e = edits[s.id];
    if (!e) return s;
    const next = { ...s, ...e, id: s.id, personal: 'edited' as const };
    return { ...next, volume_m3: volume(next) };
  });
  for (const [id, a] of Object.entries(added)) {
    const s = { ...a, id: Number(id), personal: 'new' as const } as Sku;
    merged.push({ ...s, volume_m3: volume(s) });
  }
  return merged.sort((p, q) => p.code.localeCompare(q.code));
}

export function searchSkus(text: string, limit = 12): Sku[] {
  const q = text.trim().toLowerCase();
  return listSkus()
    .filter((s) => s.active && (!q || `${s.code} ${s.name} ${s.product_group ?? ''}`.toLowerCase().includes(q)))
    .sort((p, q2) => p.name.localeCompare(q2.name))
    .slice(0, limit);
}

export const skuByCode = (code: string) => listSkus().find((s) => s.code === code.trim()) ?? null;
const masterSkuByCode = (code: string) => query<Sku>('SELECT * FROM skus WHERE code = ?', [code.trim()])[0] ?? null;

/** Saves a SKU change for this user only; the shared database is not touched. */
export const savePersonalSku = (s: SkuInput) => savePersonal(s.id ?? null, { ...s, id: undefined });

/** Master role: writes a personal SKU or change into the shared database and drops the personal copy. */
export function publishSku(s: Sku): number {
  const { id, personal: kind, volume_m3: _v, ...fields } = s;
  const existing = kind === 'new' ? masterSkuByCode(s.code) : null;
  const dbId = saveSku({ ...fields, id: kind === 'new' ? existing?.id : id });
  discardPersonal(id);
  return dbId;
}

/** Planning size of a SKU: measured outer size plus its size modifier. */
export const plannedDims = (s: Sku): [number, number, number] => [s.length_cm + s.mod_length_cm, s.width_cm + s.mod_width_cm, s.height_cm + s.mod_height_cm];

export function toEngineSku(s: Sku): EngineSku {
  const [length, width, height] = plannedDims(s);
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    length,
    width,
    height,
    weight: s.weight_kg ?? 0,
    safeLayers: s.safe_stack_layers,
    canLieDown: !!s.can_lie_down,
    group: s.product_group ?? '',
  };
}

const SKU_COLUMNS = [
  'code', 'name', 'length_cm', 'width_cm', 'height_cm', 'mod_length_cm', 'mod_width_cm', 'mod_height_cm', 'weight_kg',
  'safe_stack_layers', 'max_top_load_kg', 'can_lie_down', 'packaging', 'product_group', 'active', 'is_dummy',
] as const;

export type SkuInput = Omit<Sku, 'id' | 'volume_m3'> & { id?: number };

export function saveSku(s: SkuInput): number {
  const values = SKU_COLUMNS.map((c) => (s[c] ?? (c.startsWith('mod_') ? 0 : null)) as SqlValue);
  if (s.id) {
    execute(`UPDATE skus SET ${SKU_COLUMNS.map((c) => `${c}=?`).join(', ')} WHERE id=?`, [...values, s.id]);
    return s.id;
  }
  return execute(`INSERT INTO skus (${SKU_COLUMNS.join(', ')}) VALUES (${SKU_COLUMNS.map(() => '?').join(',')})`, values);
}

/** Inserts new SKUs and updates existing ones (matched by SAP material number). */
export function upsertSkus(rows: SkuInput[]): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  for (const r of rows) {
    const existing = masterSkuByCode(r.code);
    saveSku({ ...r, id: existing?.id });
    if (existing) updated++;
    else added++;
  }
  return { added, updated };
}

export const deleteSku = (id: number) => execute('DELETE FROM skus WHERE id = ?', [id]);

// ---- Model rules ----

/** The shared database rules, with this user's personal rules on top unless `shared` is set. */
export function loadRules(shared = false): Record<ModelId, ModelRules> {
  const rows = query<{ model: ModelId; rules_json: string }>('SELECT * FROM model_settings');
  const stored = new Map(rows.map((r) => [r.model, JSON.parse(r.rules_json) as Partial<ModelRules>]));
  const mine = shared ? {} : personalRules();
  return Object.fromEntries(MODEL_ORDER.map((m) => [m, withDefaults(m, mine[m] ?? stored.get(m))])) as Record<ModelId, ModelRules>;
}

export const hasPersonalRules = (model: ModelId) => personalRules()[model] != null;

export const saveRules = (model: ModelId, rules: ModelRules) =>
  execute('INSERT INTO model_settings (model, rules_json) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET rules_json = excluded.rules_json', [model, JSON.stringify(rules)]);

// ---- Settings ----

export const getMeta = (key: string) => query<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])[0]?.value ?? null;
export const setMeta = (key: string, value: string) =>
  execute('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);

// ---- Shipments and saved plans ----

export interface PlanTruck {
  name: string;
  length: number;
  width: number;
  height: number;
}

export function saveShipmentPlan(
  reference: string | null,
  destinationId: number | null,
  truckId: number | null,
  truck: PlanTruck,
  lines: { sku: Sku; qty: number | null }[],
  plan: PlanResult,
): number {
  const shipmentId = execute('INSERT INTO shipments (reference, destination_id, truck_type_id, truck_json) VALUES (?, ?, ?, ?)', [reference, destinationId, truckId, JSON.stringify(truck)]);
  lines.forEach((l, i) =>
    execute('INSERT INTO shipment_lines (shipment_id, sku_id, sku_json, qty, position) VALUES (?, ?, ?, ?, ?)', [shipmentId, l.sku.id, JSON.stringify(l.sku), l.qty, i]),
  );
  return execute(
    'INSERT INTO load_plans (shipment_id, model, rules_json, total_cartons, tier_count, volume_utilization, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [shipmentId, plan.model, JSON.stringify(plan.rules), plan.totalCartons, plan.tiers.length, plan.volumeUtilization, JSON.stringify(plan)],
  );
}

export const listSavedPlans = () =>
  query<SavedPlan>(
    `SELECT p.id, p.shipment_id, s.reference, s.destination_id, d.customer, d.city, d.zone, s.truck_type_id, t.name AS truck_name, s.truck_json,
            p.model, p.total_cartons, p.tier_count, p.volume_utilization, p.status, p.planner_note, p.actual_json, p.outcome_json, p.created_at
     FROM load_plans p JOIN shipments s ON s.id = p.shipment_id
     LEFT JOIN destinations d ON d.id = s.destination_id
     LEFT JOIN truck_types t ON t.id = s.truck_type_id
     ORDER BY p.id DESC`,
  );

export const planResult = (planId: number): PlanResult | null => {
  const row = query<{ result_json: string }>('SELECT result_json FROM load_plans WHERE id = ?', [planId])[0];
  return row ? (JSON.parse(row.result_json) as PlanResult) : null;
};

/** A saved shipment's lines with each SKU as it was planned (older plans fall back to current data). */
export function shipmentLines(shipmentId: number): { sku: Sku; qty: number | null }[] {
  const rows = query<{ sku_id: number; sku_json: string | null; qty: number | null }>('SELECT sku_id, sku_json, qty FROM shipment_lines WHERE shipment_id = ? ORDER BY position', [shipmentId]);
  const current = new Map(listSkus().map((s) => [s.id, s]));
  return rows
    .map((r) => ({ sku: r.sku_json ? (JSON.parse(r.sku_json) as Sku) : current.get(r.sku_id), qty: r.qty }))
    .filter((l): l is { sku: Sku; qty: number | null } => !!l.sku);
}

export function updatePlanTracking(planId: number, status: PlanStatus, note: string | null, actual: Record<number, number | null>, outcome: PlanOutcome) {
  execute("UPDATE load_plans SET status = ?, planner_note = ?, actual_json = ?, outcome_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?", [
    status,
    note,
    JSON.stringify(actual),
    JSON.stringify(outcome),
    planId,
  ]);
}

export const parseOutcome = (p: Pick<SavedPlan, 'outcome_json'>): PlanOutcome => (p.outcome_json ? (JSON.parse(p.outcome_json) as PlanOutcome) : {});

export const deleteShipment = (shipmentId: number) => execute('DELETE FROM shipments WHERE id = ?', [shipmentId]);
