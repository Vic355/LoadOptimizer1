import type { EngineTruck, PlacedBox, PlanResult, Tier } from './types';
import { buildTiersFromBoxes } from './common';
import { checkStability } from './stability';

/** True when the plan's tiers are real walls that can be moved as a whole (not open-space segments). */
export function canMoveTiers(plan: PlanResult): boolean {
  return !plan.segmentTiers && plan.tiers.length > 1;
}

/**
 * Moves tier `from` to position `to` (both 1-based, in loading order) and slides the tiers in
 * between along by one. Every tier keeps its cartons and its depth; tiers are laid one after
 * another again from where loading starts, so nothing overlaps. Tiers are numbered again in the
 * new loading order and the stability check runs again, since a tier now leans on other tiers.
 */
export function moveTier(plan: PlanResult, from: number, to: number, truck: EngineTruck): PlanResult {
  const n = plan.tiers.length;
  if (!canMoveTiers(plan) || from === to || from < 1 || to < 1 || from > n || to > n) return plan;
  const order = [...plan.tiers].sort((a, b) => a.index - b.index);
  const [moved] = order.splice(from - 1, 1);
  order.splice(to - 1, 0, moved);
  return layOutTiers(plan, order, truck);
}

function layOutTiers(plan: PlanResult, order: Tier[], truck: EngineTruck): PlanResult {
  const fromDoor = plan.rules.fillFrom === 'door';
  // Loading starts where the first tier stands now (the cab, or the door when filling from the door).
  const sorted = [...plan.tiers].sort((a, b) => a.index - b.index);
  const first = sorted[0];
  let along = fromDoor ? truck.length - (first.x0 + first.depth) : first.x0;
  const boxes: PlacedBox[] = [];
  const meta = new Map<number, Partial<Tier>>();
  order.forEach((tier, i) => {
    const x0 = fromDoor ? truck.length - along - tier.depth : along;
    const shift = x0 - tier.x0;
    for (const b of plan.boxes) if (b.tier === tier.index) boxes.push({ ...b, x: b.x + shift, tier: i + 1 });
    meta.set(i + 1, { columns: tier.columns, layers: tier.layers, interlocked: tier.interlocked });
    along += tier.depth;
  });
  let usedLength = 0;
  for (const b of boxes) usedLength = Math.max(usedLength, b.x + b.dx);
  return {
    ...plan,
    boxes,
    tiers: buildTiersFromBoxes(boxes, meta),
    usedLength,
    stability: checkStability(boxes, truck, { physics: plan.rules.physics }),
    edited: true,
  };
}
