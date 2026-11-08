# Intranet migration guide

How to move the Truck Load Optimizer from Cloudflare (public web) to a server on the company network. Written for the
IT team that will do it, with the app owner. The tick-box version is [migration-checklist.md](migration-checklist.md).

## 1. What runs on Cloudflare today, and what replaces it

| Today (Cloudflare) | Purpose | On the intranet |
| --- | --- | --- |
| Worker `loadoptimizer` running `src/server/index.ts` | API under `/api/*` | The same file, run by Node.js through `deploy/intranet/server.ts` |
| Workers static assets (`dist/`, SPA fallback) | Serves the app | The same Node service (or IIS/nginx directly) |
| D1 database `loadoptimizer-db` | Shared data | A SQLite file on the server (`storage/loadoptimizer.sqlite`) |
| Workers AI binding `AI` | "Tanya AI" help assistant | Off by default; optional internal LLM (section 7) |
| Cloudflare TLS certificate | HTTPS | Certificate from the company CA on IIS or nginx |
| Cloudflare build from GitHub `main` | Deploy on merge | Manual or internal CI build (section 5) |

Everything the browser does (planning engine, 3D, printing, local SQL copy) stays the same: it is static files.

## 2. Options considered

| Option | What it is | Verdict |
| --- | --- | --- |
| A. Static files only on IIS/nginx | Copy `dist/` to a web server, no API | **Not for production.** The app falls back to "Hanya browser ini": every PC has its own database in the browser, nothing is shared, plans are lost when a browser profile is cleared. Fine for a demo. |
| B. Node.js service + SQLite file (recommended) | `deploy/intranet/server.ts` runs the unchanged Worker code with a D1-compatible adapter over Node's built-in `node:sqlite`, behind IIS or nginx | **Recommended.** No app code changes, one process, one data file, tested end to end. Fits the load (a few small JSON requests per user action; planning runs on the PCs). |
| C. Self-hosted Workers runtime (`workerd`/Miniflare) | Run the Worker as on Cloudflare | Possible, but D1 is not part of open-source `workerd`, and Miniflare is a development tool. More moving parts than B for no gain. |
| D. Rewrite the API for SQL Server/PostgreSQL | Port the ~15 named operations in `src/db/writes.ts` to the company's database server | Only if IT policy forbids SQLite files. The SQL is portable SQLite; the changes are mostly `datetime('now','localtime')`, `ON CONFLICT … DO UPDATE` upserts, `AUTOINCREMENT` and the generated `volume_m3` column. Estimate days, not hours, plus re-testing. |

The rest of this guide describes option B.

## 3. Requirements

**Server:** Windows Server 2019+ or any current Linux; Node.js 22.13 or later (22 LTS or 24 LTS) for the built-in
`node:sqlite` module (Node 22 prints an "ExperimentalWarning: SQLite is an experimental feature" line at start-up;
it is harmless); 1 vCPU, 1 GB RAM and a few GB of disk are plenty; IIS 10 with URL Rewrite and Application Request
Routing, or nginx, for HTTPS.

**Network and naming:**

- **HTTPS is required.** The master-password lock hashes the password with the browser's Web Crypto API
  (`crypto.subtle`), which browsers only provide on HTTPS pages or `http://localhost`. Over plain HTTP the app loads
  and plans fine, but "Masuk sebagai master" fails with *Cannot read properties of undefined (reading 'digest')*
  (reproduced while preparing this guide). Use a certificate from the company CA that the PCs already trust.
- **Give the app its own host name** (for example `https://muat.intranet.example/`). The page itself works from any
  folder (`base: './'` in `vite.config.ts`), but the API calls use absolute paths (`/api/...`) and the server reads
  `/app-guide.md`. Hosting under a sub-folder of another site (`https://intranet/apps/muat/`) needs the code
  change in section 8.
- No internet access is needed at run time: the app loads no CDN, font or external script.

**Build machine:** Node.js and access to the npm registry (or a company mirror) to run `npm ci`. If the server has
no registry access, build elsewhere and copy the output (section 5).

**Browsers:** current Edge or Chrome; Firefox 114+, Safari 15.4+. WebAssembly may be blocked by policy; the app then
loads a slower pure-JavaScript SQLite build automatically.

## 4. Step by step

