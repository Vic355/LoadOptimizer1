# Optimasi Muat Truk: app guide

This guide is the only source the in-app assistant ("Tanya AI") answers from. Edit this file to change what it knows; the next deploy picks it up. Screen labels are quoted exactly as they appear in the app (Bahasa Indonesia).

## What the app is

A web app for planning how cartons are loaded into trucks, tier by tier, from the cab to the door. Every calculation belongs to a shipment number ("Nomor Shipment / SO"), which works like a sales order: one shipment can need more than one truck, depending on the SKUs and quantities. The planner enters the shipment number, destination, SKUs with quantities and the truck(s), and the app computes three alternative load plans ("models") at the same time so they can be compared. The chosen plan can be viewed in 3D truck by truck, checked for stability, saved, and printed as a loader sheet (lembar muat) per truck that the loader and checker sign.

It is a prototype ("Prototipe" tag in the header). Units are centimetres and kilograms. Truck dimensions are inner dimensions: length (cab to door) × width × height.

The header shows where data is kept: "Database bersama" means everyone shares one database online; "Hanya browser ini" means the data lives only in this browser (offline or local copy).

## Pages

The top bar has three pages: "Perencanaan" (planning), "Riwayat Rencana" (saved plans) and "Data Master" (master data). The ☾/☀ button switches dark and light mode. The lock button switches between "🔒 Pengguna" (normal user) and "🔓 Master" (editing the shared data).

## Users and the master role

- Everyone can: plan loads, run the optimizer, save plans (which also records new police numbers and their truck sizes), print loader sheets, fill in results in "Riwayat Rencana", and create or change SKUs and model rules for themselves only.
- Personal SKUs ("pribadi") and personal SKU edits ("diubah") live only in the user's own browser. They can be used for planning immediately but do not change the shared database.
- Personal model rules ("Simpan untuk saya" / "Tersimpan untuk Anda") also apply only on that device.
- Only the master can change shared data: SKUs, trucks, the police number register ("Nomor Polisi"), destinations, shared model rules, the company name on the loader sheet, and the whole database (import, reset). To become master, click the lock button and enter the master password ("Masuk sebagai master"). The first person to do this on a new database creates the password (minimum 4 characters). Click the lock again to leave master mode ("Keluar dari master").
- A master can publish a personal SKU to everyone with "Simpan ke database".
- The lock protects against accidental changes in this prototype; it is not full security. If the master password is lost, the app owner has to reset it in the database (ask the person who runs the app).

## Planning a load ("Perencanaan")

The planner starts empty: the 3D area shows an empty truck with a small checklist of the steps still missing. The left panel is "Input Pengiriman"; the shipment number sits at the top centre, above the 3D view.

1. "Nomor Shipment / SO" (top centre): type the shipment or sales order number. It is the ID of the saved plan. Clicking the field also lists saved shipments (search by number, customer, city or police number); picking one reopens it with all its trucks. The last entry, "✦ Contoh rencana", loads a made-up example shipment (SO-CONTOH-001: three Paseo and Nice SKUs that need two CDD trucks) and calculates it, to try the app. The shipment number comes first: while it is empty, "Input Pengiriman" is locked (greyed out, "🔒 Isi Nomor Shipment / SO …") and a small yellow helper says "Nomor Shipment / SO masih kosong". Typing a number, or picking a saved shipment or the example, unlocks it. Older drafts saved with a temporary number (TMP-…) still open and can be given their real number when saved.
   - "↺ Reset" (right of the shipment field) empties the planner for a new shipment after a confirmation. It does not delete anything saved in "Riwayat Rencana"; to delete a saved shipment, use "Riwayat Rencana".
2. "Tujuan": search by customer, city or zone. Each destination lists the vehicles allowed there; the largest is the maximum truck for that destination.
3. "Produk (SKU)": search by SAP material number or name and add lines. Leave the quantity empty ("maks") to fill the remaining space with that SKU. Drag rows to change the loading order. "Tempel dari Excel" pastes two columns from Excel: SAP material number and quantity. "+ SKU baru" creates a personal SKU on the spot.
4. "Truk": one card per truck ("Truk 1", "Truk 2", …). Each card has:
   - "Nomor polisi": the police number (e.g. B 9123 UXY), for every truck, not only ODOL. A known number fills in its truck type and the size last recorded for it ("Terdaftar: …"). A new number is added to the register with its size when the plan is saved.
   - "Jenis truk": filled automatically with the destination's maximum truck. Smaller trucks may be chosen; a larger one shows a warning.
   - "Ukuran dalam (cm)": inner length (P), width (L) and height (T), filled from the truck type. Change them for a measured or ODOL truck; the card then shows "ukuran diubah", and "Pakai ukuran standar" puts the type's size back.
   - "+ Tambah truk" adds a card. If the cartons do not fit in the trucks given, the app adds trucks automatically ("ditambah otomatis") with the type and size of the last truck, up to 30.
