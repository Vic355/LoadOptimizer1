import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { t } from '../i18n/id';
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { seedDatabase } from './seed';
import { SECRET_META, TABLES, insertStatements, restoreParts, type Row, type Snapshot } from './snapshot';
import { WRITES, type Store, type WriteArgs, type WriteOp, type WriteResult } from './writes';

// SQLite runs in the browser (sql.js / WebAssembly) and every read is a local query.
//
// Shared mode (the app is served by the Worker in src/server): the tables come from the shared
// Cloudflare D1 database at start-up, and each change is sent to the server as a named operation;
// the server answers with the tables it changed, which replace the local copy.
//
// Local mode (no server, e.g. `npm run dev` or a plain static host): the whole database file is
// kept in IndexedDB, so data survives reloads and the app works offline, for this browser only.

const IDB_NAME = 'truck-load-optimizer';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'main';

let db: Database | null = null;
let mode: 'shared' | 'local' = 'local';
let adminSet = false;
let adminKey: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readStored(): Promise<Uint8Array | null> {
  try {
    const store = (await idb()).transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE);
    return await new Promise((resolve) => {
      const req = store.get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeStored(bytes: Uint8Array): Promise<void> {
  try {
    const tx = (await idb()).transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Private windows may block IndexedDB; the app still works for the session.
  }
}

function freshDatabase(SQL: initSqlJs.SqlJsStatic): Database {
  const fresh = new SQL.Database();
  fresh.exec('PRAGMA foreign_keys = ON;');
  fresh.exec(SCHEMA_SQL);
  fresh.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
  seedDatabase(fresh);
  return fresh;
}

let sqlStatic: initSqlJs.SqlJsStatic | null = null;

/** Whether the data is the shared server database or this browser's own copy. */
export const dbMode = () => mode;

class ApiMissing extends Error {}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A static host answers with the app page (or a 404) instead of JSON: there is no server.
  if (!res.headers.get('content-type')?.includes('application/json')) throw new ApiMissing(`${res.status}`);
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

type ServerSnapshot = { empty: true } | { empty?: false; tables: Snapshot; adminSet: boolean };

/** The server's tables, or null when the app runs without a server. */
async function fetchSnapshot(): Promise<ServerSnapshot | null> {
  try {
    return await api<ServerSnapshot>('snapshot');
  } catch (err) {
    if (err instanceof ApiMissing || err instanceof TypeError) return null;
    throw err;
  }
}

/** Replaces the given tables of the local copy with the server's rows. */
function load(d: Database, tables: Snapshot) {
  d.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  for (const name of TABLES) {
    const rows = tables[name];
    if (!rows) continue;
    d.run(name === 'meta' ? 'DELETE FROM meta WHERE key <> ?' : `DELETE FROM ${name}`, name === 'meta' ? [SECRET_META] : []);
    for (const st of insertStatements(name, rows, 900)) d.run(st.sql, st.params);
  }
  d.exec('COMMIT; PRAGMA foreign_keys = ON;');
}

const toSnapshot = (d: Database): Snapshot =>
  Object.fromEntries(
    TABLES.map((name) => {
      const res = d.exec(`SELECT * FROM ${name}`)[0];
      return [name, res ? res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i] as Row[string]]))) : []];
    }),
  );

/** Sends a whole database to the server in parts, replacing the shared data. */
async function pushToServer(d: Database) {
  await api('restore', { reset: true });
  for (const tables of restoreParts(toSnapshot(d))) await api('restore', { tables });
}

async function openShared(remote: ServerSnapshot): Promise<Database> {
  if (remote.empty) {
    // A new shared database: fill it with the seed data once.
    const seed = freshDatabase(sqlStatic!);
    await pushToServer(seed);
    seed.close();
    remote = (await fetchSnapshot())!;
    if (remote.empty) throw new Error('Shared database setup failed');
  }
  const d = new sqlStatic!.Database();
  d.exec(SCHEMA_SQL);
  load(d, remote.tables);
  d.exec('PRAGMA foreign_keys = ON;');
  adminSet = remote.adminSet;
  mode = 'shared';
  return d;
}

/** Reloads every table from the server, after replacing the shared data. */
async function reloadShared() {
  const remote = await fetchSnapshot();
  if (!remote || remote.empty) throw new Error('Shared database unavailable');
  load(current(), remote.tables);
  adminSet = remote.adminSet;
}

