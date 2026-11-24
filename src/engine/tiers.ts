import type { PlacedBox, PlanRequest, Tier } from './types';
import { fillSpaces, type Space } from './blocks';
import { fillerWeight, layerLimit, loadingSequence, orientations, supportFraction, type Orientation } from './common';
import { checkStability, maxStep, pushAlongX } from './stability';

/** One carton position in a row across the truck width; `turned` cartons are rotated 90°. */
interface Slot {
  y: number;
  dx: number;
  dy: number;
}

interface Pattern {
  /** Even layers (the bottom layer is always the fullest row). */
  a: Slot[];
  /** Odd layers; null when the tier is stacked in straight columns. */
  b: Slot[] | null;
}

const JOINT_TOLERANCE = 3;

/** Share of each slot in `upper` resting on `lower` (both rows start at the tier's front face). */
function rowSupport(upper: Slot[], lower: Slot[]): number {
  let worst = 1;
  for (const u of upper) {
    let area = 0;
    for (const l of lower) {
      const oy = Math.min(u.y + u.dy, l.y + l.dy) - Math.max(u.y, l.y);
      if (oy > 0) area += oy * Math.min(u.dx, l.dx);
    }
    worst = Math.min(worst, area / (u.dx * u.dy));
  }
  return worst;
}

/** Widest empty space a row leaves: at the walls, between cartons, or behind a turned carton. */
function largestGap(row: Slot[], width: number, depth: number): number {
  let gap = 0;
  let y = 0;
  for (const s of row) {
    gap = Math.max(gap, s.y - y, depth - s.dx);
    y = s.y + s.dy;
  }
  return Math.max(gap, width - y);
}

/** Positions where two neighbouring cartons in a row meet (the row's two ends are not joints). */
function joints(row: Slot[]): number[] {
  return row.slice(0, -1).map((s) => s.y + s.dy);
}

/**
 * Row patterns for a tier of one SKU. The even row is a straight row of the narrowest side;
 * the odd row offsets the joints, either by shifting half a carton (when the spare width allows)
 * or by turning cartons 90° at the ends so the row stays full. Patterns that leave a carton
 * with less support than `minSupport`, or (when `maxGap` > 0) an empty space wider than `maxGap`
 * beside or behind a carton, are rejected, and the tier falls back to straight columns.
 */
export function rowPattern(width: number, o: Orientation, depth: number, interlock: boolean, minSupport: number, maxGap = 0): Pattern {
  const n = Math.floor(width / o.dy);
  const a: Slot[] = Array.from({ length: n }, (_, i) => ({ y: i * o.dy, dx: o.dx, dy: o.dy }));
  if (!interlock || n < 2) return { a, b: null };

  const aJoints = joints(a);
  const candidates: Slot[][] = [];
  // Half-carton shift with no turning.
  const shift = o.dy / 2;
  const nShift = Math.floor((width - shift) / o.dy);
  candidates.push(Array.from({ length: nShift }, (_, i) => ({ y: shift + i * o.dy, dx: o.dx, dy: o.dy })));
  // Turned cartons at one or both ends (a turned carton is o.dy deep and o.dx wide).
  if (o.dy <= depth && o.dx <= width) {
    for (const [start, end] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 0],
      [2, 1],
      [2, 2],
    ]) {
      const middle = Math.floor((width - (start + end) * o.dx) / o.dy);
      if (middle < 0) continue;
      const row: Slot[] = [];
      let y = 0;
      for (let i = 0; i < start; i++, y += o.dx) row.push({ y, dx: o.dy, dy: o.dx });
      for (let i = 0; i < middle; i++, y += o.dy) row.push({ y, dx: o.dx, dy: o.dy });
      for (let i = 0; i < end; i++, y += o.dx) row.push({ y, dx: o.dy, dy: o.dx });
      if (y <= width + 1e-6) candidates.push(row);
    }
  }
  let best: Slot[] | null = null;
  for (const row of candidates) {
    if (row.length < Math.max(1, n - Math.max(1, Math.floor(n * 0.25)))) continue;
    const offset = joints(row).every((j) => aJoints.every((k) => Math.abs(j - k) > JOINT_TOLERANCE));
    if (!offset) continue;
    if (rowSupport(row, a) < minSupport - 1e-9 || rowSupport(a, row) < minSupport - 1e-9) continue;
    if (maxGap > 0 && largestGap(row, width, depth) > maxGap + 1e-9) continue;
    if (!best || row.length > best.length) best = row;
  }
  return { a, b: best };
}