5. Click "Jalankan Optimasi". All three models run in parallel, truck by truck; a longer search usually gives better results. "Batal" stops it.
6. The "Model" selector above the 3D view shows each model with its number of trucks and cartons (e.g. "Bebas · 3 truk · 770 karton"); pick the one to use. Tabs below it ("Truk 1", "Truk 2", …) switch the 3D view and the summary between trucks.
7. "Simpan rencana" stores the whole shipment (every truck) in "Riwayat Rencana". Without a shipment number it asks for one or offers "Simpan sebagai draf". If a truck has no police number it asks first ("Simpan tanpa nomor polisi"). Saving again under the same shipment number replaces that shipment's plan after a confirmation.
8. "Cetak lembar muat (n truk)" opens the A4 landscape print preview for all trucks; choose "Simpan sebagai PDF" in the print dialog to get a PDF.

## Loader sheet (printed PDF)

"Cetak lembar muat" shows a preview with two print styles: "Warna" (light colours) and "Hitam-putih (hemat tinta)" (black and white for black-only printers; SKUs are told apart by number and hatching, and it uses less ink). The choice is remembered on that device. The sheet has:
Each truck in the shipment gets its own set of pages; every page header shows the shipment number, "Truk k / n" and the police number.
- Page 1: company name (set in "Data Master" > "Database", "APP" when empty), shipment, police number, truck, destination, totals, an overview drawing, the SKU list with numbers and the positions ("Posisi") used, what is left for the next truck ("Sisa pesanan, dimuat di Truk n"), warnings and signature lines.
- "Urutan Tier untuk Loader": every tier as one box in a line from the door (PINTU, left) to the cab (KABIN, right), with a small drawing of the tier, the cartons per SKU number, a box to tick when the tier is done and a line for the actual count. Long loads wrap to more rows; each row says which tier it continues with. Loaders do not use the website, so this page is made for them, with pictures of the cab and door instead of words like front and back.
- "Posisi karton" (carton position): each carton in a tier drawing is labelled with its SKU number and a position letter, e.g. "3B". A legend with a small drawing of each letter is printed on page 1 and on the loader page. The thick line on the drawing is the carton's lid (tape), and the dark face is the one that faces the door:
  - A: "Tegak · sisi panjang ke pintu" (upright, long side to the door)
  - B: "Tegak · sisi pendek ke pintu" (upright, short side to the door)
  - C: "Rebah · tutup ke pintu" (laid down, lid facing the door)
  - D: "Rebah · sisi pendek ke pintu" (laid down, short side to the door)
  - E: "Berdiri di sisi pendek · tutup ke pintu" (stood on its short side, lid to the door)
  - F: "Berdiri di sisi pendek · sisi panjang ke pintu" (stood on its short side, long side to the door)
- Tier pages: six tiers per page, each drawn as seen from the door looking toward the cab, with a bar showing where the tier sits in the truck, "◀ kiri / kanan ▶" (left and right as seen from the door), "↔ berjajar" (cartons side by side) and "↕ tumpuk" (cartons stacked up), counts per SKU, and boxes for actual count, photo and checker.

If the input changes after a run, a note says to run the optimizer again.

Fixed quantities are always loaded first; "maks" lines only fill the space left. The truck type is never swapped automatically: when fixed quantities are left over, another truck like the last one is added. "maks" lines never add a truck. Cartons that fit in no truck at all are listed as "Tidak termuat di truk mana pun". To use fewer trucks, choose larger trucks, reduce quantities, or try another model.

## The three models

- "Bebas" (free): free geometry for the highest carton count. It builds tiers too (one carton deep, across the width), so loaders get a count and a picture per tier, but cartons may be rotated any way and SKUs mix freely. (If "Bangun per tier" is switched off in its rules, it falls back to 1-metre segments.)
- "Standar" (standard): neat tiers with no gaps, SKUs grouped together, safety first. One SKU per tier, other SKUs only fill the rest of a tier (same product group first). Interlocked layers. Respects each SKU's safe stacking height.
- "Campuran" (mixed): Standar tiers, with the leftover space filled freely by other SKUs.

