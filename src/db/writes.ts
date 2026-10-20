import { D1_MAX_PARAMS, insertStatements, type Row, type SqlParam, type Statement, type TableName } from './snapshot';

// Every change to the shared data, as named operations. The Worker (src/server) runs them against
// Cloudflare D1; without a server they run against the browser copy. The browser only sends an
// operation name and its arguments, never SQL, so the server decides what each caller may change.

export interface Store {
  /** Runs one statement and returns the id of the inserted row (when it inserted one). */
  run(sql: string, params?: SqlParam[]): Promise<number>;
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Runs the statements in order, in one round trip (and one transaction on D1). */
  batch(statements: Statement[]): Promise<void>;
}

type Fields = Record<string, unknown>;

const TRUCK_COLUMNS = ['code', 'name', 'variant', 'body_type', 'est_volume_min', 'est_volume_max', 'inner_length_cm', 'inner_width_cm', 'inner_height_cm', 'dims_estimated', 'is_template', 'notes'] as const;

const SKU_COLUMNS = [
  'code', 'name', 'length_cm', 'width_cm', 'height_cm', 'mod_length_cm', 'mod_width_cm', 'mod_height_cm', 'weight_kg',
  'safe_stack_layers', 'max_top_load_kg', 'can_lie_down', 'packaging', 'product_group', 'active', 'is_dummy',
] as const;

const value = (v: unknown): SqlParam => (v == null ? null : typeof v === 'number' || typeof v === 'string' ? v : typeof v === 'boolean' ? Number(v) : JSON.stringify(v));

async function saveSku(db: Store, s: Fields): Promise<number> {
  const values = SKU_COLUMNS.map((c) => value(s[c] ?? (c.startsWith('mod_') ? 0 : null)));
  if (s.id) {
    await db.run(`UPDATE skus SET ${SKU_COLUMNS.map((c) => `${c}=?`).join(', ')} WHERE id=?`, [...values, Number(s.id)]);
    return Number(s.id);
  }
  return db.run(`INSERT INTO skus (${SKU_COLUMNS.join(', ')}) VALUES (${SKU_COLUMNS.map(() => '?').join(',')})`, values);
}

const skuRow = (s: Fields): Row => Object.fromEntries(SKU_COLUMNS.map((c) => [c, value(s[c] ?? (c.startsWith('mod_') ? 0 : null))]));

/** Inserts the SKUs, or updates those with the same SAP material number, a few per statement. */
async function upsertSkus(db: Store, rows: Fields[]): Promise<{ added: number; updated: number }> {
  const known = new Set((await db.all<{ code: string }>('SELECT code FROM skus')).map((r) => r.code));
  const clean = rows.map((r) => ({ ...r, code: String(r.code ?? '').trim() }));
  const updated = clean.filter((r) => known.has(r.code)).length;
  const update = SKU_COLUMNS.filter((c) => c !== 'code').map((c) => `${c} = excluded.${c}`).join(', ');
  await db.batch(insertStatements('skus', clean.map(skuRow), D1_MAX_PARAMS).map((st) => ({ ...st, sql: `${st.sql} ON CONFLICT(code) DO UPDATE SET ${update}` })));
  return { added: clean.length - updated, updated };
}

