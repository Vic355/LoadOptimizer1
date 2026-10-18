# Truck Load Optimizer (prototype shell)

Web app for planning carton loads per truck, tier by tier. UI in Bahasa Indonesia, code in English.

## Run

```bash
npm install
npm run dev      # local dev server
npm test         # engine tests (vitest)
npm run build    # static files in dist/, host anywhere (Cloudflare Pages, intranet IIS/nginx)
```

## Structure

| Path | What it is |
| --- | --- |
| `src/db/schema.ts` | SQLite schema (trucks, destinations, allowed trucks per destination, SKUs, shipments, saved plans) |
| `src/db/seed.ts`, `seed-destinations.ts` | Seed data: truck types, 161 destinations from logistics, 12 dummy SKUs |
| `src/db/database.ts` | sql.js (SQLite in WebAssembly) persisted to IndexedDB; export/import `.sqlite` |
| `src/db/repo.ts` | All queries. Replace this module with HTTP calls to move to a server database (D1, intranet SQL) |
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
