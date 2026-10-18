import type { PlacedBox, PlanRequest, PlanResult, Tier } from './types';
import { fillSpaces, type Space } from './blocks';
import { buildTiersFromBoxes, fillerWeight, initialRemaining, loadingSequence, makeRng, orientations, planScore, stackCeiling, summarise } from './common';

const DEFAULT_BUDGET_MS = 600;
const MAX_ITERATIONS = 3000;

/** Runs `attempt` with increasing randomness until the time budget runs out and keeps the best plan. */
function search(
  req: PlanRequest,
  attempt: (rng: () => number, noise: number, iteration: number) => PlacedBox[],
): { boxes: PlacedBox[]; evaluated: number } {
  const budget = req.timeBudgetMs ?? DEFAULT_BUDGET_MS;
  const rng = makeRng(req.seed ?? 20261018);
  const start = performance.now();
  let best = attempt(rng, 0, 0);
  let bestScore = planScore(best);
  let evaluated = 1;
  while (evaluated < MAX_ITERATIONS && performance.now() - start < budget) {
    const noise = 0.1 + 0.4 * rng();
    const boxes = attempt(rng, noise, evaluated);
    evaluated++;
    const score = planScore(boxes);
    if (score > bestScore) {
      best = boxes;
      bestScore = score;
    }
  }
  return { boxes: best, evaluated };
}

/**
 * Free model: no tier rules. SKUs and orientations are mixed wherever they fit best; the
 * search loop tries open-space block building and wall building in random SKU orders.
 */
export function runFree(req: PlanRequest): PlanResult {
  const t0 = performance.now();
  const { truck, lines } = req;
  const { boxes, evaluated } = search(req, (rng, noise, iteration) => {
    // Even attempts treat the truck as one open space; odd attempts build walls, in
    // shipment order or in any SKU order. The free model keeps whichever loads the most.
    if (iteration % 2 === 1) return wallAttempt(req, rng, noise, iteration % 4 === 3);
    const remaining = initialRemaining(lines);
    const weights = lines.map(() => (noise > 0 ? 0.8 + 0.4 * rng() : 1));
    const root: Space = { x: 0, y: 0, z: 0, l: truck.length, w: truck.width, h: truck.height, ceiling: truck.height, balesOnly: false };
    return fillSpaces([root], lines, remaining, { rng, noise, lineWeight: (i) => weights[i] * fillerWeight(lines, i), tierOf: () => 0 });
  });
  // The free model has no real tiers; group boxes into fixed-depth segments for counting and photos.
  const seg = req.freeSegmentDepth ?? 100;
  for (const b of boxes) b.tier = Math.floor((b.x + b.dx / 2) / seg) + 1;
  const tiers = buildTiersFromBoxes(boxes).map((t) => ({ ...t, x0: (t.index - 1) * seg, depth: seg }));
  return summarise('free', truck, lines, boxes, tiers, evaluated, t0, true);
}

/**
 * Builds the load wall by wall from the cab. Each wall's primary SKU sets the wall depth and
 * fills most of it; gaps at the side wall and under the ceiling are filled with other SKUs.
 * `anyPrimary` lets the search pick primaries out of shipment order (used by the free model).
 */
function wallAttempt(req: PlanRequest, rng: () => number, noise: number, anyPrimary: boolean): PlacedBox[] {
  const { truck, lines } = req;
  const remaining = initialRemaining(lines);
  const out: PlacedBox[] = [];
  const sequence = loadingSequence(lines);
  let x = 0;
  let tierNo = 0;
  while (x < truck.length) {
    const fits = (i: number) => remaining[i] > 0 && orientations(lines[i].sku).some((o) => o.dx <= truck.length - x);
    let primary = sequence.find(fits);
    if (primary === undefined) break;
    if (anyPrimary && noise > 0) {
      // Any fixed-quantity line may lead the wall; "fill max" lines only once those are done.
      const pool = sequence.filter((i) => fits(i) && (lines[i].qty == null) === (lines[primary!].qty == null));
      primary = pool[Math.floor(rng() * pool.length)];
    }
    const sku = lines[primary].sku;
    const ceiling = stackCeiling(sku, truck);
    const options = orientations(sku)
      .filter((o) => o.dx <= truck.length - x && o.dy <= truck.width && o.dz <= ceiling)
      .map((o) => ({ o, density: (Math.floor(truck.width / o.dy) * Math.floor(ceiling / o.dz)) / o.dx }))
      .sort((a, b) => b.density - a.density);
    if (!options.length) {
      remaining[primary] = 0;
      continue;
    }
    // Greedy run takes the densest orientation; search runs sometimes try the runner-up.
    const choice = noise > 0 && options.length > 1 && rng() < 0.3 ? options[1] : options[0];
    const depth = choice.o.dx;
    tierNo++;
    const tierSpace: Space = { x, y: 0, z: 0, l: depth, w: truck.width, h: truck.height, ceiling: truck.height, balesOnly: false };
    const lead = primary;
    const placed = fillSpaces([tierSpace], lines, remaining, {
      rng,
      noise,
      lineWeight: (i) => (i === lead ? 4 : fillerWeight(lines, i)),
      tierOf: () => tierNo,
    });
    if (!placed.length) {
      remaining[primary] = 0;
      tierNo--;
      continue;
    }
    out.push(...placed);
    x += depth;
  }
  return out;
}

/**
 * Mixed model: still built tier by tier from the cab, but a tier is not limited to one SKU.
 * The tier's primary SKU (next in shipment order) sets the tier depth and fills most of it;
 * the gaps it leaves at the side wall and under the ceiling are filled with other SKUs.
 */
export function runMixed(req: PlanRequest): PlanResult {
  const t0 = performance.now();
  const { boxes, evaluated } = search(req, (rng, noise) => wallAttempt(req, rng, noise, false));
  const tiers: Tier[] = buildTiersFromBoxes(boxes);
  return summarise('mixed', req.truck, req.lines, boxes, tiers, evaluated, t0);
}
