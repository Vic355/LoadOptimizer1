# Intranet migration checklist

Tick-box version of [intranet-migration-guide.md](intranet-migration-guide.md). Owner: **IT** = company IT team,
**AO** = app owner (Victor). Section numbers point to the guide.

## Decide (before any work)

- [ ] IT · Server OS and web server: Windows + IIS, or Linux + nginx (§3, §10)
- [ ] IT · Node.js 22.13+ approved to run as a service (§3)
- [ ] IT · SQLite file accepted as the database, or a database server required (option D, §2)
- [ ] IT · Host name for the app, at the root of its own name, e.g. `https://muat.intranet.example/` (§3)
- [ ] IT · HTTPS certificate from the company CA (§3)
- [ ] IT + AO · Access: company sign-on at the proxy? Who holds the master password? (§4.3, system doc §5)
- [ ] IT · Backup target and retention for the database file (§4.6)
- [ ] IT · Server time zone (§6)
- [ ] AO · Help assistant: off, or an internal LLM (§7)
- [ ] AO · Date of the switch-over and a freeze window for saving plans

## Build

- [ ] IT · Build machine can run `npm ci` (registry or mirror) (§3)
- [ ] IT · `npm ci` · `npm test` (31 passed) · `npm run build:intranet` (§4.1)
- [ ] IT · Output present: `dist/index.html`, `dist/assets/*`, `dist/app-guide.md`, `build-server/server.js`

## Install

- [ ] IT · Copy `dist/` and `build-server/` to the server; create the data folder, writable by the service account only (§4.2)
- [ ] IT · Manual start prints `Truck Load Optimizer on http://127.0.0.1:8080`; `GET /api/snapshot` returns JSON (§4.2)
- [ ] IT · Service set up (systemd template or NSSM/WinSW), restarts on failure, starts at boot (§4.2)
- [ ] IT · Reverse proxy with HTTPS (`web.config` or `nginx.conf` template); HTTP redirects to HTTPS (§4.3)
- [ ] IT · `.wasm` served as `application/wasm` (the Node service does this; a static-only IIS needs the MIME map)
- [ ] IT · Optional: Windows Authentication / SSO on the site

## First start

- [ ] AO · Open the site from a normal user PC: header shows **"Database bersama"** (not "Hanya browser ini") (§4.3)
- [ ] AO · Set the master password immediately, before announcing the URL (§4.4)
- [ ] AO · Lock shows "🔓 Master" after unlocking (proves HTTPS and Web Crypto work)

## Data

- [ ] AO · Tell planners about the freeze window; ask them to publish or note personal SKUs and rules (§4.7)
- [ ] AO · Cloudflare app: Data Master › Database › "Unduh file database (.sqlite)" (§4.5)
- [ ] AO · Intranet app: Data Master › Database › "Muat file database" with that file (§4.5)
- [ ] AO · Counts match on both Database tabs: SKU, Tipe truk, Nomor polisi, Shipment, Tujuan, Rencana
- [ ] AO · Open 2–3 saved plans in Riwayat Rencana; reprint one loader sheet
- [ ] AO · Company name on the loader sheet is right (Data Master › Database)

## Acceptance test (on two different user PCs)

- [ ] AO · Load "✦ Contoh rencana": all three models finish; 3D view shows
- [ ] AO · Save a test shipment on PC 1; reload PC 2 and find it in Riwayat Rencana
- [ ] AO · Print colour and black-and-white loader sheets on the office printer
- [ ] AO · Master change (edit one SKU) on PC 1 is visible on PC 2 after reload
- [ ] AO · Delete the test shipment
- [ ] IT · First backup taken and a test restore done on a copy (§4.6)

## Switch-over

- [ ] AO · Announce the new address (bookmark, SOP, loader-sheet references)
- [ ] AO · Update the SOP / user guide screenshots if the address appears in them
- [ ] AO · Keep the Cloudflare app as read-only fallback for a few weeks (§4.7)
- [ ] AO · Then delete the Cloudflare Worker `loadoptimizer` and D1 databases `loadoptimizer-db` and `loadoptimizer-db-preview`; disconnect the Cloudflare build from GitHub

## Follow-ups (not blocking go-live)

- [ ] AO + IT · Load saved-plan results on demand instead of in the start-up snapshot, before the history grows large (system doc §2.4)
- [ ] AO + IT · Decide on user accounts / audit logging if needed (system doc §5)
- [ ] AO · Replace estimated truck sizes with measured ones (README, known data gaps)