/**
 * Height the tier stands as a solid wall across the truck: at each point across the width, the
 * height stacked without a break from the floor, and the lowest of those. Empty strips at a wall
 * no wider than `wallGap` (the centring gap) are ignored.
 */
function wallHeight(boxes: PlacedBox[], width: number, wallGap: number): number {
  let lowest = Infinity;
  for (let y = 2.5; y < width; y += 5) {
    const here = boxes.filter((b) => b.y <= y && y <= b.y + b.dy).sort((p, q) => p.z - q.z);
    let top = 0;
    for (const b of here) if (b.z <= top + 0.5) top = Math.max(top, b.z + b.dz);
    if (top === 0 && (y < wallGap || y > width - wallGap)) continue;
    lowest = Math.min(lowest, top);
  }
  return lowest === Infinity ? 0 : lowest;
}

interface TierBuild {
  boxes: PlacedBox[];
  meta: Partial<Tier>;
  /** Height of the tier's complete rows, which the next tier leans on when braking. */
  fullTop: number;
}

/**
 * Height needed on top of a tier `depth` deep to lay the last `count` cartons of `line` there:
 * full layers across the width, in the flattest orientation that fits the depth. Null when the
 * cartons do not fit the tier's depth at all.
 */
function tailHeight(req: PlanRequest, line: number, count: number, depth: number): number | null {
  const { truck, lines, rules } = req;
  let best: number | null = null;
  for (const o of orientations(lines[line].sku, rules.rotation)) {
    if (o.dx > depth + 1e-6 || o.dy > truck.width) continue;
    const perLayer = Math.floor(depth / o.dx) * Math.floor(truck.width / o.dy);
    if (!perLayer) continue;
    const layers = Math.ceil(count / perLayer);
    if (layers > layerLimit(lines[line].sku, rules)) continue;
    const need = layers * o.dz;
    if (best == null || need < best) best = need;
  }
  return best;
}

/** Cartons of `line` in one full tier of orientation `o` (main SKU only, up to the roof or stack limit). */
function tierCapacity(req: PlanRequest, line: number, o: Orientation): { perTier: number; perRow: number } {
  const { truck, lines, rules } = req;
  const p = rowPattern(truck.width, o, o.dx, rules.interlock, rules.interlockMinSupport, rules.maxGapCm);
  const layers = Math.max(1, Math.min(Math.floor(truck.height / o.dz), layerLimit(lines[line].sku, rules)));
  return { perTier: Math.ceil(layers / 2) * p.a.length + Math.floor(layers / 2) * (p.b ?? p.a).length, perRow: p.a.length };
}

interface TierOptions {
  /**
   * The last few cartons of the previous SKU in line. They are laid on top of this tier (room is
   * kept for them) instead of standing alone as a short tier of a few cartons.
   */
  tail?: number;
}

/**
 * Builds one tier at `x`: the main SKU in its row pattern, layer by layer from the floor, then
 * (when mixing is allowed) other SKUs in the gaps beside, behind turned cartons and above it.
 * With `safetyFirst`, fillers that would tip or slide are left out (they go to a later tier). With `levelTiers` a tier rises no higher above the previous one than it can
 * stand when braking, and upper layers are only laid as complete rows; this leaves empty space.
 * With `groupBySku` only the main SKU (and a previous SKU's last cartons) fill the tier.
 */
