# Truck Load Optimizer: system documentation (company / IT)

This document describes how the Truck Load Optimizer ("Optimasi Muat Truk") is built, how its data is stored and
moved, how it is deployed today and what it needs to run on the company intranet. It is for the IT team that will
host and maintain it. How to use the app is in `public/app-guide.md` and the SOP; this document does not repeat it.

Companion documents:

| Document | Contents |
| --- | --- |
| [engine-algorithm.md](engine-algorithm.md) | The packing engine, step by step, with the code locations |
| [file-reference.md](file-reference.md) | Every file in the repository and what it does |
| [intranet-migration-guide.md](intranet-migration-guide.md) | How to move from Cloudflare to an intranet server, with options and steps |
| [migration-checklist.md](migration-checklist.md) | The same as a tick-box checklist with owners |
| [../deploy/intranet/](../deploy/intranet/) | Reference intranet server (Node.js + SQLite) and IIS, nginx and systemd templates |

Version described: repository `main` at commit `41b964e` (November 2026), database schema version 6.

---

## 1. What the system does

Planners enter a shipment (sales order number, destination, SKUs with quantities, one or more trucks). The app
computes three alternative load plans at the same time ("Bebas", "Standar", "Campuran"), shows them in 3D, checks
each carton for tipping and sliding risk, saves the chosen plan, and prints a loader sheet per truck. Master users
maintain the shared reference data: SKUs (from SAP), truck types, the plate-number register, destinations and the
optimizer rules.

## 2. Architecture in one picture

```
 Browser (each user's PC)                                     Server
 ┌─────────────────────────────────────────────────┐          ┌──────────────────────────────┐
 │ UI (TypeScript, plain DOM, no framework)         │          │ API  src/server/index.ts     │
 │   planner · history · master data · print        │  HTTPS   │   GET  /api/snapshot         │
 │ 3D view (three.js, WebGL)                        │ ───────► │   POST /api/write  {op,args} │
 │ Local SQL copy (sql.js = SQLite in WebAssembly)  │ ◄─────── │   POST /api/unlock           │
 │ Packing engine × 3 in Web Workers                │   JSON   │   POST /api/restore          │
 │ Personal SKUs/rules in localStorage              │          │   POST /api/ask (AI help)    │
 └─────────────────────────────────────────────────┘          │ Database: SQLite (D1 today)  │
                                                               └──────────────────────────────┘
```

The design has four properties that matter for hosting:

1. **The heavy work runs in the browser.** The packing engine (`src/engine/`) runs in three Web Workers on the
   user's PC, one per model, for 2–3 seconds each. The server never computes plans. Server load is a few small
   JSON requests per user action.
2. **The browser keeps a full copy of the database.** At start-up it downloads every table once (`GET
   /api/snapshot`: 165 KB of JSON, 21 KB gzip, for the seed data alone; it grows with every saved plan, see 2.4) into an in-memory SQLite database (sql.js). All reads are local
   SQL queries. There are no read endpoints beyond the snapshot.
3. **Writes are named operations, never SQL from the browser.** The browser sends `{ op: "saveShipment", args:
   [...] }`. The server looks the name up in a fixed table (`WRITES` in `src/db/writes.ts`), checks whether it needs
   the master password (`needsAdmin`), runs it as parameterised SQL, and answers with the rows of the tables that
   operation can change (`TOUCHES`). The browser replaces those tables in its copy.
4. **The same SQL runs in both places.** `src/db/writes.ts` takes a small `Store` interface (`run`, `all`,
   `batch`). The server gives it the shared database; without a server, the browser gives it the local sql.js copy
   (the "local mode", see 2.2). This is why the server can move to another SQLite host without touching app code.

### 2.1 Components

