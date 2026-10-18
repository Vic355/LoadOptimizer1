import type { ModelId, PlacedBox, PlanRequest, PlanResult, SearchProgress, Tier } from './types';
import { fillSpaces, type Space } from './blocks';
import { buildTiersFromBoxes, fillerWeight, initialRemaining, makeRng, planScore, summarise } from './common';
import { tierAttempt } from './tiers';

const MAX_ITERATIONS = 200_000;
const PROGRESS_EVERY_MS = 150;

interface Attempt {
  boxes: PlacedBox[];
  meta: Map<number, Partial<Tier>> | null;
}

/** Runs `attempt` with increasing randomness until the time budget runs out and keeps the best plan. */
function search(req: PlanRequest, attempt: (rng: () => number, noise: number, iteration: number) => Attempt, onProgress?: (p: SearchProgress) => void) {
  const budget = req.timeBudgetMs ?? req.rules.searchSeconds * 1000;
  const rng = makeRng(req.seed ?? 20261018);
  const start = performance.now();
  let best = attempt(rng, 0, 0);
  let bestScore = planScore(best.boxes);
  let evaluated = 1;
  let lastReport = start;
  while (evaluated < MAX_ITERATIONS) {
    const now = performance.now();
    if (now - start >= budget) break;
    if (onProgress && now - lastReport >= PROGRESS_EVERY_MS) {
      lastReport = now;
      onProgress({ evaluated, bestCartons: best.boxes.length, fraction: (now - start) / budget });
    }
    const noise = 0.1 + 0.4 * rng();
    const next = attempt(rng, noise, evaluated);
    evaluated++;
    const score = planScore(next.boxes);
    if (score > bestScore) {
      best = next;
      bestScore = score;
    }
  }
  onProgress?.({ evaluated, bestCartons: best.boxes.length, fraction: 1 });
  return { best, evaluated };
}

/** Treats the whole truck as one open space (no tiers). */
function openAttempt(req: PlanRequest, rng: () => number, noise: number): Attempt {
  const { truck, lines, rules } = req;
  const remaining = initialRemaining(lines);
  const weights = lines.map(() => (noise > 0 ? 0.8 + 0.4 * rng() : 1));
  const root: Space = { x: 0, y: 0, z: 0, l: truck.length, w: truck.width, h: truck.height, stackCount: 0, stackLimit: Infinity };
  const boxes = fillSpaces([root], lines, remaining, { rules, rng, noise, lineWeight: (i) => weights[i] * fillerWeight(lines, i), tierOf: () => 0 });
  return { boxes, meta: null };
}

/**
 * Runs one model with its rules. Without tiers (Bebas by default) the search alternates
 * open-space packing and tier building and keeps whichever loads the most; loads without
 * real tiers are grouped into fixed-depth segments for counting and photos.
 */
export function runModel(model: ModelId, req: PlanRequest, onProgress?: (p: SearchProgress) => void): PlanResult {
  const t0 = performance.now();
  const { best, evaluated } = search(
    req,
    (rng, noise, iteration) => {
      if (!req.rules.tiers && iteration % 2 === 0) return openAttempt(req, rng, noise);
      return tierAttempt(req, rng, noise);
    },
    onProgress,
  );
  const boxes = best.boxes;
  if (best.meta) return summarise(model, req.rules, req.truck, req.lines, boxes, buildTiersFromBoxes(boxes, best.meta), evaluated, t0);
  const seg = req.freeSegmentDepth ?? 100;
  for (const b of boxes) b.tier = Math.floor((b.x + b.dx / 2) / seg) + 1;
  const tiers = buildTiersFromBoxes(boxes).map((t) => ({ ...t, x0: (t.index - 1) * seg, depth: seg }));
  return summarise(model, req.rules, req.truck, req.lines, boxes, tiers, evaluated, t0, true);
}
