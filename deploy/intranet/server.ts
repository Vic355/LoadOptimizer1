// Intranet server (reference implementation). It runs the SAME API code as the Cloudflare Worker
// (src/server/index.ts) on Node.js: a SQLite file takes the place of Cloudflare D1, and the built
// app (dist/) is served from disk. Nothing in src/ changes.
//
// Build:  npm run build && npx vite build --ssr deploy/intranet/server.ts --outDir build-server
// Run:    node build-server/server.js          (Node.js 22.13+ for the built-in node:sqlite)
//
// Environment:
//   PORT      port to listen on (default 8080)
//   HOST      address to listen on (default 127.0.0.1: put IIS or nginx with HTTPS in front)
//   DIST_DIR  the built app (default ./dist)
//   DB_FILE   the SQLite database file (default ./storage/loadoptimizer.sqlite); back this file up
//
// Not provided: the "Tanya AI" help assistant (Workers AI). /api/ask answers 503 and the app
// shows the assistant as offline. See docs/intranet-migration-guide.md to connect an internal LLM.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import worker from '../../src/server/index';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const DIST = resolve(process.env.DIST_DIR ?? 'dist');
const DB_FILE = resolve(process.env.DB_FILE ?? 'storage/loadoptimizer.sqlite');

mkdirSync(dirname(DB_FILE), { recursive: true });
const sqlite = new DatabaseSync(DB_FILE);
// D1 enforces foreign keys; WAL lets reads continue while a write is in progress.
sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

type Param = string | number | null;

/** One statement in the shape of a D1 prepared statement (bind, run, all). */
class Statement {
  constructor(
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}
  bind(...values: Param[]) {
    return new Statement(this.sql, values);
  }
  execute() {
    const st = sqlite.prepare(this.sql);
    if (st.columns().length) return { results: st.all(...this.params) as unknown[], meta: { last_row_id: 0, changes: 0 } };
    const r = st.run(...this.params);
    return { results: [] as unknown[], meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  }
  async run() {
    return this.execute();
  }
  async all() {
    return this.execute();
  }
}

/** The part of the D1 API the Worker uses: prepare() and batch(), where a batch is one transaction. */
const DB = {
  prepare: (sql: string) => new Statement(sql),
  async batch(statements: Statement[]) {
    sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.execute());
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  },
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Static files from dist/; unknown paths get index.html, like the Worker's single-page-application setting. */
const ASSETS = {
  async fetch(request: Request) {
    const path = normalize(decodeURIComponent(new URL(request.url).pathname)).replace(/^[/\\]+/, '');
    let file = join(DIST, path);
    if (!file.startsWith(DIST) || !(await stat(file).catch(() => null))?.isFile()) file = join(DIST, 'index.html');
    // Files in assets/ have a content hash in their name, so they can be cached for good.
    const cache = file.startsWith(join(DIST, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-cache';
    return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': cache } });
  },
};

// No AI binding: see the note at the top.
const env = { DB, ASSETS } as unknown as Parameters<typeof worker.fetch>[1];

createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(err));
  }
}).listen(PORT, HOST, () => console.log(`Truck Load Optimizer on http://${HOST}:${PORT} (database: ${DB_FILE})`));