| Component | Technology | Where |
| --- | --- | --- |
| Front end | TypeScript 7 (strict), Vite 8 bundler, no UI framework (a 30-line `h()` element helper) | `src/main.ts`, `src/ui/` |
| 3D view | three.js 0.186 with OrbitControls, WebGL | `src/ui/view3d.ts` |
| Loader sheet | HTML + inline SVG, printed with the browser's print dialog (`@media print` in `styles.css`) | `src/ui/print.ts` |
| Browser database | sql.js 1.15 (SQLite compiled to WebAssembly; pure-JS asm.js fallback) | `src/db/database.ts` |
| Packing engine | Plain TypeScript, no dependencies, deterministic PRNG | `src/engine/` |
| API server (today) | Cloudflare Worker, ~170 lines | `src/server/index.ts` |
| Shared database (today) | Cloudflare D1 (managed SQLite), database `loadoptimizer-db` | `wrangler.jsonc` |
| Help assistant (today) | Cloudflare Workers AI, model `@cf/qwen/qwen3-30b-a3b-fp8` | `src/server/assistant.ts` |
| Tests | Vitest 5: engine, schema migrations, assistant (31 tests) | `tests/` |
| UI language | Bahasa Indonesia, every string in one file | `src/i18n/id.ts` |

Runtime dependencies in the shipped app: `sql.js` and `three` only. No CDN, web font or third-party URL is loaded at
run time (checked: the only `http` strings in `src/` are SVG namespaces), so the app works on a network without
internet access.

### 2.2 Two data modes

`src/db/database.ts` decides the mode at start-up:

| Mode | When | Where data lives | Header tag |
| --- | --- | --- | --- |
| Shared | `GET /api/snapshot` answers with JSON | The server database; the browser holds a copy | "Database bersama" |
| Local | The request fails or answers with non-JSON (a static host returns `index.html` or a 404 page) | IndexedDB of that one browser (`truck-load-optimizer` / `sqlite` / `main`) | "Hanya browser ini" |

Local mode is meant for development and offline demos. **On the intranet it must never be what users see**: if
the API is unreachable or misrouted, each user silently gets a private database seeded from the built-in data, and
their saved plans stay on their PC. The header tag is the check (see the migration checklist).

### 2.3 Request flow of a typical session

1. Browser loads `index.html` and the hashed bundles in `assets/` (about 1.5 MB uncompressed, ~560 KB gzip; the
   1.3 MB `sql-asm` file loads only when WebAssembly is blocked).
2. `GET /api/snapshot`. If the database is empty (`{ "empty": true }`), the first browser builds the seed database
   locally and uploads it with `POST /api/restore` in parts. If the stored schema is older than the code
   (`SCHEMA_VERSION`), the server migrates it during this request.
3. The planner enters a shipment and clicks calculate: three Web Workers run `runShipment()` locally.
4. Save: `POST /api/write {op: "saveShipment"}`. The response carries the new rows of `trucks`, `shipments`,
   `shipment_lines` and `load_plans`.
5. Print: rendered locally, `window.print()`.

Changes made by other users appear after a page reload (the copy is refreshed only for tables touched by your own
writes). Writes are last-writer-wins per row; there is no record locking.

### 2.4 Scaling limit to plan for: the snapshot grows with history

`GET /api/snapshot` returns every row of every table, including `load_plans.result_json`, which holds every
carton's position (about 70 bytes per carton, so roughly 50–110 KB for a CDD-to-semitrailer load). Every page load
downloads all of it, and every save returns the whole `load_plans` table again. With 10 saved trucks a day that is
on the order of 200–300 MB a year. Expect start-up and saving to slow noticeably after a few thousand saved plans.

Remedies, in order of effort: archive old shipments (export, then delete in Riwayat Rencana); or change the snapshot
to leave out `result_json` and fetch one plan's result when it is opened (`repo.planResult()` is the only reader,
plus the training export). The second is a contained code change in `src/server/index.ts`, `src/db/database.ts`
and `src/db/repo.ts`, and the right fix before broad roll-out.

---

## 3. Data

### 3.1 Database schema (version 6)