function buildTier(
  req: PlanRequest,
  x: number,
  main: number,
  o: Orientation,
  tierNo: number,
  remaining: number[],
  rng: () => number,
  noise: number,
  sequence: number[],
  prevTop: number,
  prevBoxes: PlacedBox[],
  opts: TierOptions = {},
): TierBuild {
  const { truck, lines, rules } = req;
  const sku = lines[main].sku;
  const depth = o.dx;
  const pattern = rowPattern(truck.width, o, depth, rules.interlock, rules.interlockMinSupport, rules.maxGapCm);
  // Straight columns that leave too wide a gap at one wall are centred, splitting it between both
  // walls, when that makes both gaps narrow enough that the cartons cannot slide into them.
  const spare = truck.width - pattern.a.length * o.dy;
  if (!pattern.b && rules.maxGapCm > 0 && spare > rules.maxGapCm && spare / 2 <= rules.physics.slideGapCm) pattern.a = pattern.a.map((s) => ({ ...s, y: s.y + spare / 2 }));
  const reversed = rules.fillFrom === 'door';
  // Level tiers: braking (or speeding up, when filling from the door) pushes this tier towards the previous one.
  const ceiling = rules.levelTiers ? Math.min(truck.height, prevTop + maxStep(depth, pushAlongX(rules.physics, true, reversed), rules.physics)) : truck.height;
  let maxLayers = Math.max(1, Math.min(Math.floor(ceiling / o.dz), layerLimit(sku, rules)));
  /** The SKU's last rows were split over two tiers; the space above is not filled with it again. */
  let split = false;
  if (rules.safetyFirst && Number.isFinite(remaining[main])) {
    // The other push leans this tier on the next one. When the SKU's last cartons would make a
    // short final tier, split them over two tiers of even height so neither stands tall and alone.
    const perRow = pattern.a.length;
    const rowsLeft = Math.ceil(remaining[main] / perRow);
    const lastLayers = rowsLeft - maxLayers;
    const backStep = maxStep(depth, pushAlongX(rules.physics, false, reversed), rules.physics);
    if (lastLayers > 0 && lastLayers < maxLayers && (maxLayers - lastLayers) * o.dz > backStep) {
      maxLayers = Math.ceil(rowsLeft / 2);
      split = true;
    }
  }
  const tail = opts.tail;
  if (tail != null && remaining[tail] > 0) {
    // Keep room on top for the previous SKU's last cartons.
    const need = tailHeight(req, tail, remaining[tail], depth);
    if (need != null && ceiling - need >= o.dz) maxLayers = Math.min(maxLayers, Math.floor((ceiling - need) / o.dz));
  }
  const boxes: PlacedBox[] = [];
  const rows: Slot[][] = [];

  for (let k = 0; k < maxLayers && remaining[main] > 0; k++) {
    const row = k % 2 === 1 && pattern.b ? pattern.b : pattern.a;
    // Level tiers: an upper layer is only laid when it can be complete (a part row leaves a gap).
    if (rules.levelTiers && k > 0 && remaining[main] < row.length) break;
    const placed: Slot[] = [];
    for (const slot of row) {
      if (remaining[main] <= 0) break;
      boxes.push({ skuId: sku.id, x, y: slot.y, z: k * o.dz, dx: slot.dx, dy: slot.dy, dz: o.dz, tier: tierNo });
      placed.push(slot);
      remaining[main]--;
    }
    rows.push(placed);
  }
  const mainCount = boxes.length;
  const giveBack = (b: PlacedBox) => remaining[lines.findIndex((l) => l.sku.id === b.skuId)]++;

  if (rules.mixing !== 'none' || tail != null) {
    const nextInOrder = sequence[sequence.indexOf(main) + 1];
    const weight = (i: number) => {
      const base = fillerWeight(lines, i);
      // The previous SKU's last cartons go first, on top.
      if (i === tail) return 1000;
      if (rules.groupBySku || rules.mixing === 'none') return i === main && rules.mixing !== 'none' ? base * 4 : 0;
      if (rules.mixing === 'free') return base * (noise > 0 ? 0.7 + 0.6 * rng() : 1);
      // Standar keeps SKUs grouped: fill with the same SKU, the next line or the same product group first.
      if (i === main || i === nextInOrder) return base * 4;
      return base * (lines[i].sku.group && lines[i].sku.group === sku.group ? 2 : 1);
    };
    const limit = layerLimit(sku, rules);
    const gaps: Space[] = [];
    rows.forEach((row, k) => {
      const z = k * o.dz;
      let y = 0;
      for (const slot of [...row].sort((p, q) => p.y - q.y)) {
        if (slot.y - y > 1) gaps.push({ x, y, z, l: depth, w: slot.y - y, h: o.dz, stackCount: k, stackLimit: limit });
        if (slot.dx < depth - 1) gaps.push({ x: x + slot.dx, y: slot.y, z, l: depth - slot.dx, w: slot.dy, h: o.dz, stackCount: k, stackLimit: limit });
        y = slot.y + slot.dy;
      }
      if (truck.width - y > 1) gaps.push({ x, y, z, l: depth, w: truck.width - y, h: o.dz, stackCount: k, stackLimit: limit });
    });
    const top = rows.length * o.dz;
    const above: Space | null = ceiling - top > 1 ? { x, y: 0, z: top, l: depth, w: truck.width, h: ceiling - top, stackCount: rows.length, stackLimit: limit } : null;
    // The space above the tier; filled first when the previous SKU's last cartons wait for it.
    if (above) {
      if (tail != null) gaps.unshift(above);
      else gaps.push(above);
    }
    const aboveWeight = (i: number) => (split && i === main ? 0 : weight(i));

    for (const gap of gaps) {
      const fill = fillSpaces([gap], lines, remaining, { rules, rng, noise, lineWeight: gap === above ? aboveWeight : weight, tierOf: () => tierNo });
      // Gaps may sit over other gaps, so keep only fillers that are fully supported.
      fill.sort((p, q) => p.z - q.z);
      for (const b of fill) {
        if (supportFraction(b, boxes) >= 0.999) boxes.push(b);
        else giveBack(b);
      }
    }
  }

  // Safety first: fillers that would tip or slide are left out, with anything resting on them. The
  // previous SKU's last cartons stay (they are part of the order and would only stand alone elsewhere).
  const tailId = tail != null ? lines[tail].sku.id : null;
  if (rules.safetyFirst && boxes.length > mainCount) {
    for (let pass = 0; pass < 4; pass++) {
      const all = [...prevBoxes, ...boxes];
      const flagged = new Set(checkStability(all, truck, { physics: rules.physics, reversed }).flagged.map((i) => all[i]));
      const keep: PlacedBox[] = boxes.slice(0, mainCount);
      let dropped = false;
      for (const b of boxes.slice(mainCount).sort((p, q) => p.z - q.z)) {
        if ((flagged.has(b) && b.skuId !== tailId) || supportFraction(b, keep) < 0.999) {
          giveBack(b);
          dropped = true;
        } else keep.push(b);
      }
      boxes.length = 0;
      boxes.push(...keep);
      if (!dropped) break;
    }
  }

  return {
    boxes,
    meta: { columns: pattern.a.length, layers: rows.length, interlocked: !!pattern.b && rows.length > 1 },
    fullTop: wallHeight(boxes, truck.width, Math.max(rules.maxGapCm, spare + 0.5)),
  };
}

