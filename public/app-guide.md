# Optimasi Muat Truk: app guide

This guide is the only source the in-app assistant ("Tanya AI") answers from. Edit this file to change what it knows; the next deploy picks it up. Screen labels are quoted exactly as they appear in the app (Bahasa Indonesia).

## What the app is

A web app for planning how cartons are loaded into one truck, tier by tier, from the cab to the door. The planner picks a destination, a truck and the SKUs with quantities, and the app computes three alternative load plans ("models") at the same time so they can be compared. The chosen plan can be viewed in 3D, checked for stability, saved, and printed as a loader sheet (lembar muat) that the loader and checker sign.

It is a prototype ("Prototipe" tag in the header). Units are centimetres and kilograms. Truck dimensions are inner dimensions: length (cab to door) × width × height.

The header shows where data is kept: "Database bersama" means everyone shares one database online; "Hanya browser ini" means the data lives only in this browser (offline or local copy).

## Pages

The top bar has three pages: "Perencanaan" (planning), "Riwayat Rencana" (saved plans) and "Data Master" (master data). The ☾/☀ button switches dark and light mode. The lock button switches between "🔒 Pengguna" (normal user) and "🔓 Master" (editing the shared data).

## Users and the master role

- Everyone can: plan loads, run the optimizer, save plans, print loader sheets, fill in results in "Riwayat Rencana", save a one-off truck as a template, and create or change SKUs and model rules for themselves only.
- Personal SKUs ("pribadi") and personal SKU edits ("diubah") live only in the user's own browser. They can be used for planning immediately but do not change the shared database.
- Personal model rules ("Simpan untuk saya" / "Tersimpan untuk Anda") also apply only on that device.
- Only the master can change shared data: SKUs, trucks, destinations, shared model rules, the company name on the loader sheet, and the whole database (import, reset). To become master, click the lock button and enter the master password ("Masuk sebagai master"). The first person to do this on a new database creates the password (minimum 4 characters). Click the lock again to leave master mode ("Keluar dari master").
- A master can publish a personal SKU to everyone with "Simpan ke database".
- The lock protects against accidental changes in this prototype; it is not full security. If the master password is lost, the app owner has to reset it in the database (ask the person who runs the app).

## Planning a load ("Perencanaan")

1. "Referensi (opsional)": any note or document number.
2. "Tujuan": search by customer, city or zone. Each destination lists the vehicles allowed there; the largest is the maximum truck for that destination.
3. "Jenis Truk": filled automatically with the destination's maximum truck. Smaller trucks may be chosen; a larger one shows the warning "Truk ini lebih besar dari truk maksimum tujuan".
4. For an unusual truck (ODOL or modified body) open "Truk ODOL / ukuran khusus", enter its inner dimensions and click "Pakai ukuran ini". It applies to this plan only, unless "Simpan sebagai template truk" is ticked with a template name.
5. "SKU": search by SAP material number or name and add lines. "Jumlah (pak)" is the quantity in packs. Leave the quantity empty ("maks") to fill the remaining space with that SKU. Drag rows to change the loading order. "Tempel dari Excel" pastes two columns from Excel: SAP material number and quantity. "SKU baru" creates a personal SKU on the spot.
6. Click "Jalankan Optimasi". All three models run in parallel; a longer search usually gives better results. "Batal" stops it.
7. Compare the three model cards (carton count, tiers, volume use, stability) and click "Pilih rencana ini" on the one to use.
8. "Simpan rencana" stores it in "Riwayat Rencana". "Cetak lembar muat" opens the A4 landscape print preview; choose "Simpan sebagai PDF" in the print dialog to get a PDF.

If the input changes after a run, a note says to run the optimizer again.

Fixed quantities are always loaded first; "maks" lines only fill the space left. The truck is never swapped automatically: cartons that do not fit are listed as "Tidak muat". To fit more, choose a larger truck, reduce quantities, or try another model.

## The three models

- "Bebas" (free): free geometry for the highest carton count. No tiers; cartons may be rotated any way and SKUs mix freely. For counting and photos, the load is grouped in 1-metre segments from the cab ("Segmen 1 m").
- "Standar" (standard): neat tiers with no gaps, SKUs grouped together, safety first. One SKU per tier, other SKUs only fill the rest of a tier (same product group first). Interlocked layers. Respects each SKU's safe stacking height.
- "Campuran" (mixed): Standar tiers, with the leftover space filled freely by other SKUs.