A tier is one carton deep and spans the full truck width, built from the cab toward the door (or from the door, if the rule says so). Each tier gets a photo and a count on the loader sheet.

Rules that apply to every model: cartons stay inside the truck and never overlap; the bottom layer is filled across the full width first; every carton is fully supported (interlock patterns use the minimum support setting); fixed quantities load before "maks" lines; planning size = outer size + per-side adjustment.

## Results screen

- "Ringkasan" (summary): total cartons, volume use ("Pemakaian volume"), tier count, used length, total weight, truck and destination info. "Tampilkan karton per tier" lists counts per tier.
- "Model 3D": drag to rotate, scroll or pinch to zoom, click a carton for details. The truck is drawn with a blue cab at the front and the rear doors swung open at the back, so front and back are clear from any angle. "Label & ukuran" shows or hides the KABIN and PINTU labels and the inner length, width and height lines (P, L, T in cm) beside the box; they stay attached to the truck and sit outside the cargo. Compare the drawn height with the real truck to spot a wrong size. Colour by SKU, by tier, or by risk. "Langkah demi langkah" steps through the tiers one by one. If the browser lacks WebGL, the 3D view is not available but the tier plan still works.
- "Cek stabilitas" (stability check): simulates braking (push toward the cab), speeding up (toward the door), curves (sideways) and optionally bumps, with friction between cartons. Cartons are flagged if they could tip over ("Bisa terguling"), slide ("Bisa bergeser", a gap over 10 cm) or are not supported in the middle ("Tidak bertumpu di tengah"). The open face of the load (the end not touching a wall) should be blocked or strapped. Fill flagged gaps with dunnage or strap them.
- "Detail": tier data, SKUs in the shipment, truck size, destination and the model rules used.

## Saved plans ("Riwayat Rencana")

Each row is one truck of a shipment ("Truk 1 / 3 · B 9123 UXY"). Search by shipment number, police number, customer or city; filter by date and status ("Draf", "Final", "Dimuat"). Shipments saved with a temporary number carry a "draf" tag. For each plan:
- "Catatan planner": planner's note.
- "Jumlah aktual per tier": actual counts per tier copied from the signed paper loader sheet; the difference ("Selisih") is shown.
- "Hasil pemuatan": how the load went (loading date, whether the plan was followed, complaints such as shifted load, damaged or collapsed cartons, affected cartons, field notes). This is collected to train better models later.
- "Ekspor data latihan (CSV)": one row per plan with its data and outcome.
- "Buka di perencanaan" reopens the whole shipment in the planner at that truck; "Cetak ulang" reprints every truck of the shipment. Deleting removes the whole shipment.

Saved plans keep the rules and SKU sizes used at the time, so later changes do not alter them.

## Master data ("Data Master")

Tabs: "SKU", "Tipe Truk", "Nomor Polisi", "Tujuan", "Aturan Model", "Database". Without master mode these are read-only except personal SKUs and personal rules.

### SKU
Fields: SAP material number ("No. material SAP"), name, length, width and height in cm, weight in kg, "Tumpukan aman (tingkat)" (how many cartons high a stack may safely be, counted from the floor), "Beban atas maks / BCT (kg)", product group, packaging (carton or plastic bundle "Bal plastik"), "Boleh rebah" (may lie on its side), and "Penyesuaian P/L/T" (adjustment per side in cm: + for bulging cartons, − for shrinking ones). "Aktif" hides an SKU from planning when off.
SAP fields: "No. C-box" (carton number), "Kualitas karton" (board grade) and "Material description (SAP)".
- "Impor dari Excel" accepts two formats. SAP format, 4 columns: SKU, Desc, Cbox, Material Description; the carton size is read from text like "355L,215W,175H" in millimetres (shown in cm), and the board grade from the end, e.g. "K150/M150". Or the full format, in this order: SAP number, name, length, width, height (cm), weight (kg), safe stack layers, product group, packaging (karton/bal), may lie down (ya/tidak), adjustment L, W, H (cm). A header row is optional. Existing SAP numbers are updated, new ones added; an SAP import keeps the safe stack height and other values already set.
- K/M in the material description is the corrugated board grade: K = kraft liner, M = medium (the fluted paper), each in g/m². K150/M125 means a 150 gsm liner with a 125 gsm flute. It tells how strong the carton board is, not the volume or weight. WK = white kraft liner.
- Rows whose material description is not in the usual form are kept and tagged "format tidak baku" (e.g. only "425" or "550GSM", "150K/150M" reversed, a cut-off "K275/M1", or decimal sizes). Check those cartons.
- The SKU list holds the 281 real SAP SKUs. Weight is not in the SAP data yet; the safe stack height starts at "up to a 250 cm roof", the product group is guessed from the name, and "Boleh rebah" starts off. Change these per SKU where needed.