/** Orientations for a tier's main SKU, densest first: cartons in a full tier per centimetre of truck length. */
function rankOrientations(req: PlanRequest, line: number, spaceLeft: number) {
  const { truck, lines, rules } = req;
  const sku = lines[line].sku;
  return orientations(sku, rules.rotation)
    .filter((o) => o.dx <= spaceLeft && o.dy <= truck.width && o.dz <= truck.height)
    .map((o) => {
      const p = rowPattern(truck.width, o, o.dx, rules.interlock, rules.interlockMinSupport, rules.maxGapCm);
      const layers = Math.min(Math.floor(truck.height / o.dz), layerLimit(sku, rules));
      const perTier = Math.ceil(layers / 2) * p.a.length + Math.floor(layers / 2) * (p.b ?? p.a).length;
      return { o, interlocked: !!p.b && layers > 1, density: perTier / o.dx };
    })
    // When the rules ask for interlocking, orientations that can interlock come first.
    .sort((p, q) => (rules.interlock ? Number(q.interlocked) - Number(p.interlocked) : 0) || q.density - p.density);
}

/**
 * Builds the load tier by tier from the cab. Each tier's main SKU sets its depth; with
 * `lineOrder` the main SKU is the next line in shipment order, otherwise the search picks it
 * (with `groupBySku`, only once the previous SKU is finished). When a SKU's last cartons would
 * stand alone as a short tier, they are laid on top of the next SKU's first tier instead.
 */
