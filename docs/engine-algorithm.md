# Packing engine: algorithm reference

The engine in `src/engine/` turns a shipment (cartons with quantities, one or more trucks, a rule set) into carton
positions, tiers, counts and a stability report. It is plain TypeScript with no dependencies and no I/O, so it runs
unchanged in a browser Web Worker, in Node (the tests) or anywhere else. This page follows the code; function names
are given so each step can be found.

## 1. Coordinates, units and data types

- Centimetres and kilograms. **x** runs along the truck from the cab (x = 0) to the door, **y** across the width,
  **z** up from the floor. The 3D view maps engine (x, y, z) to three.js (x, z, y), 1 unit = 1 cm.
- Input (`types.ts`): `EngineSku` (planning size = measured outer size + the SKU's `mod_*` adjustment, weight,
  `safeLayers`, `canLieDown`, product `group`), `EngineLine` (`sku`, `qty`; `qty = null` means "fill max"),
  `EngineTruck` (inner length, width, height), `ModelRules` (`rules.ts`).
- Output: `PlanResult` with `boxes: PlacedBox[]` (x, y, z, dx, dy, dz, skuId, tier), `tiers: Tier[]` (index, x0,
  depth, counts per SKU, columns, layers, interlocked, uniform), loaded/unplaced counts, volume utilisation, used
  length, total weight, plans evaluated, elapsed ms and a `StabilityReport`.

## 2. Entry points and threading

```
planner.ts ──► new Worker(engine/worker.ts) ×3 (free, standard, mixed) ──► runShipment(model, req)
                                                                              └─► runModel() per truck
                                                                                    └─► search() loop
                                                                                          └─► tierAttempt() / openAttempt()
                                                                                                └─► buildTier() + fillSpaces()
                                                                                    └─► summarise() → checkStability()
```

- `ui/planner.ts › run()` starts one module Web Worker per model, posts `{ model, req }`, receives `progress`
  messages (every 150 ms) and one `result`, then terminates the worker. The three models run in parallel on three
  threads. Starting a new calculation terminates running workers.
- `worker.ts` calls `runShipment()` and posts the result. Nothing else crosses the thread boundary.

## 3. The three models (default rules, `rules.ts › DEFAULT_RULES`)

| Rule | Bebas (`free`) | Standar (`standard`) | Campuran (`mixed`) | Meaning |
| --- | --- | --- | --- | --- |
| `tiers` | on | on | on | Build one-carton-deep walls across the width, cab to door |
| `lineOrder` | off | on | on | Tier leaders follow the shipment line order |
| `interlock` | off | on | on | Offset alternate layers so joints do not line up |
| `interlockMinSupport` | 0.6 | 0.6 | 0.6 | Minimum share of a carton's base resting on the layer below |
| `mixing` | free | fill | free | Other SKUs in a tier: none, only to fill gaps (same group preferred), or freely |
| `rotation` | any | sku | sku | Upright only, the SKU's "may lie down" flag, or all six orientations |
| `respectSafeStack` | off | on | on | Obey `safe_stack_layers` |
| `heavyBottom` | on | on | on | Favour heavy SKUs on the floor, light ones on top |
| `maxGapCm` | 0 (no limit) | 10 | 10 | Widest gap a tier pattern may leave |
| `safetyFirst` | off | on | off | Rank plans by stability before carton count; limit tier height steps |
| `fillFrom` | cab | cab | cab | Load from the cab or from the door |
| `physics` | EN 12195-1 | EN 12195-1 | EN 12195-1 | brake 0.8 g, accel 0.5 g, side 0.5 g, bump 0 g, friction 0.4, slide gap 10 cm |
| `searchSeconds` | 3 | 2 | 3 | Time budget of the randomised search |

Master users change the shared rules (table `model_settings`); any user can keep personal rules in the browser.
`withDefaults()` fills fields missing from rules saved by an older version.

## 4. Shipment over several trucks (`shipment.ts › runShipment`)

1. `left` = remaining fixed quantities per SKU.
2. For truck k = 0, 1, … (at most `MAX_TRUCKS` = 30): take the lines with something left (fixed lines with qty > 0,
   all "fill max" lines); the truck is `trucks[k]`, or the last given truck repeated.
3. `runModel()` plans that truck. Subtract what it loaded from `left`.
4. Stop when no fixed quantity remains, or when a truck after the first takes none of the remaining fixed cartons
   (another identical truck would not help: those cartons are reported as `unplaced`). "Fill max" lines never cause
   an extra truck; they only fill space.

## 5. Search loop (`models.ts › search`)

A greedy-plus-randomised restart search with a time budget:

1. PRNG: mulberry32 (`common.ts › makeRng`), seed 20261018 unless given, so the same input gives the same plan.
2. Attempt 0 is greedy (`noise = 0`). Then, until `searchSeconds` (or 200,000 attempts) is used up, each attempt
   draws `noise = 0.1 + 0.4·rng()` and builds a full plan with randomised choices.
3. Each plan is scored; the best is kept.
   - Default score (`common.ts › planScore`): `cartons·10¹² + volume·10 − usedLength`. More cartons first, then more
     loaded volume, then a shorter load.
   - With `safetyFirst`: `orderedCartons·10¹⁵ − risky·10·10¹² + planScore`. Cartons of fixed-quantity lines always
     win (safety never leaves part of an order behind); one risky carton costs as much as 10 "fill max" cartons.
     `risky` comes from a full `checkStability()` of the attempt.
4. With `tiers` off, even attempts use `openAttempt()` (the whole truck as one open space, section 7) and odd ones
   `tierAttempt()`; the better plan wins. All default models have `tiers` on.
5. With `fillFrom = 'door'` the attempts are built from x = 0 as usual and the winner is mirrored along the length
   (`x' = L − x − dx`); stability checks inside the search use `reversed` so braking and acceleration swap.

## 6. Tier building (`tiers.ts`)

### 6.1 `tierAttempt`: tiers from the cab to the door

```
x = 0; prevTop = ∞ (the cab wall holds the first tier at any height)
while x < truck length:
    main = first line in loading order that still has cartons and fits in the remaining length
           (loading order = fixed-quantity lines in shipment order, then "fill max" lines)
    if not lineOrder and noise > 0: main = random line of the same kind (fixed vs fill-max) that fits
    rank the main SKU's orientations (6.2); keep only those with the same "can interlock" value as the best
    greedy: take the best; search: with probability 0.3 (0.5 with safetyFirst) take the 2nd or 3rd
    build the tier at x (6.4); if it holds no carton, mark the line done and retry
    x += depth of the chosen orientation (the tier is one carton deep); prevTop = the tier's solid wall height
```

### 6.2 Orientations and ranking (`common.ts › orientations`, `tiers.ts › rankOrientations`)

- Allowed orientations: `[l, w, h]` and `[w, l, h]` (upright, turned 90°), plus the four lying ones when `rotation =
  'any'` or (`'sku'` and the SKU may lie down). Duplicates (equal sides) are removed.
- For each orientation that fits: the row pattern (6.3), the layer count `min(⌊H/dz⌋, stack limit)`, cartons per
  full tier (even layers use row A, odd layers row B), and **density = cartons per tier ÷ tier depth**. Sort: with
  `interlock` on, orientations that can interlock come first; then by density.

### 6.3 Row patterns and interlocking (`rowPattern`)

Row A (even layers, the bottom layer): `n = ⌊W / dy⌋` cartons side by side. If interlock is off or n < 2, every
layer is row A (straight columns).

Row B candidates (odd layers):

- **Half-carton shift:** start at `dy/2`, `⌊(W − dy/2) / dy⌋` cartons.
- **Turned ends:** 1 or 2 cartons turned 90° at the start and/or end (combinations (1,0) (0,1) (1,1) (2,0) (2,1)
  (2,2)), the middle in the normal direction; only if the turned carton fits the tier depth.

A candidate is accepted when it holds at least `n − max(1, ⌊n/4⌋)` cartons; none of its joints lies within 3 cm
(`JOINT_TOLERANCE`) of a row-A joint; `rowSupport` in both directions is at least `interlockMinSupport`; and, with
`maxGapCm > 0`, its widest gap (at a wall, between cartons or behind a turned carton) is at most `maxGapCm`. The
accepted candidate with the most cartons wins. With straight columns and a wall gap wider than `maxGapCm`, the row is
centred so the gap is split between both walls.

### 6.4 One tier (`buildTier`)

1. **Height ceiling.** Without `safetyFirst`: the truck height. With it: `min(H, prevTop + maxStep(depth, push))`,
   where the push is braking (towards the cab) and `maxStep = depth·(1 − bump) / push`. A tier may not stand higher
   above the previous one than it could without tipping under braking.
2. **Layer count:** `min(⌊ceiling / dz⌋, stack limit)`. With `safetyFirst` and a fixed-quantity main SKU, if the
   last cartons would make a short final tier that stands more than the acceleration `maxStep` below this one, the
   rows are split evenly over two tiers (`⌈rows/2⌉` layers).
3. **Main SKU layers:** layer k uses row A or B; with `safetyFirst`, an upper layer is laid only if it can be
   complete (a part row would leave a gap).