A tier is one carton deep and spans the full truck width, built from the cab toward the door (or from the door, if the rule says so). Each tier gets a photo and a count on the loader sheet.

Rules that apply to every model: cartons stay inside the truck and never overlap; the bottom layer is filled across the full width first; every carton is fully supported (interlock patterns use the minimum support setting); fixed quantities load before "maks" lines; planning size = outer size + per-side adjustment.

## Results screen

- "Ringkasan" (summary): total cartons, volume use ("Pemakaian volume"), tier count, used length, total weight, truck and destination info. "Tampilkan karton per tier" lists counts per tier.
- "Model 3D": drag to rotate, scroll or pinch to zoom, click a carton for details. Colour by SKU, by tier, or by risk. "Langkah demi langkah" steps through the tiers one by one. If the browser lacks WebGL, the 3D view is not available but the tier plan still works.
- "Cek stabilitas" (stability check): simulates braking (push toward the cab), speeding up (toward the door), curves (sideways) and optionally bumps, with friction between cartons. Cartons are flagged if they could tip over ("Bisa terguling"), slide ("Bisa bergeser", a gap over 10 cm) or are not supported in the middle ("Tidak bertumpu di tengah"). The open face of the load (the end not touching a wall) should be blocked or strapped. Fill flagged gaps with dunnage or strap them.
- "Detail": tier data, SKUs in the shipment, truck size, destination and the model rules used.

## Saved plans ("Riwayat Rencana")

Search by destination, filter by date and status ("Draf", "Final", "Dimuat"). For each plan:
- "Catatan planner": planner's note.
- "Jumlah aktual per tier": actual counts per tier copied from the signed paper loader sheet; the difference ("Selisih") is shown.
- "Hasil pemuatan": how the load went (loading date, whether the plan was followed, complaints such as shifted load, damaged or collapsed cartons, affected cartons, field notes). This is collected to train better models later.
- "Ekspor data latihan (CSV)": one row per plan with its data and outcome.
- "Buka di perencanaan" reopens it in the planner; "Cetak ulang" reprints.

Saved plans keep the rules and SKU sizes used at the time, so later changes do not alter them.

## Master data ("Data Master")

Tabs: "SKU", "Truk", "Tujuan", "Aturan Model", "Database". Without master mode these are read-only except personal SKUs and personal rules.

### SKU
Fields: SAP material number ("No. material SAP"), name, length, width and height in cm, weight in kg, "Tumpukan aman (tingkat)" (how many cartons high a stack may safely be, counted from the floor), "Beban atas maks / BCT (kg)", product group, packaging (carton or plastic bundle "Bal plastik"), "Boleh rebah" (may lie on its side), and "Penyesuaian P/L/T" (adjustment per side in cm: + for bulging cartons, − for shrinking ones). "Aktif" hides an SKU from planning when off.
- "Impor dari Excel": paste rows with columns in this order: SAP number, name, length, width, height (cm), weight (kg), safe stack layers, product group, packaging (karton/bal), may lie down (ya/tidak), adjustment L, W, H (cm). A header row is optional. Existing SAP numbers are updated, new ones added.
- SKUs marked "dummy" (codes DUM-xxx) are placeholders until real SKU data is loaded.

### Truk (trucks)
Fields: code, name, variant, body type (Box, Wingbox, Bak terbuka, Kontainer), estimated volume (m³), inner length × width × height (cm), "Dimensi estimasi" flag, "Template khusus" (one-off truck), notes.
Truck types with a volume range have three entries: Minimum, Rata-rata (average) and Maksimum. Dimensions marked as estimates were derived from the logistics team's cubic volume (width and height fixed, length scaled). Replace them with tape-measured values here; this directly improves plan accuracy. ISO 20' and 40' containers use standard dimensions.

Seed truck types: CDE, CDD, Engkel, Tronton, Semitrailer, Big Semitrailer (Zone 8, 53 m³), Big Semitrailer-55, Tronton Built Up-65, Big Semitrailer (Zone 1, 70 m³), Tronton Built Up-70, Kontainer 20', Kontainer 40'.

### Tujuan (destinations)
Fields: ship-to number, customer, city, zone, the vehicle text from the logistics list ("Kendaraan (teks asli)") and the trucks allowed there ("Kendaraan di daftar tujuan"). The largest allowed truck becomes the default for that destination; smaller trucks are always allowed.

