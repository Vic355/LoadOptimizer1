# File reference

Every file in the repository, grouped by layer. Line counts are from commit `41b964e`. "Intranet" says what happens to
the file when the app moves off Cloudflare (see [intranet-migration-guide.md](intranet-migration-guide.md)).

About 8,400 lines of TypeScript and CSS in total: UI ~3,900, database ~1,950 (of which ~450 are seed data), engine
~1,190, server ~310, tests ~480.

## Root

| File | Lines | What it is | Intranet |
| --- | ---: | --- | --- |
| `README.md` | 59 | Overview, run commands, structure, known data gaps, units | Keep |
| `package.json` | 25 | Scripts (`dev`, `build`, `build:intranet`, `start:intranet`, `test`) and dependencies: `sql.js`, `three`; dev: TypeScript 7, Vite 8, Vitest 5, type packages | Keep |
| `package-lock.json` | 1570 | Exact dependency versions; `npm ci` installs from it | Keep (needed for reproducible offline builds) |
| `tsconfig.json` | 16 | Strict TypeScript, ES2022, DOM + WebWorker libs; type-checks `src` and `tests` | Keep |
| `vite.config.ts` | 8 | Relative base `./`, target ES2020, ES-module workers | Keep |
| `index.html` | 14 | The one HTML page; loads `src/main.ts`; inline SVG favicon | Keep |
| `wrangler.jsonc` | 32 | Cloudflare Worker config: name `loadoptimizer`, static assets from `dist/` with SPA fallback, `/api/*` to the Worker first, bindings `DB` (D1 `loadoptimizer-db`), `AI`; preview database for PRs | Not used on the intranet; keep while Cloudflare runs |
| `.gitignore` | 5 | `node_modules`, `dist`, `.wrangler`, `build-server`, `storage/` | Keep |

## `src/` entry and shared

| File | Lines | What it is |
| --- | ---: | --- |
| `src/main.ts` | 93 | Boot: applies the theme, opens the database (shared or local), builds the header (nav, AI button, lock, theme), creates the three pages and switches between them |
| `src/styles.css` | 546 | All styles: light/dark themes via `data-theme`, layout, dialogs, the print stylesheet for the loader sheet (`@media print`) |
| `src/i18n/id.ts` | 518 | Every user-facing string (Bahasa Indonesia), including plural helpers and rule descriptions |
| `src/sqljs-asm.d.ts` | 5 | Type declaration for the asm.js build of sql.js (fallback when WebAssembly is blocked) |

## `src/db/`: data layer (runs in the browser; `schema`, `snapshot`, `writes` also on the server)

| File | Lines | What it is |
| --- | ---: | --- |
| `schema.ts` | 243 | `SCHEMA_VERSION` (6), `SCHEMA_SQL` (all tables), `MIGRATIONS` 2→6, the truck-size split and the SAP SKU insert used by seed and migration |
| `database.ts` | 303 | Opens sql.js (WASM, falls back to asm.js); detects shared vs local mode; loads the server snapshot; `query()` for reads; `write()` sends named operations to `/api/write` (or runs them locally); IndexedDB persistence in local mode; export/import/reset; master-key handling |
| `snapshot.ts` | 61 | Table list in foreign-key order, `insertStatements()` (multi-row INSERTs within 100 parameters), `splitSql()`, `restoreParts()` (upload in ~20-INSERT parts), `SECRET_META = 'admin_hash'` |
| `writes.ts` | 227 | Every change as a named operation (`WRITES`): trucks, destinations, SKUs (single and bulk upsert), rules, meta, shipments with per-truck plans, plan tracking, vehicles. `TOUCHES` (tables each op changes), `needsAdmin()` (which ops need the master password), plate normalisation |
| `repo.ts` | 348 | Typed read queries and thin wrappers around `write()`; merges personal SKUs/rules over the shared ones; converts DB rows to engine inputs (`toEngineSku`, `toEngineTruck`) |
| `personal.ts` | 103 | Personal SKUs and SKU edits, personal model rules, in `localStorage` |
| `material.ts` | 105 | Parses SAP material descriptions (`CCBOX;STD,PPSB,355L,215W,175H,K150/M150/`) into size in cm, carton code and board grade, flags malformed rows; guesses product group from the name; default safe stack (250 cm ÷ carton height) |
| `training.ts` | 57 | CSV export of saved plans and their outcomes, for training a model outside the app |
| `seed.ts` | 38 | Fills a new database: truck types, size variants, destinations with allowed trucks, SAP SKUs, default rules |
| `seed-data.ts` | 52 | The 12 base truck types with estimated inner sizes; vehicle-name aliases for the destination list |
| `seed-destinations.ts` | 165 | 161 destinations, generated from `data/destinations.tsv` |
| `seed-skus.ts` | 285 | 281 SAP SKUs, generated from `data/skus.tsv` |

## `src/engine/`: packing engine (pure TypeScript, runs in Web Workers)

Algorithm details: [engine-algorithm.md](engine-algorithm.md).