Defined as plain SQL in `src/db/schema.ts` (`SCHEMA_SQL`), identical in the browser and on the server. Units:
centimetres, kilograms, m³. Times are SQLite `datetime('now','localtime')` text.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `meta` | Key/value settings | `schema_version`, `admin_hash` (master password hash; never sent to browsers), `company_name` |
| `truck_types` | Truck types and one-off trucks | `code` unique, `variant` (Minimum / Rata-rata / Maksimum), `body_type`, `est_volume_*`, `inner_*_cm`, `dims_estimated`, `is_template` (1 = one-off truck saved from the planner) |
| `trucks` | Vehicle register by plate number | `plate_no` unique (normalised: upper case, single spaces), `truck_type_id`, measured `inner_*_cm` |
| `destinations` | Ship-to list from logistics | `ship_to_no` (not unique), `customer`, `city`, `zone`, `vehicle_type_raw` |
| `destination_trucks` | Allowed truck types per destination (largest = maximum) | PK (`destination_id`, `truck_type_id`), cascades |
| `skus` | Cartons, from SAP | `code` unique (SAP material number), outer `length/width/height_cm`, `mod_*_cm` (bulge/shrink adjustment), `safe_stack_layers`, `can_lie_down`, `product_group`, `volume_m3` (generated column), `cbox_code`, `board_grade`, `material_desc` |
| `shipments` | One sales order | `shipment_no` unique index, `is_temp` (draft number TMP-…), `destination_id`, `reference` (planner note). `truck_type_id` and `truck_json` are pre-v6 leftovers; new rows write `'{}'` |
| `shipment_lines` | SKUs and quantities of a shipment | `sku_json` = the SKU exactly as planned (so personal SKUs and later edits do not change old plans), `qty` (NULL = fill max), `position` |
| `load_plans` | One row per truck of a shipment | `truck_seq`, `truck_type_id`, `plate_no` → `trucks.plate_no`, `truck_json` (dimensions used), `model`, `rules_json`, `result_json` (the full plan: every carton position), `status` draft/final/loaded, `actual_json`, `outcome_json` |
| `model_settings` | Shared optimizer rules per model | `model` PK, `rules_json` (fields: `ModelRules` in `src/engine/rules.ts`) |
| `ai_usage` | Assistant cost counter (server only, created on first question) | (`day`, `client`) PK, `questions`, `neurons` |

Relationships: `destination_trucks` and `shipment_lines`/`load_plans` cascade on delete of their parent; links to
truck types, destinations and plates are `ON DELETE SET NULL`. Every saved plan keeps its own copy of the truck size
and SKU data, so plans stay reproducible after master data changes.

### 3.2 Migrations

`MIGRATIONS` in `src/db/schema.ts` upgrades one version at a time (2→3 … 5→6). The server runs them inside
`GET /api/snapshot` when the stored `schema_version` is lower than the code's `SCHEMA_VERSION`, each version as one
transaction. Migrations add columns instead of rebuilding tables, because D1 keeps `ON DELETE CASCADE` active during
migrations and a rebuilt `shipments` table would delete every plan. Tests (`tests/schema.test.ts`) migrate a v5
fixture and compare the result with a fresh v6 database.

When adding a migration: bump `SCHEMA_VERSION`, add `MIGRATIONS[old]`, update `SCHEMA_SQL`, add a test. Back up the
database file before deploying it.

### 3.3 Seed data

A new, empty database is filled on first visit from code: 12 truck types (expanded to 26 entries by splitting
volume ranges into Minimum / Rata-rata / Maksimum), 161 destinations (`data/destinations.tsv` → `seed-destinations.ts`),
281 SAP SKUs (`data/skus.tsv` → `seed-skus.ts`, parsed by `src/db/material.ts`) and the default model rules.

Known data gaps (also in `README.md`): truck inner dimensions are estimates except ISO containers; SKU weights are not
in the SAP data (weight-based rules therefore have little effect); 10 SKUs have non-standard material descriptions
and are flagged.

### 3.4 Data that lives only in the browser

| Key | Store | Content |
| --- | --- | --- |
| `tlo-personal-skus` | localStorage | A user's own SKUs and SKU edits (not shared until a master publishes them) |
| `tlo-personal-rules` | localStorage | A user's own model rules |
| `tlo-admin-unlocked` | sessionStorage | The master password hash while unlocked (this tab only) |
| `tlo-theme`, `tlo-3d-labels`, `tlo-print-mode` | localStorage | Display preferences |
| `tlo-ai-client` | localStorage | Random id for the assistant's per-person daily limit |
| IndexedDB `truck-load-optimizer` | IndexedDB | The whole database, local mode only |