4. **Fillers** (when `mixing ≠ 'none'`): gap spaces are collected for each layer (beside cartons, at the far wall,
   behind turned cartons) and above the last layer up to the ceiling. Each gap is filled with `fillSpaces()` (7) using
   line weights: `free` mixing = random 0.7–1.3; `fill` mixing (Standar) = ×4 for the main SKU and the next line in
   order, ×2 for the same product group. Fillers must be fully supported (`supportFraction ≥ 0.999`), otherwise they
   are given back.
5. **Safety pass** (`safetyFirst`): up to 4 rounds of `checkStability()` over the previous tier and this one; any
   filler flagged, or no longer fully supported, is removed (with what rests on it).
6. **Result:** boxes, tier meta (columns, layers, interlocked), and `fullTop` = `wallHeight()`: sampling every 5 cm
   across the width, the height stacked without a break from the floor; the lowest of those (ignoring wall strips no
   wider than the centring gap). The next tier's ceiling uses it.

## 7. Block building (`blocks.ts › fillSpaces`)

A guillotine block-building heuristic used for tier gaps and for open-space attempts.

1. Pick the free space nearest the cab, then lowest, then nearest the left wall (this fills the floor across the width
   before stacking).
2. For every line with cartons left and positive weight, every allowed orientation that fits, and the stack limit
   (`min(space limit, SKU limit) − cartons already below`): a block of `nx × ny × nz` identical cartons, cut down to
   whole layers when the remaining quantity is smaller.
3. Score: `volume × fit × weight`, where `fit = 0.7 + 0.15·(block width / space width) + 0.15·(block height / space
   height)` (flat walls are easier to load). `heavyBottom` multiplies by `1 + 0.25·w` on the floor and `1 + 0.25·(1 −
   w)` above it (w = weight relative to the heaviest SKU). Search noise multiplies by `1 + noise·(rng − 0.5)`. "Fill
   max" lines have weight 0.001, so they only take space no fixed line can use.
4. Place the best block in the space's corner; split the remainder into the space above the block plus two floor
   pieces, choosing the guillotine cut whose larger piece is bigger; discard pieces under 5 cm.

## 8. Pseudo-tiers for open loads (`models.ts › runModel`)

When a plan came from `openAttempt()` (no real tiers), cartons are grouped into fixed 100 cm segments by their centre
along the truck, so loaders still get a count and a picture per segment (`segmentTiers = true`).

## 9. Stability check (`stability.ts › checkStability`)

A rigid-box check after EN 12195-1 load-securing values. For each carton (neighbours found through 25 cm buckets
along x):

- **Overhang:** a carton above the floor must have the centre of its base over a supporting carton and at least 50 %
  of its base supported.
- For each of four pushes (towards the cab = brake g, towards the door = accel g, both sides = side g); with `reversed`
  the x pushes swap:
  - Skip if the wall is within the slide gap (10 cm), or if this face is an open end of the load (counted as
    `endFace`: to be blocked or strapped, not risky).
  - `free` = distance to the nearest obstacle on that side at an overlapping height. If `free ≤ slide gap`, the carton
    is held.
  - **Slide** if `push > friction · (1 − bump)`.
  - **Tip** if the height it stands above its neighbour on that side exceeds `maxStep(size, push) = size·(1 − bump)
    / push`, with size = the carton's base along the push.
- Report: counts of risky, tip, slide, overhang, end faces, and the flagged carton indexes with bit flags (1 tip,
  2 slide, 4 overhang). The 3D "risk" colour mode and the loader sheet use them.

## 10. Summary and poses

- `summarise()` computes loaded / unplaced per SKU, loaded volume, volume utilisation (carton volume ÷ truck volume),
  used length, total weight and runs the final stability check.
- `pose.ts › poseOf()` names how each carton stands, A–F (which face is up, which faces the door), for the loader
  sheet's pictograms.

## 11. Performance and determinism

- Each model runs for its `searchSeconds` (2–3 s) per truck, on its own thread; a multi-truck shipment takes that per
  truck. `plansEvaluated` and `elapsedMs` are stored with each plan.
- Same input, rules and seed give the same plan on the same machine; a faster PC evaluates more attempts within the
  time budget and may find a better plan, so results can differ slightly between PCs.

## 12. Tests (`tests/engine.test.ts`)

Every model stays inside the truck, fully supported, within stack limits and without overlaps; Bebas ignores safe
stack limits; Standar tiers are one carton deep with a full bottom layer and keep SKUs in neighbouring tiers;
interlocked rows offset joints within the support rule; Bebas and Campuran load at least as much as Standar; the
stability check flags a lone column and an off-centre carton and accepts a full wall against the cab; physics
settings and door-side filling behave as described; multi-truck shipments add trucks in line order and stop
correctly; poses; SAP material-description parsing.
