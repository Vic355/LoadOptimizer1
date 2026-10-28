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
  'safe_stack_layers', 'max_top_load_kg', 'can_lie_down', 'packaging', 'product_group', 'active', 'is_dummy', 'cbox_code', 'board_grade', 'material_desc',
] as const;

const VEHICLE_COLUMNS = ['plate_no', 'truck_type_id', 'inner_length_cm', 'inner_width_cm', 'inner_height_cm', 'notes'] as const;

/** Plate numbers are compared in one spelling: capitals, single spaces ("b1234 xy" stays "B1234 XY"). */
export const normalizePlate = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();

/** One truck of a shipment as saved: the truck used, its plate number (optional) and its plan. */
export interface ShipmentTruckInput {
  truckTypeId: number | null;
  plateNo: string | null;
  truck: Fields;
  plan: Fields;
}

export interface ShipmentInput {
  /** The shipment being edited (a reopened plan or draft), if any. */
  shipmentId: number | null;
  shipmentNo: string;
  /** True for a draft saved under a temporary number. */
  isTemp: boolean;
  destinationId: number | null;
  note: string | null;
  lines: { sku: Fields; qty: number | null }[];
  trucks: ShipmentTruckInput[];
}

/** Adds the plate numbers to the vehicle register, or updates their type and size to the ones just used. */
function upsertVehicles(trucks: ShipmentTruckInput[]): Statement[] {
  return trucks
    .filter((t) => t.plateNo)
    .map((t) => ({
      sql: `INSERT INTO trucks (plate_no, truck_type_id, inner_length_cm, inner_width_cm, inner_height_cm, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
            ON CONFLICT(plate_no) DO UPDATE SET truck_type_id = COALESCE(excluded.truck_type_id, trucks.truck_type_id), inner_length_cm = excluded.inner_length_cm,
            inner_width_cm = excluded.inner_width_cm, inner_height_cm = excluded.inner_height_cm, updated_at = excluded.updated_at`,
      params: [normalizePlate(t.plateNo!), t.truckTypeId, value(t.truck.length), value(t.truck.width), value(t.truck.height)],
    }));
}

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

  /**
   * Saves a shipment with one plan per truck. A shipment number that already exists is replaced
   * (its lines and plans), as is the shipment being edited; a draft saved under a number that
   * another shipment has is merged into that one. Returns the shipment id.
   */
  async saveShipment(db: Store, s: ShipmentInput): Promise<number> {
    const no = s.shipmentNo.trim();
    if (!no) throw new Error('Shipment number required');
    const byNo = (await db.all<{ id: number }>('SELECT id FROM shipments WHERE shipment_no = ?', [no]))[0]?.id ?? null;
    const edited = s.shipmentId ? ((await db.all<{ id: number }>('SELECT id FROM shipments WHERE id = ?', [s.shipmentId]))[0]?.id ?? null) : null;
    let id = byNo ?? edited;
    const head = [no, s.isTemp ? 1 : 0, s.destinationId, s.note];
    const before: Statement[] = [];
    if (byNo != null && edited != null && edited !== byNo) before.push({ sql: 'DELETE FROM shipments WHERE id = ?', params: [edited] });
    if (id != null) {
      before.push(
        { sql: "UPDATE shipments SET shipment_no = ?, is_temp = ?, destination_id = ?, reference = ?, updated_at = datetime('now', 'localtime') WHERE id = ?", params: [...head, id] },
        { sql: 'DELETE FROM shipment_lines WHERE shipment_id = ?', params: [id] },
        { sql: 'DELETE FROM load_plans WHERE shipment_id = ?', params: [id] },
      );
      await db.batch([...before, ...upsertVehicles(s.trucks)]);
    } else {
      await db.batch(upsertVehicles(s.trucks));
      id = await db.run("INSERT INTO shipments (shipment_no, is_temp, destination_id, reference, truck_json, updated_at) VALUES (?, ?, ?, ?, '{}', datetime('now', 'localtime'))", head);
    }
    const lines = s.lines.map((l, i) => ({ shipment_id: id, sku_id: Number(l.sku.id), sku_json: JSON.stringify(l.sku), qty: l.qty, position: i }));
    const plans = s.trucks.map((t, i) => ({
      shipment_id: id,
      truck_seq: i + 1,
      truck_type_id: t.truckTypeId,
      plate_no: t.plateNo ? normalizePlate(t.plateNo) : null,
      truck_json: JSON.stringify(t.truck),
      model: value(t.plan.model),
      rules_json: JSON.stringify(t.plan.rules),
      total_cartons: value(t.plan.totalCartons),
      tier_count: (t.plan.tiers as unknown[]).length,
      volume_utilization: value(t.plan.volumeUtilization),
      result_json: JSON.stringify(t.plan),
    }));
    await db.batch([...insertStatements('shipment_lines', lines, D1_MAX_PARAMS), ...plans.map((p) => insertStatements('load_plans', [p], D1_MAX_PARAMS)[0])]);
    return id;
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

  /** Master role: a vehicle in the register (plate number, truck type, measured inner size). */
  async saveVehicle(db: Store, v: Fields): Promise<number> {
    const row: Fields = { ...v, plate_no: normalizePlate(String(v.plate_no ?? '')) };
    if (!row.plate_no) throw new Error('Plate number required');
    const values = VEHICLE_COLUMNS.map((c) => value(row[c]));
    if (v.id) {
      await db.run(`UPDATE trucks SET ${VEHICLE_COLUMNS.map((c) => `${c}=?`).join(', ')}, updated_at = datetime('now', 'localtime') WHERE id=?`, [...values, Number(v.id)]);
      return Number(v.id);
    }
    return db.run(`INSERT INTO trucks (${VEHICLE_COLUMNS.join(', ')}, updated_at) VALUES (${VEHICLE_COLUMNS.map(() => '?').join(',')}, datetime('now', 'localtime'))`, values);
  },
  deleteVehicle: (db: Store, id: number) => db.run('DELETE FROM trucks WHERE id = ?', [id]),
};