### Tipe Truk (truck types)
Fields: code, name, variant, body type (Box, Wingbox, Bak terbuka, Kontainer), estimated volume (m³), inner length × width × height (cm), "Dimensi estimasi" flag, "Template khusus" (one-off truck), notes.
Truck types with a volume range have three entries: Minimum, Rata-rata (average) and Maksimum. Dimensions marked as estimates were derived from the logistics team's cubic volume (width and height fixed, length scaled). Replace them with tape-measured values here; this directly improves plan accuracy. ISO 20' and 40' containers use standard dimensions.

Seed truck types: CDE, CDD, Engkel, Tronton, Semitrailer, Big Semitrailer (Zone 8, 53 m³), Big Semitrailer-55, Tronton Built Up-65, Big Semitrailer (Zone 1, 70 m³), Tronton Built Up-70, Kontainer 20', Kontainer 40'.

### Nomor Polisi (police number register)
One row per real truck: police number, truck type, inner length, width and height (cm), how many plans used it, last update and notes. New numbers and their sizes are added automatically when a plan is saved; the last size saved is used again the next time that number is entered. The master can replace the sizes with tape-measured values. The police number is stored with each saved truck plan (the shipment number stays the plan's ID).

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
- How do I add a truck type or fix truck sizes? Master mode, "Data Master" > "Tipe Truk". For one real truck, use its police number in "Nomor Polisi".
- How do I change which trucks a destination may use? Master mode, "Data Master" > "Tujuan", edit the destination.
- Can I plan for a truck that is not in the list, or an ODOL truck? Yes: enter its police number and change "Ukuran dalam (cm)" on its truck card. The size is saved with that police number.
- Why are there more trucks than I entered? The cartons with fixed quantities did not fit, so the app added trucks like the last one. Remove lines, lower quantities or pick a larger truck to use fewer.
- Do I need a shipment number to calculate? No. Only saving needs one; without it the plan can be saved as a draft with a temporary number.
- What do the letters after the SKU number on the loader sheet mean (e.g. "3B")? The carton position: see "Posisi karton" in the legend.
- How do I get a PDF? "Cetak lembar muat", pick "Warna" or "Hitam-putih (hemat tinta)", then "Simpan sebagai PDF" in the print dialog.
- My changes disappeared: personal SKUs and rules are tied to one browser; another browser or device will not have them.

## Known data gaps

Truck inner dimensions are estimates (except containers) until measured; measured sizes per police number go in "Nomor Polisi". "Split MT" has no dimensions. "Tronton Built Up-70" and "Big Semitrailer Zone 1" (both 70 m³) are kept separate until confirmed to be the same vehicle. SKU weights are not in the SAP data yet, and 10 SKUs have a material description in a non-standard form ("format tidak baku").

## Planned, not available yet

- "Isi dengan AI": paste a sales order or message and let AI fill the planning form.
- This assistant is a prototype explainer: it cannot see or change any data, plans or settings, and it does not change access. It has a small daily question limit.

## For developers (how the app is built and changed)

- Code: TypeScript with Vite, in the GitHub repository vic355/loadoptimizer1. UI text lives in `src/i18n/id.ts`; packing engine in `src/engine/` (runs in a Web Worker); screens in `src/ui/`; database schema, seed data and queries in `src/db/`; the server (Cloudflare Worker) in `src/server/`.
- Deployment: Cloudflare builds and deploys the `main` branch as the Worker "loadoptimizer". Each pull request gets a preview build with its own preview database, so trying a change does not touch shared data.
- Data: Cloudflare D1 (SQLite). The browser loads all tables at start and sends each change to the server as a named operation; the server checks the master password for master-data changes.
- To change the app: open a pull request on the repository, check the preview build, then merge to `main`. Run `npm test` for the engine tests. Ask the app owner for repository access.
- This guide is `public/app-guide.md`; the assistant reads it on every question.