export const WRITES = {
  async saveTruck(db: Store, input: Fields): Promise<number> {
    // A truck has one volume; the minimum column is kept equal to it so older data still reads the same.
    const t: Fields = { ...input, est_volume_min: input.est_volume_max };
    const values = TRUCK_COLUMNS.map((c) => value(t[c]));
    if (t.id) {
      await db.run(`UPDATE truck_types SET ${TRUCK_COLUMNS.map((c) => `${c}=?`).join(', ')} WHERE id=?`, [...values, Number(t.id)]);
      return Number(t.id);
    }
    return db.run(`INSERT INTO truck_types (${TRUCK_COLUMNS.join(', ')}) VALUES (${TRUCK_COLUMNS.map(() => '?').join(',')})`, values);
  },
  deleteTruck: (db: Store, id: number) => db.run('DELETE FROM truck_types WHERE id = ?', [id]),

  async saveDestination(db: Store, d: Fields, truckIds: number[]): Promise<number> {
    const values = [d.ship_to_no, d.customer, d.city, d.zone, d.vehicle_type_raw].map(value);
    let id = Number(d.id) || 0;
    if (id) await db.run('UPDATE destinations SET ship_to_no=?, customer=?, city=?, zone=?, vehicle_type_raw=? WHERE id=?', [...values, id]);
    else id = await db.run('INSERT INTO destinations (ship_to_no, customer, city, zone, vehicle_type_raw) VALUES (?,?,?,?,?)', values);
    const links = truckIds.map((t) => ({ destination_id: id, truck_type_id: t }));
    await db.batch([{ sql: 'DELETE FROM destination_trucks WHERE destination_id = ?', params: [id] }, ...insertStatements('destination_trucks', links, D1_MAX_PARAMS)]);
    return id;
  },
  deleteDestination: (db: Store, id: number) => db.run('DELETE FROM destinations WHERE id = ?', [id]),

  saveSku,
  /** Saves the SKU under its SAP material number and returns its id. */
  async upsertSku(db: Store, s: Fields): Promise<number> {
    await upsertSkus(db, [s]);
    return (await db.all<{ id: number }>('SELECT id FROM skus WHERE code = ?', [String(s.code ?? '').trim()]))[0].id;
  },
  upsertSkus,
  deleteSku: (db: Store, id: number) => db.run('DELETE FROM skus WHERE id = ?', [id]),

  saveRules: (db: Store, model: string, rules: unknown) =>
    db.run('INSERT INTO model_settings (model, rules_json) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET rules_json = excluded.rules_json', [model, JSON.stringify(rules)]),

  setMeta: (db: Store, key: string, val: string) =>
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, val]),

  async saveShipmentPlan(db: Store, reference: string | null, destinationId: number | null, truckId: number | null, truck: unknown, lines: { sku: Fields; qty: number | null }[], plan: Fields): Promise<number> {
    const shipmentId = await db.run('INSERT INTO shipments (reference, destination_id, truck_type_id, truck_json) VALUES (?, ?, ?, ?)', [reference, destinationId, truckId, JSON.stringify(truck)]);
    const rows = lines.map((l, i) => ({ shipment_id: shipmentId, sku_id: Number(l.sku.id), sku_json: JSON.stringify(l.sku), qty: l.qty, position: i }));
    await db.batch(insertStatements('shipment_lines', rows, D1_MAX_PARAMS));
    return db.run('INSERT INTO load_plans (shipment_id, model, rules_json, total_cartons, tier_count, volume_utilization, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      shipmentId,
      value(plan.model),
      JSON.stringify(plan.rules),
      value(plan.totalCartons),
      (plan.tiers as unknown[]).length,
      value(plan.volumeUtilization),
      JSON.stringify(plan),
    ]);
  },
  updatePlanTracking: (db: Store, planId: number, status: string, note: string | null, actual: unknown, outcome: unknown) =>
    db.run("UPDATE load_plans SET status = ?, planner_note = ?, actual_json = ?, outcome_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?", [
      status,
      note,
      JSON.stringify(actual),
      JSON.stringify(outcome),
      planId,
    ]),
  deleteShipment: (db: Store, shipmentId: number) => db.run('DELETE FROM shipments WHERE id = ?', [shipmentId]),
};

export type WriteOp = keyof typeof WRITES;
type Args<F> = F extends (db: Store, ...args: infer A) => unknown ? A : never;
export type WriteArgs<K extends WriteOp> = Args<(typeof WRITES)[K]>;
export type WriteResult<K extends WriteOp> = Awaited<ReturnType<(typeof WRITES)[K]>>;

/** Tables an operation can change (cascades included), so only those are reloaded afterwards. */
export const TOUCHES: Record<WriteOp, TableName[]> = {
  saveTruck: ['truck_types'],
  deleteTruck: ['truck_types', 'destination_trucks', 'shipments'],
  saveDestination: ['destinations', 'destination_trucks'],
  deleteDestination: ['destinations', 'destination_trucks', 'shipments'],
  saveSku: ['skus'],
  upsertSku: ['skus'],
  upsertSkus: ['skus'],
  deleteSku: ['skus'],
  saveRules: ['model_settings'],
  setMeta: ['meta'],
  saveShipmentPlan: ['shipments', 'shipment_lines', 'load_plans'],
  updatePlanTracking: ['load_plans'],
  deleteShipment: ['shipments', 'shipment_lines', 'load_plans'],
};

/**
 * Whether the operation needs the master password. Planners save plans, track them and keep
 * one-off trucks without it, as on the input and history screens; everything else is master data.
 */
export function needsAdmin<K extends WriteOp>(op: K, args: WriteArgs<K>, adminSet: boolean): boolean {
  if (op === 'saveShipmentPlan' || op === 'updatePlanTracking' || op === 'deleteShipment') return false;
  if (op === 'saveTruck') {
    const t = args[0] as Fields;
    return !(t.is_template === 1 && !t.id);
  }
  // The first visitor creates the master password; after that only the master can change it.
  if (op === 'setMeta' && args[0] === 'admin_hash') return adminSet;
  return true;
}