export type WriteOp = keyof typeof WRITES;
type Args<F> = F extends (db: Store, ...args: infer A) => unknown ? A : never;
export type WriteArgs<K extends WriteOp> = Args<(typeof WRITES)[K]>;
export type WriteResult<K extends WriteOp> = Awaited<ReturnType<(typeof WRITES)[K]>>;

/** Tables an operation can change (cascades included), so only those are reloaded afterwards. */
export const TOUCHES: Record<WriteOp, TableName[]> = {
  saveTruck: ['truck_types'],
  deleteTruck: ['truck_types', 'trucks', 'destination_trucks', 'shipments', 'load_plans'],
  saveDestination: ['destinations', 'destination_trucks'],
  deleteDestination: ['destinations', 'destination_trucks', 'shipments'],
  saveSku: ['skus'],
  upsertSku: ['skus'],
  upsertSkus: ['skus'],
  deleteSku: ['skus'],
  saveRules: ['model_settings'],
  setMeta: ['meta'],
  saveShipment: ['trucks', 'shipments', 'shipment_lines', 'load_plans'],
  updatePlanTracking: ['load_plans'],
  deleteShipment: ['shipments', 'shipment_lines', 'load_plans'],
  saveVehicle: ['trucks', 'load_plans'],
  deleteVehicle: ['trucks', 'load_plans'],
};

/**
 * Whether the operation needs the master password. Planners save plans, track them and keep
 * one-off trucks without it, as on the input and history screens; everything else is master data.
 */
export function needsAdmin<K extends WriteOp>(op: K, args: WriteArgs<K>, adminSet: boolean): boolean {
  // Saving a plan also records its trucks' plate numbers and sizes in the vehicle register.
  if (op === 'saveShipment' || op === 'updatePlanTracking' || op === 'deleteShipment') return false;
  if (op === 'saveTruck') {
    const t = args[0] as Fields;
    return !(t.is_template === 1 && !t.id);
  }
  // The first visitor creates the master password; after that only the master can change it.
  if (op === 'setMeta' && args[0] === 'admin_hash') return adminSet;
  return true;
}