export function tierAttempt(req: PlanRequest, rng: () => number, noise: number): { boxes: PlacedBox[]; meta: Map<number, Partial<Tier>> } {
  const { truck, lines, rules } = req;
  const remaining = lines.map((l) => (l.qty == null ? Infinity : Math.max(0, Math.floor(l.qty))));
  const sequence = loadingSequence(lines);
  const out: PlacedBox[] = [];
  const meta = new Map<number, Partial<Tier>>();
  let x = 0;
  let tierNo = 0;
  // The cab wall holds the first tier at any height.
  let prevTop = Infinity;
  /** Main SKU of the previous tier; with groupBySku it carries on until it is finished. */
  let current: number | undefined;
  const fitsIn = (i: number, left: number) =>
    remaining[i] > 0 && orientations(lines[i].sku, rules.rotation).some((o) => o.dx <= left && o.dy <= truck.width && o.dz <= truck.height);
  /** Picks the orientation of a tier's main SKU: the densest, or in search runs sometimes another. */
  const pickOrientation = (line: number, left: number) => {
    const ranked = rankOrientations(req, line, left);
    // Never trade an interlocking orientation for one that cannot interlock.
    const options = ranked.filter((r) => r.interlocked === ranked[0].interlocked);
    // With safety first search runs try more, because flat walls of equal height matter more than density there.
    const explore = rules.safetyFirst ? 0.5 : 0.3;
    return noise > 0 && options.length > 1 && rng() < explore ? options[1 + Math.floor(rng() * Math.min(2, options.length - 1))] : options[0];
  };
  while (x < truck.length) {
    const left = truck.length - x;
    const fits = (i: number) => fitsIn(i, left);
    let main = rules.groupBySku && current !== undefined && fits(current) ? current : sequence.find(fits);
    if (main === undefined) break;
    if (!rules.lineOrder && noise > 0 && !(rules.groupBySku && main === current)) {
      // Any fixed-quantity line may lead the tier; "fill max" lines only once those are done.
      const pool = sequence.filter((i) => fits(i) && (lines[i].qty == null) === (lines[main!].qty == null));
      main = pool[Math.floor(rng() * pool.length)];
    }
    let choice = pickOrientation(main, left);
    let tail: number | undefined;
    if (Number.isFinite(remaining[main]) && (rules.mixing !== 'none' || rules.groupBySku)) {
      // A short last tier of a few cartons is hard to load and unstable: lay them on the next SKU's tier.
      const { perTier, perRow } = tierCapacity(req, main, choice.o);
      const short = remaining[main] < perTier && Math.ceil(remaining[main] / Math.max(1, perRow)) * choice.o.dz < truck.height / 2;
      const candidates = sequence.filter((i) => i !== main && fits(i));
      let next = rules.lineOrder || !candidates.length ? candidates[0] : candidates[Math.floor(rng() * candidates.length)];
      if (rules.lineOrder) next = sequence.slice(sequence.indexOf(main) + 1).find(fits) ?? candidates[0];
      if (short && next !== undefined && (noise === 0 || rng() < 0.75)) {
        const nextChoice = pickOrientation(next, left);
        const need = tailHeight(req, main, remaining[main], nextChoice.o.dx);
        if (need != null && truck.height - need >= nextChoice.o.dz) {
          tail = main;
          main = next;
          choice = nextChoice;
        }
      }
    }
    tierNo++;
    const prevBoxes = rules.safetyFirst ? out.filter((b) => b.tier === tierNo - 1) : [];
    const tier = buildTier(req, x, main, choice.o, tierNo, remaining, rng, noise, sequence, prevTop, prevBoxes, { tail });
    if (!tier.boxes.length) {
      remaining[main] = 0;
      tierNo--;
      continue;
    }
    out.push(...tier.boxes);
    meta.set(tierNo, tier.meta);
    prevTop = tier.fullTop;
    current = main;
    x += choice.o.dx;
  }
  return { boxes: out, meta };
}