| File | Lines | What it is |
| --- | ---: | --- |
| `index.ts` | 11 | Public exports; `MODEL_ORDER` = free, standard, mixed |
| `types.ts` | 139 | Engine types: SKU, line, truck, request, placed box, tier, stability report, plan and shipment results |
| `rules.ts` | 110 | `ModelRules`, physics defaults (EN 12195-1), `DEFAULT_RULES` for the three models, `withDefaults()` |
| `worker.ts` | 21 | Web Worker wrapper: receives `{model, req}`, posts progress and the result |
| `shipment.ts` | 41 | `runShipment()`: plans truck after truck until fixed quantities are loaded (max 30 trucks) |
| `models.ts` | 92 | `runModel()` and the time-boxed randomised `search()`; safety-first scoring; door-side mirroring; pseudo-tiers for open loads |
| `tiers.ts` | 305 | Tier builder: orientation ranking, interlocking row patterns, one tier with fillers and safety pass, solid wall height |
| `blocks.ts` | 139 | Guillotine block-building heuristic for free spaces (fillers, open loads) |
| `common.ts` | 157 | Orientations, stack limit, mulberry32 PRNG, loading sequence, support fraction, tier grouping, `summarise()`, `planScore()` |
| `stability.ts` | 148 | Tip / slide / overhang check per carton; `maxStep()`, `pushAlongX()` |
| `pose.ts` | 25 | Carton pose A–F (which face up, which to the door) for the loader sheet |

## `src/server/`: API (Cloudflare Worker today; Node on the intranet via `deploy/intranet/server.ts`)

| File | Lines | What it is | Intranet |
| --- | ---: | --- | --- |
| `index.ts` | 150 | The Worker: static files via `ASSETS`, `/api/snapshot`, `/api/write`, `/api/unlock`, `/api/restore`, `/api/ask`; migrations; admin check. Uses only `env.DB.prepare/batch` and `env.ASSETS.fetch` | Unchanged; the Node server supplies `DB` and `ASSETS` |
| `assistant.ts` | 157 | "Tanya AI": builds the prompt from `public/app-guide.md`, calls Workers AI (`env.AI.run`), daily limits stored in `ai_usage` | Off (no `AI`); can be pointed at an internal LLM |

## `src/ui/`: screens (browser only)

| File | Lines | What it is |
| --- | ---: | --- |
| `planner.ts` | 1474 | The planning page: shipment number and saved-shipment search, destination, SKU lines (search, paste, reorder), truck slots with plate numbers, starting the three workers, progress overlay, model comparison, 3D view controls, summary, details, save, print |
| `master.ts` | 696 | Data Master: tables and forms for SKUs (with Excel paste import), truck types, plate numbers, destinations, model rules (shared and personal), database export/import/reset, company name |
| `print.ts` | 519 | Loader sheet: per truck an overview page (isometric drawing or the 3D snapshot), tier strips with counts, pose pictograms, signature boxes; colour or grayscale ink mode |
| `view3d.ts` | 342 | three.js scene: truck outline, cartons coloured by SKU, tier or risk, size labels, click-to-pick, snapshot for printing |
| `history.ts` | 247 | Riwayat Rencana: list and filter saved plans, status, actual counts per tier, outcome, reprint, training CSV |
| `assistant.ts` | 114 | The "Tanya AI" side panel; sends only the question, recent turns and page name |
| `sku-form.ts` | 107 | SKU create/edit dialog (personal, or shared for the master) |
| `admin.ts` | 95 | Master lock: password dialog, SHA-256 hash, keeps the hash in sessionStorage |
| `combobox.ts` | 77 | Accessible search-as-you-type picker used for shipments, destinations and SKUs |
| `dom.ts` | 67 | `h()` and `svg()` element builders, Indonesian number formats, debounce, confirm dialog |
| `theme.ts` | 45 | Light/dark mode |
| `rules-text.ts` | 17 | Plain-language list of a model's rules |
| `colors.ts` | 6 | SKU and tier colour palettes |

## `public/`

| File | Lines | What it is |
| --- | ---: | --- |
| `app-guide.md` | 165 | User guide; the only source the assistant answers from; copied to `dist/` as is |

## `data/`

| File | Lines | What it is |
| --- | ---: | --- |
| `destinations.tsv` | 162 | Destination list as supplied by logistics (ship-to, customer, city, vehicle type, zone) |
| `skus.tsv` | 282 | SAP SKU list as supplied (SKU, description, carton number, material description) |

## `tests/` (Vitest)

| File | Lines | What it tests |
| --- | ---: | --- |
| `engine.test.ts` | 267 | Packing invariants, model behaviour, stability, physics, multi-truck shipments, poses, SAP parsing |
| `schema.test.ts` | 99 | Migrations 4→5 and 5→6 on fixtures; D1 statement limits; migrated schema equals fresh schema |
| `assistant.test.ts` | 110 | Assistant prompt, answer parsing, daily limits, budget reservation and refund |
| `fixtures/schema-v5.sql` | 106 | The released v5 schema, for the migration test |

## `docs/` and `deploy/` (added with this documentation)

| File | What it is |
| --- | --- |
| `docs/README.md` | Index of the documentation |
| `docs/system-documentation.md` | System documentation for company IT |
| `docs/engine-algorithm.md` | Packing engine reference |
| `docs/file-reference.md` | This file |
| `docs/intranet-migration-guide.md` | Migration options and step-by-step plan |
| `docs/migration-checklist.md` | Tick-box checklist |
| `deploy/intranet/server.ts` | Reference Node.js server: the Worker API on a SQLite file, serves `dist/` |
| `deploy/intranet/web.config` | IIS reverse proxy template (URL Rewrite + ARR), MIME types |
| `deploy/intranet/nginx.conf` | nginx reverse proxy template with HTTPS |
| `deploy/intranet/loadoptimizer.service` | systemd unit template |

## Generated, not in the repository

| Path | From |
| --- | --- |
| `dist/` | `npm run build`: `index.html`, `app-guide.md`, `assets/*` with content hashes |
| `build-server/server.js` | `npm run build:intranet`: the bundled Node server (~76 KB) |
| `storage/loadoptimizer.sqlite` (+ `-wal`, `-shm`) | Created by the Node server on first start; this is the company's data |
| `.wrangler/` | Local state of `wrangler dev` |
