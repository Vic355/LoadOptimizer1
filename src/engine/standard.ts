import type { PlacedBox, PlanRequest, PlanResult, Tier } from './types';
import { initialRemaining, loadingSequence, orientations, stackCeiling, summarise } from './common';

/**
 * Standard model: strict tiers. Each tier is one SKU in one orientation, laid out as a
 * full grid of columns across the width and layers up to the stack ceiling. SKUs are
 * loaded in shipment-order sequence from the cab; a new SKU always starts a new tier.
 */
export function runStandard(req: PlanRequest): PlanResult {
  const t0 = performance.now();
  const { truck, lines } = req;
  const remaining = initialRemaining(lines);
  const boxes: PlacedBox[] = [];
  const tiers: Tier[] = [];
  let x = 0;

  for (const li of loadingSequence(lines)) {
    const sku = lines[li].sku;
    const ceiling = stackCeiling(sku, truck);
    // Orientation with the most cartons per centimetre of truck length.
    let best: { dx: number; dy: number; dz: number; cols: number; layers: number; density: number } | null = null;
    for (const o of orientations(sku)) {
      const cols = Math.floor(truck.width / o.dy);
      const layers = Math.floor(ceiling / o.dz);
      if (cols < 1 || layers < 1) continue;
      const density = (cols * layers) / o.dx;
      if (!best || density > best.density) best = { ...o, cols, layers, density };
    }
    if (!best) continue;
    const perTier = best.cols * best.layers;

    while (remaining[li] > 0 && x + best.dx <= truck.length) {
      const count = Math.min(perTier, remaining[li]);
      const tierNo = tiers.length + 1;
      const tierCounts: Record<number, number> = { [sku.id]: count };
      // Partial tiers are filled column by column, bottom to top, from one wall.
      let placed = 0;
      for (let c = 0; c < best.cols && placed < count; c++)
        for (let k = 0; k < best.layers && placed < count; k++, placed++)
          boxes.push({
            skuId: sku.id,
            x,
            y: c * best.dy,
            z: k * best.dz,
            dx: best.dx,
            dy: best.dy,
            dz: best.dz,
            tier: tierNo,
          });
      tiers.push({
        index: tierNo,
        x0: x,
        depth: best.dx,
        counts: tierCounts,
        total: count,
        columns: best.cols,
        layers: best.layers,
        uniform: true,
      });
      remaining[li] -= count;
      x += best.dx;
    }
  }
  return summarise('standard', truck, lines, boxes, tiers, 1, t0);
}
