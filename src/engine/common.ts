import type { EngineLine, EngineSku, ModelId, PlacedBox, PlanResult, Tier, EngineTruck } from './types';
import type { ModelRules } from './rules';
import { checkStability } from './stability';

export interface Orientation {
  dx: number;
  dy: number;
  dz: number;
}

/** Distinct orientations of a carton allowed by the model's rotation rule. */
export function orientations(sku: EngineSku, rotation: ModelRules['rotation']): Orientation[] {
  const { length: l, width: w, height: h } = sku;
  const raw: [number, number, number][] = [
    [l, w, h],
    [w, l, h],
  ];
  if (rotation === 'any' || (rotation === 'sku' && sku.canLieDown)) raw.push([l, h, w], [h, l, w], [w, h, l], [h, w, l]);
  const seen = new Set<string>();
  const out: Orientation[] = [];
  for (const [dx, dy, dz] of raw) {
    const key = `${dx}|${dy}|${dz}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ dx, dy, dz });
    }
  }
  return out;
}

/** Stack limit in cartons for a SKU under the model's rules. */
export function layerLimit(sku: EngineSku, rules: ModelRules): number {
  return rules.respectSafeStack ? Math.max(1, sku.safeLayers) : Infinity;
}

/** Small deterministic PRNG (mulberry32) so a seed reproduces the same search. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Remaining quantity per line; Infinity stands for "fill as many as fit". */
export function initialRemaining(lines: EngineLine[]): number[] {
  return lines.map((l) => (l.qty == null ? Infinity : Math.max(0, Math.floor(l.qty))));
}

/** Line indexes in loading sequence: fixed quantities in shipment order, then "fill max" lines. */
export function loadingSequence(lines: EngineLine[]): number[] {
  const idx = lines.map((_, i) => i);
  return [...idx.filter((i) => lines[i].qty != null), ...idx.filter((i) => lines[i].qty == null)];
}

/** "Fill max" lines only take space no fixed-quantity line can use. */
export function fillerWeight(lines: EngineLine[], i: number): number {
  return lines[i].qty == null ? 0.001 : 1;
}

/** Share of a box's base resting on the tops of `others` (1 on the floor). */
export function supportFraction(b: PlacedBox, others: PlacedBox[]): number {
  if (b.z < 0.5) return 1;
  let area = 0;
  for (const o of others) {
    if (o === b || Math.abs(o.z + o.dz - b.z) > 0.5) continue;
    const ox = Math.min(b.x + b.dx, o.x + o.dx) - Math.max(b.x, o.x);
    const oy = Math.min(b.y + b.dy, o.y + o.dy) - Math.max(b.y, o.y);
    if (ox > 0 && oy > 0) area += ox * oy;
  }
  return area / (b.dx * b.dy);
}

export function buildTiersFromBoxes(boxes: PlacedBox[], meta?: Map<number, Partial<Tier>>): Tier[] {
  const byTier = new Map<number, PlacedBox[]>();
  for (const b of boxes) {
    const list = byTier.get(b.tier);
    if (list) list.push(b);
    else byTier.set(b.tier, [b]);
  }
  const tiers: Tier[] = [];
  for (const [index, list] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
    const counts: Record<number, number> = {};
    let x0 = Infinity;
    let x1 = 0;
    for (const b of list) {
      counts[b.skuId] = (counts[b.skuId] ?? 0) + 1;
      x0 = Math.min(x0, b.x);
      x1 = Math.max(x1, b.x + b.dx);
    }
    tiers.push({ index, x0, depth: x1 - x0, counts, total: list.length, uniform: Object.keys(counts).length === 1, ...meta?.get(index) });
  }
  return tiers;
}

export function summarise(
  model: ModelId,
  rules: ModelRules,
  truck: EngineTruck,
  lines: EngineLine[],
  boxes: PlacedBox[],
  tiers: Tier[],
  plansEvaluated: number,
  startedAt: number,
  segmentTiers = false,
): PlanResult {
  const loaded: Record<number, number> = {};
  const unplaced: Record<number, number> = {};
  const skuById = new Map(lines.map((l) => [l.sku.id, l.sku]));
  let loadedVolume = 0;
  let usedLength = 0;
  let totalWeight = 0;
  for (const b of boxes) {
    loaded[b.skuId] = (loaded[b.skuId] ?? 0) + 1;
    loadedVolume += b.dx * b.dy * b.dz;
    usedLength = Math.max(usedLength, b.x + b.dx);
    totalWeight += skuById.get(b.skuId)?.weight ?? 0;
  }
  for (const l of lines) {
    if (l.qty != null) {
      const missing = l.qty - (loaded[l.sku.id] ?? 0);
      if (missing > 0) unplaced[l.sku.id] = missing;
    }
  }
  const truckVolume = truck.length * truck.width * truck.height;
  return {
    model,
    rules,
    boxes,
    tiers,
    loaded,
    unplaced,
    totalCartons: boxes.length,
    loadedVolume,
    volumeUtilization: truckVolume > 0 ? loadedVolume / truckVolume : 0,
    usedLength,
    totalWeight,
    plansEvaluated,
    elapsedMs: Math.round(performance.now() - startedAt),
    segmentTiers,
    stability: checkStability(boxes, truck, { physics: rules.physics }),
  };
}

/** Score used by the search loops: more cartons first, then more volume, then a shorter load. */
export function planScore(boxes: PlacedBox[]): number {
  let volume = 0;
  let length = 0;
  for (const b of boxes) {
    volume += b.dx * b.dy * b.dz;
    length = Math.max(length, b.x + b.dx);
  }
  return boxes.length * 1e12 + volume * 10 - length;
}