### Aturan Model (model rules)
Each model has its own rules. Changes apply to the next optimization; saved plans keep their rules. Normal users can "Simpan untuk saya"; only the master changes the shared rules. "Kembalikan ke aturan awal" restores the defaults.
- "Bangun per tier": build one-carton-deep tiers across the width.
- "Ikuti urutan baris pengiriman": follow the shipment line order.
- "Pola mengunci antar lapis" and "Penopang minimum pola mengunci (%)": offset or turn alternate layers 90° so joints do not line up; minimum share of a carton's base that must rest on cartons below (default 60%).
- "SKU lain dalam satu tier": not allowed / only to fill a tier (same product group first) / free.
- "Putar karton": only turn flat / follow each SKU's "Boleh rebah" / any direction.
- "Patuhi tinggi tumpukan aman SKU": respect safe stack height.
- "Yang berat di bawah": heavier SKUs at the bottom.
- "Celah maksimum dalam tier (cm, 0 = bebas)": patterns leaving a wider gap are rejected (Standar and Campuran default 10 cm).
- "Arah pengisian": from the cab to the door, or from the door to the cab (e.g. wingbox trucks).
- "Utamakan keamanan": rank plans by stability before carton count (on by default for Standar).
- "Waktu pencarian (detik)": search time per model (defaults: Bebas 3, Standar 2, Campuran 3).
- "Fisika (cek stabilitas)": brake push 0.8 g, acceleration 0.5 g, sideways 0.5 g, bump 0 g, friction 0.4, allowed slide gap 10 cm (defaults from EN 12195-1 road transport). Raise them for bad roads or hard braking.

### Database
- "Nama perusahaan": company name printed at the top of the loader sheet.
- "Unduh file database (.sqlite)": download a backup.
- "Muat file database": load a .sqlite file (replaces all data; files from an old version cannot be loaded).
- "Kembalikan ke data awal": reset everything to the seed data (all changes are lost).

## Common questions

- Why did not everything fit? The truck is full under the current rules. Try "Bebas", a larger truck, allowing more rotation, or lowering fixed quantities. Check that SKU sizes and the "Penyesuaian" values are right.
- Why does Standar load fewer cartons than Bebas? Standar keeps neat, stable tiers and respects safe stack height; Bebas maximises count.
- How do I add a new SKU for everyone? Enter master mode, then "Data Master" > "SKU" > "Tambah baru" (or "Impor dari Excel"). Without master mode you can add a personal SKU and ask the master to publish it.
- How do I add a truck or fix truck sizes? Master mode, "Data Master" > "Truk".
- How do I change which trucks a destination may use? Master mode, "Data Master" > "Tujuan", edit the destination.
- Can I plan for a truck that is not in the list? Yes, with "Truk ODOL / ukuran khusus" on the planning page.
- How do I get a PDF? "Cetak lembar muat", then choose "Simpan sebagai PDF" in the print dialog.
- My changes disappeared: personal SKUs and rules are tied to one browser; another browser or device will not have them.

## Known data gaps

Truck inner dimensions are estimates (except containers) until measured. "Split MT" has no dimensions. "Tronton Built Up-70" and "Big Semitrailer Zone 1" (both 70 m³) are kept separate until confirmed to be the same vehicle. SKUs are dummies for now.

## Planned, not available yet

- "Isi dengan AI": paste a sales order or message and let AI fill the planning form.
- This assistant is a prototype explainer: it cannot see or change any data, plans or settings, and it does not change access. It has a small daily question limit.

## For developers (how the app is built and changed)

- Code: TypeScript with Vite, in the GitHub repository vic355/loadoptimizer1. UI text lives in `src/i18n/id.ts`; packing engine in `src/engine/` (runs in a Web Worker); screens in `src/ui/`; database schema, seed data and queries in `src/db/`; the server (Cloudflare Worker) in `src/server/`.
- Deployment: Cloudflare builds and deploys the `main` branch as the Worker "loadoptimizer". Each pull request gets a preview build with its own preview database, so trying a change does not touch shared data.
- Data: Cloudflare D1 (SQLite). The browser loads all tables at start and sends each change to the server as a named operation; the server checks the master password for master-data changes.
- To change the app: open a pull request on the repository, check the preview build, then merge to `main`. Run `npm test` for the engine tests. Ask the app owner for repository access.
- This guide is `public/app-guide.md`; the assistant reads it on every question.
