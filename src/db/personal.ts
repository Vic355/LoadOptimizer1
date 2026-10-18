import type { SkuInput } from './repo';

// The user's own SKUs and SKU changes. They live in this browser only and are used by the
// calculator like any other SKU, but they never change the shared database: only the master
// role can publish them. With the server step this moves to a per-user store.

const KEY = 'tlo-personal-skus';

export interface PersonalStore {
  /** New SKUs, keyed by a negative id so they never clash with database ids. */
  added: Record<number, SkuInput>;
  /** Changed fields of database SKUs, keyed by the database id. */
  edits: Record<number, Partial<SkuInput>>;
}

let cache: PersonalStore | null = null;
const listeners = new Set<() => void>();

export function personal(): PersonalStore {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PersonalStore | null;
    cache = raw && typeof raw === 'object' ? { added: raw.added ?? {}, edits: raw.edits ?? {} } : { added: {}, edits: {} };
  } catch {
    cache = { added: {}, edits: {} };
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Storage blocked: personal changes last until the page is closed.
  }
  listeners.forEach((fn) => fn());
}

export function onPersonalChange(fn: () => void) {
  listeners.add(fn);
}

export function savePersonal(id: number | null, sku: SkuInput): number {
  const store = personal();
  if (id != null && id > 0) store.edits[id] = { ...sku, id: undefined };
  else {
    const newId = id ?? Math.min(0, ...Object.keys(store.added).map(Number)) - 1;
    store.added[newId] = { ...sku, id: undefined };
    id = newId;
  }
  persist();
  return id;
}

/** Drops a personal SKU, or the personal changes to a database SKU. */
export function discardPersonal(id: number) {
  const store = personal();
  if (id < 0) delete store.added[id];
  else delete store.edits[id];
  persist();
}

export function discardAllPersonal() {
  cache = { added: {}, edits: {} };
  persist();
}