export async function openDatabase(): Promise<Database> {
  if (db) return db;
  try {
    sqlStatic = await initSqlJs({ locateFile: () => wasmUrl });
  } catch {
    // Some locked-down pages or old browsers refuse WebAssembly; fall back to the pure JS build.
    const asm = (await import('sql.js/dist/sql-asm.js')).default as typeof initSqlJs;
    sqlStatic = await asm();
  }
  const remote = await fetchSnapshot();
  if (remote) return (db = await openShared(remote));
  const stored = await readStored();
  const existing = stored ? new sqlStatic.Database(stored) : null;
  if (existing && migrate(existing)) {
    db = existing;
    await writeStored(db.export());
  } else {
    // First visit, or a database from an older prototype: start again from the seed data.
    existing?.close();
    db = freshDatabase(sqlStatic);
    await writeStored(db.export());
  }
  return db;
}

/** Brings a database up to SCHEMA_VERSION; false when it is too old to upgrade. */
function migrate(d: Database): boolean {
  let v = schemaVersion(d);
  while (v < SCHEMA_VERSION && MIGRATIONS[v]) {
    d.exec('PRAGMA foreign_keys = OFF;');
    d.exec(`BEGIN; ${MIGRATIONS[v]} COMMIT;`);
    v++;
    d.run("UPDATE meta SET value = ? WHERE key = 'schema_version'", [String(v)]);
  }
  if (v !== SCHEMA_VERSION) return false;
  d.exec('PRAGMA foreign_keys = ON;');
  return true;
}

function schemaVersion(d: Database): number {
  try {
    return Number(d.exec("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.values[0][0] ?? 0);
  } catch {
    return 0;
  }
}

function current(): Database {
  if (!db) throw new Error('Database not opened');
  return db;
}

/** Debounced save of the database file after writes. */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void writeStored(current().export()), 250);
}

export function query<T>(sql: string, params: SqlValue[] = []): T[] {
  const stmt = current().prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as T);
  stmt.free();
  return rows;
}

const localStore: Store = {
  run: async (sql, params = []) => {
    const d = current();
    d.run(sql, params);
    return d.exec('SELECT last_insert_rowid()')[0]?.values[0][0] as number;
  },
  all: async <T>(sql: string, params: SqlValue[] = []) => query<T>(sql, params),
  batch: async (statements) => {
    for (const st of statements) current().run(st.sql, st.params);
  },
};

/** Runs a change (db/writes.ts) on the shared database, or locally without a server. */
export async function write<K extends WriteOp>(op: K, ...args: WriteArgs<K>): Promise<WriteResult<K>> {
  const fn = WRITES[op] as (s: Store, ...a: WriteArgs<K>) => Promise<WriteResult<K>>;
  if (mode === 'local') {
    const result = await fn(localStore, ...args);
    scheduleSave();
    return result;
  }
  try {
    const res = await api<{ result: WriteResult<K>; tables: Snapshot }>('write', { op, args });
    load(current(), res.tables);
    if (op === 'setMeta' && args[0] === SECRET_META) adminSet = true;
    return res.result;
  } catch (err) {
    alert(`${t.saveFailed}\n${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---- Master password ----
// In shared mode the hash is kept on the server and sent with each master change.

export const hasAdminPassword = () => (mode === 'shared' ? adminSet : query("SELECT 1 FROM meta WHERE key = 'admin_hash'").length > 0);

/** Remembers the master key for changes; null locks again. */
export function setAdminKey(key: string | null) {
  adminKey = key;
}

export async function checkAdminKey(key: string): Promise<boolean> {
  if (mode === 'local') return query<{ value: string }>("SELECT value FROM meta WHERE key = 'admin_hash'")[0]?.value === key;
  const res = await fetch('/api/unlock', { method: 'POST', headers: { 'x-admin-key': key } });
  return res.ok;
}

export function exportDatabase(): Uint8Array {
  return current().export();
}

export async function importDatabase(bytes: Uint8Array): Promise<void> {
  if (!sqlStatic) throw new Error('Database not opened');
  const next = new sqlStatic.Database(bytes);
  if (!migrate(next)) {
    next.close();
    throw new Error('schema');
  }
  if (mode === 'shared') {
    await pushToServer(next);
    next.close();
    return reloadShared();
  }
  db?.close();
  db = next;
  db.exec('PRAGMA foreign_keys = ON;');
  await writeStored(db.export());
}

export async function resetDatabase(): Promise<void> {
  if (!sqlStatic) throw new Error('Database not opened');
  if (mode === 'shared') {
    const seed = freshDatabase(sqlStatic);
    await pushToServer(seed);
    seed.close();
    return reloadShared();
  }
  db?.close();
  db = freshDatabase(sqlStatic);
  await writeStored(db.export());
}
