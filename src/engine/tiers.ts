import type { PlacedBox, PlanRequest, Tier } from './types';
import { fillSpaces, type Space } from './blocks';
import { fillerWeight, layerLimit, loadingSequence, orientations, supportFraction, type Orientation } from './common';

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

/** Positions where two neighbouring cartons in a row meet (the row's two ends are not joints). */
function joints(row: Slot[]): number[] {
  return row.slice(0, -1).map((s) => s.y + s.dy);
}

/**
 * Row patterns for a tier of one SKU. The even row is a straight row of the narrowest side;
 * the odd row offsets the joints, either by shifting half a carton (when the spare width allows)
 * or by turning cartons 90° at the ends so the row stays full. Patterns that leave a carton
 * with less support than `minSupport` are rejected, and the tier falls back to straight columns.
 */
export function rowPattern(width: number, o: Orientation, depth: number, interlock: boolean, minSupport: number): Pattern {
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
    if (!best || row.length > best.length) best = row;
  }
  return { a, b: best };
}

interface TierBuild {
  boxes: PlacedBox[];
  meta: Partial<Tier>;
}

/**
 * Builds one tier at `x`: the main SKU in its row pattern, layer by layer from the floor, then
 * (when mixing is allowed) other SKUs in the gaps beside, behind turned cartons and above it.
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
): TierBuild {
  const { truck, lines, rules } = req;
  const sku = lines[main].sku;
  const depth = o.dx;
  const pattern = rowPattern(truck.width, o, depth, rules.interlock, rules.interlockMinSupport);
  const maxLayers = Math.min(Math.floor(truck.height / o.dz), layerLimit(sku, rules));
  const boxes: PlacedBox[] = [];
  const rows: Slot[][] = [];

  for (let k = 0; k < maxLayers && remaining[main] > 0; k++) {
    const row = k % 2 === 1 && pattern.b ? pattern.b : pattern.a;
    const placed: Slot[] = [];
    for (const slot of row) {
      if (remaining[main] <= 0) break;
      boxes.push({ skuId: sku.id, x, y: slot.y, z: k * o.dz, dx: slot.dx, dy: slot.dy, dz: o.dz, tier: tierNo });
      placed.push(slot);
      remaining[main]--;
    }
    rows.push(placed);
  }

  if (rules.mixing !== 'none') {
    const nextInOrder = sequence[sequence.indexOf(main) + 1];
    const weight = (i: number) => {
      const base = fillerWeight(lines, i);
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
    if (truck.height - top > 1) gaps.push({ x, y: 0, z: top, l: depth, w: truck.width, h: truck.height - top, stackCount: rows.length, stackLimit: limit });

    for (const gap of gaps) {
      const fill = fillSpaces([gap], lines, remaining, { rules, rng, noise, lineWeight: weight, tierOf: () => tierNo });
      // Gaps may sit over other gaps, so keep only fillers that are fully supported.
      fill.sort((p, q) => p.z - q.z);
      for (const b of fill) {
        if (supportFraction(b, boxes) >= 0.999) boxes.push(b);
        else remaining[lines.findIndex((l) => l.sku.id === b.skuId)]++;
      }
    }
  }

  return {
    boxes,
    meta: { columns: pattern.a.length, layers: rows.length, interlocked: !!pattern.b && rows.length > 1 },
  };
}

/** Orientations for a tier's main SKU, densest first: cartons in a full tier per centimetre of truck length. */
function rankOrientations(req: PlanRequest, line: number, spaceLeft: number) {
  const { truck, lines, rules } = req;
  const sku = lines[line].sku;
  return orientations(sku, rules.rotation)
    .filter((o) => o.dx <= spaceLeft && o.dy <= truck.width && o.dz <= truck.height)
    .map((o) => {
      const p = rowPattern(truck.width, o, o.dx, rules.interlock, rules.interlockMinSupport);
      const layers = Math.min(Math.floor(truck.height / o.dz), layerLimit(sku, rules));
      const perTier = Math.ceil(layers / 2) * p.a.length + Math.floor(layers / 2) * (p.b ?? p.a).length;
      return { o, interlocked: !!p.b && layers > 1, density: perTier / o.dx };
    })
    // When the rules ask for interlocking, orientations that can interlock come first.
    .sort((p, q) => (rules.interlock ? Number(q.interlocked) - Number(p.interlocked) : 0) || q.density - p.density);
}

/**
 * Builds the load tier by tier from the cab. Each tier's main SKU sets its depth; with
 * `lineOrder` the main SKU is the next line in shipment order, otherwise the search picks it.
 */
export function tierAttempt(req: PlanRequest, rng: () => number, noise: number): { boxes: PlacedBox[]; meta: Map<number, Partial<Tier>> } {
  const { truck, lines, rules } = req;
  const remaining = lines.map((l) => (l.qty == null ? Infinity : Math.max(0, Math.floor(l.qty))));
  const sequence = loadingSequence(lines);
  const out: PlacedBox[] = [];
  const meta = new Map<number, Partial<Tier>>();
  let x = 0;
  let tierNo = 0;
  while (x < truck.length) {
    const left = truck.length - x;
    const fits = (i: number) =>
      remaining[i] > 0 && orientations(lines[i].sku, rules.rotation).some((o) => o.dx <= left && o.dy <= truck.width && o.dz <= truck.height);
    let main = sequence.find(fits);
    if (main === undefined) break;
    if (!rules.lineOrder && noise > 0) {
      // Any fixed-quantity line may lead the tier; "fill max" lines only once those are done.
      const pool = sequence.filter((i) => fits(i) && (lines[i].qty == null) === (lines[main!].qty == null));
      main = pool[Math.floor(rng() * pool.length)];
    }
    const ranked = rankOrientations(req, main, left);
    // Never trade an interlocking orientation for one that cannot interlock.
    const options = ranked.filter((r) => r.interlocked === ranked[0].interlocked);
    // The greedy run takes the densest orientation; search runs sometimes try the runner-up.
    const choice = noise > 0 && options.length > 1 && rng() < 0.3 ? options[1] : options[0];
    tierNo++;
    const tier = buildTier(req, x, main, choice.o, tierNo, remaining, rng, noise, sequence);
    if (!tier.boxes.length) {
      remaining[main] = 0;
      tierNo--;
      continue;
    }
    out.push(...tier.boxes);
    meta.set(tierNo, tier.meta);
    x += choice.o.dx;
  }
  return { boxes: out, meta };
}