### 4.1 Build

```bash
git clone https://github.com/vic355/loadoptimizer1.git
cd loadoptimizer1
npm ci
npm test                    # 31 tests must pass
npm run build:intranet      # = npm run build (type check + dist/) + bundle deploy/intranet/server.ts -> build-server/server.js
```

Output to deploy: `dist/` (the app) and `build-server/server.js` (one ~76 KB file; it has no `node_modules`
dependencies at run time).

### 4.2 Install on the server

Copy `dist/` and `build-server/` to the server, e.g. `C:\apps\loadoptimizer\` or `/opt/loadoptimizer/`. Create the
data folder, writable by the service account only (`storage\` or `/var/lib/loadoptimizer/`).

Try it by hand first:

```bash
# Linux
PORT=8080 DB_FILE=/var/lib/loadoptimizer/loadoptimizer.sqlite node build-server/server.js
# Windows (PowerShell)
$env:PORT=8080; $env:DB_FILE="C:\apps\loadoptimizer\storage\loadoptimizer.sqlite"; node build-server\server.js
```

It prints `Truck Load Optimizer on http://127.0.0.1:8080 (database: …)`. It listens on 127.0.0.1 only; IIS or nginx
on the same machine forwards to it. `GET http://127.0.0.1:8080/api/snapshot` returns `{"empty":true}` until the
first browser visit.

Run it as a service:

- **Linux:** `deploy/intranet/loadoptimizer.service` (systemd template).
- **Windows:** wrap `node.exe C:\apps\loadoptimizer\build-server\server.js` as a service with the company's usual
  tool (NSSM, WinSW, or a scheduled task at start-up), set `PORT`, `DB_FILE` and `DIST_DIR`, restart on failure.

### 4.3 Reverse proxy with HTTPS

- **IIS:** create a site bound to `https://muat.intranet.example` with the company certificate, copy
  `deploy/intranet/web.config` into its folder, install URL Rewrite + ARR and enable the ARR proxy. Optional but
  recommended: turn on Windows Authentication for the site, so only signed-in staff reach it.
- **nginx:** `deploy/intranet/nginx.conf`.

Check: open the site from a user PC. The header must show **"Database bersama"**. If it shows "Hanya browser ini",
the browser could not reach `/api/snapshot` as JSON: check the proxy rule.

### 4.4 First start and the master password

The first browser that opens an empty database builds the seed data and uploads it. The first person to click the
lock button on a database without a password **creates** the master password. So, before telling anyone the URL:

1. Open the site, wait for the planner page.
2. Click "🔒 Pengguna", set the master password, confirm the lock shows "🔓 Master".

### 4.5 Move the data from Cloudflare

**Tested path, using the app's own buttons:**

1. On the current Cloudflare app, unlock as master, go to Data Master › Database, click **"Unduh file database
   (.sqlite)"**. The file holds every table except the master password hash and the AI usage counter.
2. On the intranet app (after 4.4), unlock as master, Data Master › Database › **"Muat file database"**, choose the
   file. The server replaces all data and keeps its own master password.
3. Reload. Compare the counts on the Database tab (SKU, Tipe truk, Nomor polisi, Shipment, Tujuan, Rencana) with
   the Cloudflare app, and open two or three saved plans.

This was rehearsed between two instances of the intranet server: counts and settings (company name) arrived, and
the target kept its own password.

**Alternative from the command line** (not rehearsed): `npx wrangler d1 export loadoptimizer-db --remote
--output=d1.sql`, then `sqlite3 storage/loadoptimizer.sqlite < d1.sql` on an empty file before first start. This
also copies the master password and `ai_usage`. Check the generated `volume_m3` column and the row counts afterwards.

Freeze changes on Cloudflare during the move (tell planners not to save for the hour), or repeat the export right
before switch-over.

### 4.6 Backups

The whole company dataset is the one SQLite file. Back it up daily with a consistent copy:

```bash
sqlite3 /var/lib/loadoptimizer/loadoptimizer.sqlite ".backup '/backup/loadoptimizer-$(date +%F).sqlite'"
```

(or stop the service and copy `loadoptimizer.sqlite` together with its `-wal` and `-shm` files). Keep 30 days.
Restore = stop service, put the file back, start. The in-app "Unduh file database" is a second, manual backup.