These are per browser profile and per host name: moving the app to a new address starts every user with empty
personal SKUs and rules. Tell users to publish or note anything they need before the switch.

### 3.5 Backup, export and training data

- **Backup on the intranet:** copy the SQLite file (use `sqlite3 file ".backup out.sqlite"` or stop the service
  first; the file runs in WAL mode). Daily, keep 30 days.
- **In-app export:** Data Master › Database › "Unduh file database (.sqlite)" downloads the browser's copy: every
  table except `admin_hash` and `ai_usage`. "Muat file database" (master only) replaces all server data with a file;
  the server keeps its master password. This is the tested migration path (guide, section 4).
- **Training export:** Riwayat Rencana exports one CSV row per saved plan (`src/db/training.ts`) for model training
  outside the app.

---

## 4. API reference

All endpoints are under `/api/` on the same host as the app. Responses are JSON with `cache-control: no-store`.
Errors: `{ "error": "<message>" }` with status 400, 403, 404, 405, 429, 500, 502 or 503.

| Endpoint | Body | Auth | Answer |
| --- | --- | --- | --- |
| `GET /api/snapshot` | – | none | `{ empty: true }` before set-up, else `{ tables: {<table>: rows[]}, adminSet: bool }`; runs pending migrations |
| `POST /api/write` | `{ op, args: [] }` | `X-Admin-Key` for master operations | `{ result, tables }` (tables in `TOUCHES[op]`) |
| `POST /api/unlock` | – | `X-Admin-Key` | `{ ok: true }` or 403 |
| `POST /api/restore` | `{ reset: true }` then `{ tables }` parts | none before set-up, then `X-Admin-Key` | `{ ok: true }`; rejects a schema version mismatch |
| `POST /api/ask` | `{ question, history, page }`, header `X-Client-Id` | none | `{ answer, remaining }`; 429 at limits; 503 without an AI binding |

Write operations (`src/db/writes.ts`):

| Operation | Needs master password |
| --- | --- |
| `saveShipment`, `updatePlanTracking`, `deleteShipment` | No (planner work) |
| `saveTruck` for a new one-off truck (`is_template = 1`, no id) | No |
| `setMeta('admin_hash', …)` when no password exists yet | No (the first user creates it) |
| `saveTruck` (other), `deleteTruck`, `saveDestination`, `deleteDestination`, `saveSku`, `upsertSku`, `upsertSkus`, `deleteSku`, `saveRules`, `setMeta`, `saveVehicle`, `deleteVehicle` | Yes |

Limits built in for D1 and harmless elsewhere: at most 100 bound values per statement (`D1_MAX_PARAMS`), restore
parts of about 20 INSERTs, SKU uploads in chunks of 200.

---

## 5. Security model (read before go-live)

The access control is a prototype "edit lock", not user authentication. The help text in the app says so.

| Item | How it works | Risk on the intranet | Recommendation |
| --- | --- | --- | --- |
| Master password | Browser computes `SHA-256("truck-load-optimizer:" + password)` and sends the hex digest as `X-Admin-Key`; server compares it with `meta.admin_hash` | The digest is the credential (anyone holding it is master); fast unsalted hash; no rate limit on `/api/unlock`; one shared password, no names | Put the site behind company sign-on (IIS Windows Authentication, or SSO at the reverse proxy). Keep the master password for the few data owners. |
| First password | On a database without `admin_hash`, the first person to click the lock sets it | Whoever opens a fresh deployment first becomes master | Set the master password yourself right after deployment, before announcing the URL |
| Planner writes | Saving, tracking and **deleting** shipments needs no password | Anyone who can reach the site can delete any saved shipment | Restrict access at the proxy; back up daily |
| Identity / audit | None: rows carry times, not users | No record of who changed what | If needed, have the proxy log `/api/write` requests with the signed-in user |
| SQL injection | Browser sends operation names and values only; SQL is fixed in `writes.ts`; table names come from a constant list | Low | – |
| Secrets in the browser | `admin_hash` is excluded from every snapshot (`SECRET_META`) | – | – |
| HTTPS | Required: `crypto.subtle` (the password hash) only exists on HTTPS pages or `http://localhost` | On plain HTTP the lock fails with "Cannot read properties of undefined (reading 'digest')" (verified) | Serve over HTTPS with a certificate from the company CA |
| Assistant | Gets only `public/app-guide.md`, no data, no tools | – | Disabled on the intranet unless an internal LLM is connected |

