# Truck Load Optimizer (prototype shell)

Web app for planning carton loads per truck, tier by tier. UI in Bahasa Indonesia, code in English.

## Run

```bash
npm install
npm run dev      # local dev server
npm test         # engine tests (vitest)
npm run build    # static files in dist/, host anywhere (Cloudflare Pages, intranet IIS/nginx)
npx wrangler dev # the app with the Worker API and a local D1 database
```

## Shared database (Cloudflare D1)

Cloudflare deploys `main` as the Worker `loadoptimizer` (`wrangler.jsonc`): it serves `dist/` and the API in
`src/server/index.ts`, bound to the D1 database `loadoptimizer-db` as `DB`. The browser loads all tables at start,
queries its own sql.js copy, and sends each change as a named operation (`src/db/writes.ts`); the server checks the
master password hash for master-data changes. A new, empty D1 database is filled with the seed data on the first
visit, and the server applies `MIGRATIONS` when `SCHEMA_VERSION` goes up. Without the Worker (`npm run dev`, a plain
static host) the app falls back to a database in the browser and the header shows "Hanya browser ini".

## Help assistant ("Tanya AI")

The ✦ Tanya AI button opens a read-only assistant that explains the app. It answers only from `public/app-guide.md`
(edit that file to change what it knows), gets no app data and no tools, so it cannot change data or access. The Worker
calls Cloudflare Workers AI (binding `AI`, model in `src/server/assistant.ts`) and counts every question in D1
(`ai_usage`) with a deliberately high neuron estimate: at most 15 questions per browser and 6,000 estimated neurons per
day per database, so production and PR previews together stay inside the free 10,000 neurons a day.

## Structure

| Path | What it is |
| --- | --- |
| `src/db/schema.ts` | SQLite schema (trucks, destinations, allowed trucks per destination, SKUs, shipments, saved plans) |
| `src/db/seed.ts`, `seed-destinations.ts` | Seed data: truck types, 161 destinations from logistics, 12 dummy SKUs |
| `src/db/database.ts` | sql.js (SQLite in WebAssembly): a copy of the shared D1 data, or a local database in IndexedDB without a server; export/import `.sqlite` |
| `src/db/repo.ts` | All queries; changes go through `writes.ts` |
| `src/db/writes.ts`, `snapshot.ts` | Every change as a named operation, run by the Worker on D1 (or locally); table rows as JSON |
| `src/server/index.ts` | Cloudflare Worker: static files plus `/api` on D1 |
| `src/server/assistant.ts`, `public/app-guide.md` | Help assistant (`/api/ask`) and the guide it answers from |
| `src/engine/` | Packing engine, runs in a Web Worker: `standard.ts` (one SKU per tier), `models.ts` (free and mixed, block building + randomised search), `blocks.ts` (guillotine block builder) |
| `src/ui/` | Planner screen (input, model cards, 3D view, summary, details), master data CRUD, print sheet |
| `src/i18n/id.ts` | Every user-facing string |
| `data/destinations.tsv` | Raw destination list as supplied |

## Known data gaps

- Truck inner dimensions are estimates derived from the cubic-volume ranges (except ISO 20'/40' containers). Replace with tape-measured values in Data Master.
- "Split MT" has no volume or dimensions yet.
- "Tronton Built Up-70" is kept separate from "Big Semitrailer Zone 1" (both 70 m³) until confirmed they are the same vehicle.
- SKUs are dummies (`DUM-xxx`).

## Units and axes

Centimetres and kilograms. Engine x runs from the cab (0) to the door, y across the width, z up from the floor.