### 4.7 Switch-over and clean-up

1. Announce the new address; ask users to publish or write down personal SKUs and personal rules (they are stored
   per browser and per address, so they do not move).
2. Keep the Cloudflare app read-only for a few weeks as a fallback, then delete the Worker and the D1 databases (the
   production and the preview one) in the Cloudflare dashboard.
3. If the GitHub repository keeps the Cloudflare build connected, disconnect it, or keep `wrangler.jsonc` as is
   until Cloudflare is retired.

## 5. Updating the app later

```bash
git pull && npm ci && npm test && npm run build:intranet
# back up the database file, copy dist/ and build-server/ to the server, restart the service
```

Database migrations run automatically on the first `/api/snapshot` after an update. Users get the new version on
their next page load: `index.html` is served with `no-cache`, and the files in `assets/` have content hashes.

## 6. What behaves differently on the intranet

| Item | Cloudflare | Intranet |
| --- | --- | --- |
| Timestamps (`created_at`, `updated_at`) | `datetime('now','localtime')` on D1 = UTC | The server's time zone (WIB if the server is set to Asia/Jakarta). Migrated rows stay UTC: up to 7 hours apart from new ones. Set the server time zone deliberately. |
| "Tanya AI" | Answers from the guide | Shows as offline (the API answers 503) unless section 7 is done |
| Personal SKUs/rules, theme, print mode | In the browser for the old address | Start empty at the new address |
| PR previews | Separate preview database per PR | None (use a test instance with its own `DB_FILE`) |
| Who can reach it | Anyone with the link | Company network only; add sign-on at the proxy |

## 7. Optional: the help assistant on an internal LLM

`src/server/assistant.ts` only needs an object with `run(model, { messages, max_tokens, temperature })` that returns
either `{ response: string }` or the OpenAI chat-completions shape `{ choices: [{ message: { content } }], usage }`.
To use an internal OpenAI-compatible server (vLLM, Ollama, Azure OpenAI on a private endpoint), add an `AI` object to
`env` in `deploy/intranet/server.ts` that POSTs the messages to that endpoint and returns its JSON, and change
`AI_MODEL` to that server's model name. The daily limits and the neuron counter then only limit volume; their
numbers are tuned for Cloudflare's free tier. The assistant never receives app data, only `public/app-guide.md`.

## 8. If the app must live under a sub-folder

Change these four absolute paths to relative ones, then rebuild:

| File | Now | Change to |
| --- | --- | --- |
| `src/db/database.ts` (`api()`) | `` fetch(`/api/${path}`) `` | `` fetch(`./api/${path}`) `` |
| `src/db/database.ts` (`checkAdminKey`) | `fetch('/api/unlock')` | `fetch('./api/unlock')` |
| `src/ui/assistant.ts` | `fetch('/api/ask')` | `fetch('./api/ask')` |
| `src/server/index.ts` | `path.startsWith('/api/')` | strip the folder prefix first, or let the proxy strip it |

`src/server/assistant.ts` reads `/app-guide.md` through `ASSETS`, which the Node server resolves inside `dist/`, so
it needs no change when the proxy strips the prefix. A separate host name avoids all of this.

## 9. Known limits to plan for

- **The start-up snapshot grows with saved plans** (each plan stores every carton position, and the browser downloads
  all tables at start). See system documentation 2.4; the fix is to load plan results on demand.
- **Access control is an edit lock, not user accounts** (system documentation 5): one shared master password,
  planner actions including deleting shipments need no password. Put company sign-on in front.
- **No live updates between users**: others' changes appear on reload.
- **SQLite is single-writer**: fine for tens of planners; writes are short transactions and the server waits up to
  5 s for a lock (`busy_timeout`).

## 10. Questions for IT to answer before starting

1. Windows (IIS) or Linux (nginx) server? Is Node.js 22+ allowed as a service?
2. Host name and certificate (company CA) for the app.
3. Should access require Windows/SSO sign-on? Who may be master?
4. Backup location and retention for one SQLite file; is SQLite acceptable, or is a database server mandatory
   (option D)?
5. Where builds happen: does the build machine reach the npm registry or a mirror?
6. Server time zone.
7. Is an internal LLM available for the help assistant, or should it stay off?