---

## 6. Build, test and deploy today (Cloudflare)

Requirements: Node.js `^20.19` or `>=22.12` (Vite 8), npm. Commands:

```bash
npm ci              # install exact versions from package-lock.json
npm test            # vitest: 31 tests
npm run build       # tsc --noEmit (type check), then vite build -> dist/
npx wrangler dev    # local Worker + local D1 (wrangler is not a devDependency; npx downloads it)
```

`dist/` after a build (sizes from the current build):

| File | Size | Gzip | Loaded |
| --- | --- | --- | --- |
| `index.html` | 0.9 KB | | always |
| `app-guide.md` | 22 KB | | by the assistant |
| `assets/index-*.js` | 808 KB | 217 KB | always (app + three.js + sql.js loader) |
| `assets/index-*.css` | 33 KB | 7 KB | always |
| `assets/worker-*.js` | 13 KB | | per calculation, 3 workers |
| `assets/sql-wasm-*.wasm` | 685 KB | 339 KB | always |
| `assets/sql-asm-*.js` | 1.34 MB | 484 KB | only when WebAssembly is blocked |

Deployment: Cloudflare builds `main` and deploys the Worker `loadoptimizer` (`wrangler.jsonc`), which serves `dist/`
as static assets (single-page fallback) and runs `src/server/index.ts` first for `/api/*`. Bindings: `DB` → D1
`loadoptimizer-db`, `AI` → Workers AI. Pull-request previews use a separate D1 database (`loadoptimizer-db-preview`).

---

## 7. Intranet deployment summary

The full plan is in [intranet-migration-guide.md](intranet-migration-guide.md). In short:

- **Recommended:** one small Node.js service ([`deploy/intranet/server.ts`](../deploy/intranet/server.ts), ~100
  lines) runs the unchanged API code from `src/server/index.ts` against a SQLite file and serves `dist/`. IIS or nginx
  in front provides HTTPS and, ideally, company sign-on. No change to the app code. Tested end to end: seeding,
  planning with the three workers, master unlock, and moving data with the export/import buttons.
- **Must have:** HTTPS; the app at the root of its own host name (it calls `/api/...` with absolute paths);
  `application/wasm` served for `.wasm`; a daily backup of the database file.
- **Changes in behaviour:** the "Tanya AI" assistant is off (no Workers AI); `datetime('now','localtime')` becomes
  the server's time zone (D1 used UTC), so new timestamps will be WIB while migrated ones stay UTC.

## 8. Client requirements

A current Chromium-based Edge or Chrome (2021 or later), or Firefox 114+ / Safari 15.4+: module Web Workers,
WebAssembly (with fallback), WebGL for the 3D view, the `<dialog>` element, and a secure context (HTTPS). A plan
takes the model's search time (2–3 s) on each of three CPU threads, so a PC with 4+ logical cores is comfortable.
Printing uses the browser print dialog; A4.

## 9. Operations

| Task | How |
| --- | --- |
| Check health | Open the app: the header must show "Database bersama". `GET /api/snapshot` returns JSON. |
| Update the app | Pull, `npm ci`, `npm test`, `npm run build:intranet`, restart the service. Migrations run on the first request. |
| Reset a lost master password | Stop the service; `sqlite3 <db> "DELETE FROM meta WHERE key='admin_hash'"`; start; set a new one at once |
| Update the SAP SKU list | Master: Data Master › SKU › "Impor dari Excel" (paste SAP rows; existing codes are updated) or edit `data/skus.tsv` + `seed-skus.ts` for new installations |
| Change what the assistant knows | Edit `public/app-guide.md` and redeploy |
| Logs | The Node service logs to stdout (journald / NSSM log); the proxy logs requests |
