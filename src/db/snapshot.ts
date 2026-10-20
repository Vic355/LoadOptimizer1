// Table rows as plain JSON, used to move data between the shared database (Cloudflare D1, via
// the Worker in src/server) and the copy the browser queries with sql.js. Shared by both sides.

export type SqlParam = string | number | null;
export type Row = Record<string, SqlParam>;

/** Every table, parents before children, so inserts in this order satisfy the foreign keys. */
export const TABLES = ['meta', 'truck_types', 'destinations', 'destination_trucks', 'skus', 'shipments', 'shipment_lines', 'load_plans', 'model_settings'] as const;
export type TableName = (typeof TABLES)[number];
export type Snapshot = Partial<Record<TableName, Row[]>>;

/** Generated columns: returned by SELECT * but never inserted. */
const GENERATED: Partial<Record<TableName, string[]>> = { skus: ['volume_m3'] };

/** D1 accepts at most 100 bound values per statement. */
export const D1_MAX_PARAMS = 100;

/** The admin password hash never leaves the server. */
export const SECRET_META = 'admin_hash';

export interface Statement {
  sql: string;
  params: SqlParam[];
}

/** INSERTs for the rows, several rows per statement but at most `maxParams` bound values each. */
export function insertStatements(table: TableName, rows: Row[], maxParams: number, verb = 'INSERT'): Statement[] {
  if (!rows.length) return [];
  const skip = new Set(GENERATED[table] ?? []);
  const columns = Object.keys(rows[0]).filter((c) => !skip.has(c));
  const perStatement = Math.max(1, Math.floor(maxParams / columns.length));
  const out: Statement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    out.push({
      sql: `${verb} INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(', ')}`,
      params: chunk.flatMap((r) => columns.map((c) => r[c] ?? null)),
    });
  }
  return out;
}

/** Splits a block of SQL (the schema, a migration) into single statements. */
export const splitSql = (sql: string) =>
  sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim().replace(/;$/, ''))
    .filter(Boolean);

/** Restore requests: each carries at most about 20 INSERTs, since D1 limits queries per request. */
export function restoreParts(snapshot: Snapshot): Snapshot[] {
  const parts: Snapshot[] = [];
  // meta goes last: its schema_version marks the database as set up.
  for (const t of [...TABLES.filter((x) => x !== 'meta'), 'meta' as const]) {
    const rows = snapshot[t] ?? [];
    if (!rows.length) continue;
    const perPart = 20 * Math.max(1, Math.floor(D1_MAX_PARAMS / Object.keys(rows[0]).length));
    for (let i = 0; i < rows.length; i += perPart) parts.push({ [t]: rows.slice(i, i + perPart) });
  }
  return parts;
}
