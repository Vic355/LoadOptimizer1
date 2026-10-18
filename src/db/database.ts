import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';
import { seedDatabase } from './seed';

// SQLite runs in the browser (sql.js / WebAssembly). The whole database file is kept in
// IndexedDB, so data survives reloads and the app works offline. Swapping this module for
// an HTTP client against a server database is the only change needed to centralise data.

const IDB_NAME = 'truck-load-optimizer';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'main';

let db: Database | null = null;
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

export async function openDatabase(): Promise<Database> {
  if (db) return db;
  try {
    sqlStatic = await initSqlJs({ locateFile: () => wasmUrl });
  } catch {
    // Some locked-down pages or old browsers refuse WebAssembly; fall back to the pure JS build.
    const asm = (await import('sql.js/dist/sql-asm.js')).default as typeof initSqlJs;
    sqlStatic = await asm();
  }
  const stored = await readStored();
  const existing = stored ? new sqlStatic.Database(stored) : null;
  if (existing && schemaVersion(existing) === SCHEMA_VERSION) {
    db = existing;
    db.exec('PRAGMA foreign_keys = ON;');
  } else {
    // First visit, or a database from an older prototype: start again from the seed data.
    existing?.close();
    db = freshDatabase(sqlStatic);
    await writeStored(db.export());
  }
  return db;
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

export function execute(sql: string, params: SqlValue[] = []): number {
  const d = current();
  d.run(sql, params);
  const id = d.exec('SELECT last_insert_rowid()')[0]?.values[0][0] as number;
  scheduleSave();
  return id;
}

export function exportDatabase(): Uint8Array {
  return current().export();
}

export async function importDatabase(bytes: Uint8Array): Promise<void> {
  if (!sqlStatic) throw new Error('Database not opened');
  const next = new sqlStatic.Database(bytes);
  if (schemaVersion(next) !== SCHEMA_VERSION) {
    next.close();
    throw new Error('schema');
  }
  db?.close();
  db = next;
  db.exec('PRAGMA foreign_keys = ON;');
  await writeStored(db.export());
}

export async function resetDatabase(): Promise<void> {
  if (!sqlStatic) throw new Error('Database not opened');
  db?.close();
  db = freshDatabase(sqlStatic);
  await writeStored(db.export());
}
