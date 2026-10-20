import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from '../db/schema';
import { D1_MAX_PARAMS, SECRET_META, TABLES, insertStatements, splitSql, type Row, type Snapshot, type SqlParam, type TableName } from '../db/snapshot';
import { TOUCHES, WRITES, needsAdmin, type Store, type WriteOp } from '../db/writes';

// Cloudflare Worker: serves the built app from ./dist and the shared database (D1, binding DB)
// under /api. The browser loads every table once, queries its own copy, and sends changes here
// as named operations (db/writes.ts).
//
//   GET  /api/snapshot           all tables, or { empty: true } before the first setup
//   POST /api/write  {op, args}  runs one operation; returns its result and the tables it changed
//   POST /api/unlock             checks the master password (X-Admin-Key: its hash)
//   POST /api/restore            replaces all data (import a .sqlite file, reset to the seed data)

interface D1Result<T> {
  results: T[];
  meta: { last_row_id: number; changes: number };
}
interface D1PreparedStatement {
  bind(...values: SqlParam[]): D1PreparedStatement;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]>;
}
interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const store = (db: D1Database): Store => ({
  run: async (sql, params = []) => (await db.prepare(sql).bind(...params).run()).meta.last_row_id,
  all: async <T>(sql: string, params: SqlParam[] = []) => (await db.prepare(sql).bind(...params).all<T>()).results,
  batch: async (statements) => {
    if (statements.length) await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
  },
});

async function metaValue(db: D1Database, key: string): Promise<string | null> {
  try {
    return (await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).all<{ value: string }>()).results[0]?.value ?? null;
  } catch {
    return null; // No tables yet.
  }
}

async function readTables(db: D1Database, tables: readonly TableName[]): Promise<Snapshot> {
  const results = await db.batch(tables.map((t) => db.prepare(t === 'meta' ? 'SELECT * FROM meta WHERE key <> ?' : `SELECT * FROM ${t}`).bind(...(t === 'meta' ? [SECRET_META] : []))));
  return Object.fromEntries(tables.map((t, i) => [t, results[i].results as Row[]]));
}

/** Brings the D1 schema up to SCHEMA_VERSION; each migration runs as one batch (a transaction). */
async function migrate(db: D1Database, from: number) {
  for (let v = from; v < SCHEMA_VERSION; v++) {
    if (!MIGRATIONS[v]) throw new HttpError(500, `No migration from schema ${v}`);
    await db.batch([
      db.prepare('PRAGMA defer_foreign_keys = on'),
      ...splitSql(MIGRATIONS[v]).map((s) => db.prepare(s)),
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").bind(String(v + 1)),
    ]);
  }
}

async function requireAdmin(db: D1Database, request: Request) {
  const hash = await metaValue(db, SECRET_META);
  if (!hash || request.headers.get('x-admin-key') !== hash) throw new HttpError(403, 'Master password required');
}

async function snapshot(db: D1Database) {
  const version = Number((await metaValue(db, 'schema_version')) ?? 0);
  if (!version) return { empty: true };
  if (version < SCHEMA_VERSION) await migrate(db, version);
  return { tables: await readTables(db, TABLES), adminSet: (await metaValue(db, SECRET_META)) != null };
}

async function write(db: D1Database, request: Request) {
  const { op, args } = (await request.json()) as { op: WriteOp; args: unknown[] };
  const fn = WRITES[op] as ((s: Store, ...a: unknown[]) => Promise<unknown>) | undefined;
  if (!fn || !Array.isArray(args)) throw new HttpError(400, 'Unknown operation');
  const hash = await metaValue(db, SECRET_META);
  if (needsAdmin(op, args as never, hash != null) && (!hash || request.headers.get('x-admin-key') !== hash)) throw new HttpError(403, 'Master password required');
  const result = await fn(store(db), ...args);
  return { result, tables: await readTables(db, TOUCHES[op]) };
}

/**
 * Replaces all data. The browser first sends { reset: true }, which empties every table but keeps
 * the master password, then the rows in parts (db/snapshot.ts restoreParts), meta last.
 */
async function restore(db: D1Database, request: Request) {
  // Before the first setup anyone may load the seed data; afterwards only the master.
  const setUp = (await metaValue(db, 'schema_version')) != null;
  if (setUp) await requireAdmin(db, request);
  const { tables = {}, reset } = (await request.json()) as { tables?: Snapshot; reset?: boolean };
  const version = tables.meta?.find((r) => r.key === 'schema_version')?.value;
  if (version != null && Number(version) !== SCHEMA_VERSION) throw new HttpError(400, 'Schema version mismatch');
  const statements = [db.prepare('PRAGMA defer_foreign_keys = on')];
  if (reset) {
    if (!setUp) statements.push(...splitSql(SCHEMA_SQL).map((s) => db.prepare(s)));
    for (const t of [...TABLES].reverse())
      statements.push(t === 'meta' ? db.prepare("DELETE FROM meta WHERE key NOT IN (?, 'schema_version')").bind(SECRET_META) : db.prepare(`DELETE FROM ${t}`));
  }
  for (const t of TABLES) {
    const rows = (tables[t] ?? []).filter((r) => !(t === 'meta' && r.key === SECRET_META));
    for (const st of insertStatements(t, rows, D1_MAX_PARAMS, t === 'meta' ? 'INSERT OR REPLACE' : 'INSERT')) statements.push(db.prepare(st.sql).bind(...st.params));
  }
  await db.batch(statements);
  return { ok: true };
}

async function api(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/snapshot' && request.method === 'GET') return json(await snapshot(env.DB));
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (path === '/api/write') return json(await write(env.DB, request));
  if (path === '/api/unlock') {
    await requireAdmin(env.DB, request);
    return json({ ok: true });
  }
  if (path === '/api/restore') return json(await restore(env.DB, request));
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, path);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  },
};
