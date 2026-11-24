import type { EngineLine, ModelId, PlanResult, SearchProgress, ShipmentRequest, ShipmentResult, TruckTargetResult } from './types';
import { runModel } from './models';

/** Safety stop for very large orders; the rest is listed as unplaced. */
export const MAX_TRUCKS = 30;

/**
 * Plans a shipment truck by truck: each truck takes what is left of the fixed quantities, in line
 * order, and "fill max" lines fill whatever space each truck has left. A new truck is added while
 * fixed quantities remain; trucks after the given list repeat the last one.
 */
export function runShipment(model: ModelId, req: ShipmentRequest, onProgress?: (p: SearchProgress) => void): ShipmentResult {
  if (!req.truckTarget) return planShipment(model, req, onProgress);
  return planToTarget(model, req, req.truckTarget, onProgress);
}

/** Extra search rounds when a truck target is not met, and the most extra time they may take (in search budgets). */
const TARGET_ROUNDS = 6;
const TARGET_TIME = 5;

/** Fewest trucks the fixed quantities need by carton volume alone, filling the trucks given in order. */
export function volumeLowerBound(req: ShipmentRequest): number {
  let volume = 0;
  for (const l of req.lines) if (l.qty != null && !l.fitShare) volume += l.qty * l.sku.length * l.sku.width * l.sku.height;
  if (volume <= 0) return 1;
  const limit = Math.min(req.maxTrucks ?? MAX_TRUCKS, MAX_TRUCKS);
  for (let k = 0; k < limit; k++) {
    const tr = req.trucks[Math.min(k, req.trucks.length - 1)];
    volume -= tr.length * tr.width * tr.height;
    if (volume <= 0) return k + 1;
  }
  return limit;
}

/** Fewer cartons left behind first, then fewer trucks, then more cartons loaded. */
function fewerTrucks(a: ShipmentResult, b: ShipmentResult): boolean {
  const left = (r: ShipmentResult) => Object.values(r.unplaced).reduce((s, n) => s + n, 0);
  if (left(a) !== left(b)) return left(a) < left(b);
  if (a.trucks.length !== b.trucks.length) return a.trucks.length < b.trucks.length;
  return a.totalCartons > b.totalCartons;
}

/**
 * Plans the shipment, then keeps searching with new random starts and more time while it needs
 * more trucks than the goal, and keeps the plan with the fewest trucks.
 */
function planToTarget(model: ModelId, req: ShipmentRequest, target: number | 'min', onProgress?: (p: SearchProgress) => void): ShipmentResult {
  const t0 = performance.now();
  const lowerBound = volumeLowerBound(req);
  const goal = target === 'min' ? lowerBound : Math.max(1, Math.floor(target));
  const budget = req.timeBudgetMs ?? req.rules.searchSeconds * 1000;
  let best = planShipment(model, req, onProgress);
  let evaluated = best.plansEvaluated;
  let rounds = 1;
  // A goal below what the cartons' volume needs cannot be met by any plan, so no time is spent on it.
  if (goal >= lowerBound) {
    while (best.trucks.length > goal && rounds < TARGET_ROUNDS && performance.now() - t0 < budget * TARGET_TIME) {
      const next = planShipment(model, { ...req, seed: (req.seed ?? 20261018) + rounds * 7919, timeBudgetMs: budget * (1 + rounds * 0.5) }, onProgress);
      evaluated += next.plansEvaluated;
      rounds++;
      if (fewerTrucks(next, best)) best = next;
    }
  }
  const info: TruckTargetResult = { goal, lowerBound, reached: best.trucks.length <= goal && !Object.keys(best.unplaced).length, rounds };
  return { ...best, plansEvaluated: evaluated, elapsedMs: Math.round(performance.now() - t0), target: info };
}

function planShipment(model: ModelId, req: ShipmentRequest, onProgress?: (p: SearchProgress) => void): ShipmentResult {
  const requestedOf = (lines: EngineLine[]) => Object.fromEntries(lines.filter((l) => l.qty != null).map((l) => [l.sku.id, l.qty as number]));
  if (!req.lines.some((l) => l.fitShare && l.qty)) return { ...runTrucks(model, req, onProgress), requested: requestedOf(req.lines) };

  // Share lines (a percentage of what fits) must stay on the trucks given. Their first estimate can
  // be a little more than the models manage, so scale them down until nothing of them spills.
  const n = req.trucks.length;
  const budget = req.timeBudgetMs ?? req.rules.searchSeconds * 1000;
  const t0 = performance.now();
  let evaluated = 0;
  const scaled = (f: number) => req.lines.map((l) => (l.fitShare && l.qty ? { ...l, qty: Math.max(0, Math.floor(l.qty * f)) } : l));
  const shares = req.lines.filter((l) => l.fitShare && (l.qty ?? 0) > 0);
  const onGiven = (r: ShipmentResult, id: number) => r.trucks.slice(0, n).reduce((s, p) => s + (p.loaded[id] ?? 0), 0);
  /** Plans with the share lines scaled by f; null when some of them would leave the trucks given. */
  const attempt = (f: number, ms: number) => {
    const lines = scaled(f);
    const r = runTrucks(model, { ...req, lines, timeBudgetMs: ms }, onProgress);
    evaluated += r.plansEvaluated;
    const fits = lines.every((l) => !l.fitShare || !l.qty || onGiven(r, l.sku.id) >= l.qty);
    return { r, lines, fits };
  };
  const done = (x: { r: ShipmentResult; lines: EngineLine[] }) => ({ ...x.r, requested: requestedOf(x.lines), plansEvaluated: evaluated, elapsedMs: Math.round(performance.now() - t0) });

  const first = attempt(1, budget);
  if (first.fits) {
    // The estimate is a plain grid; models that turn or interlock cartons often fit more, so try a little more.
    let best = first;
    for (const up of [1.12, 1.25]) {
      const x = attempt(up, budget / 3);
      if (!x.fits) break;
      best = x;
    }
    return done(best);
  }
  // Search the largest scale that fits: start from the share the first plan managed, then halve the gap.
  const asked = shares.reduce((s, l) => s + (l.qty as number), 0);
  const managed = shares.reduce((s, l) => s + Math.min(l.qty as number, onGiven(first.r, l.sku.id)), 0);
  let lo = 0;
  let hi = 1;
  let best: ReturnType<typeof attempt> | null = null;
  let f = Math.min(0.99, managed / asked);
  for (let pass = 0; pass < 5 && hi - lo > 0.01; pass++) {
    const x = attempt(f, budget / 3);
    if (x.fits) {
      lo = f;
      best = x;
    } else hi = f;
    f = best ? (lo + hi) / 2 : f * 0.9;
  }
  if (best) return done(best);
  // No even split fits (for example a truck one tier deep that will not mix SKUs): keep exactly what
  // the given trucks took of the share lines in the first plan.
  const kept = first.lines.map((l) => (l.fitShare && l.qty ? { ...l, qty: onGiven(first.r, l.sku.id) } : l));
  return done({ r: runTrucks(model, { ...req, lines: kept, timeBudgetMs: budget / 2 }, onProgress), lines: kept });
}

function runTrucks(model: ModelId, req: ShipmentRequest, onProgress?: (p: SearchProgress) => void): ShipmentResult {
  const t0 = performance.now();
  const limit = Math.min(req.maxTrucks ?? MAX_TRUCKS, MAX_TRUCKS);
  const left = new Map(req.lines.map((l) => [l.sku.id, l.qty]));
  const plans: PlanResult[] = [];
  let unplaced: Record<number, number> = {};
  for (let k = 0; k < limit; k++) {
    const lines: EngineLine[] = req.lines.map((l) => ({ sku: l.sku, qty: left.get(l.sku.id) ?? null })).filter((l) => l.qty == null || l.qty > 0);
    const fixedLeft = lines.some((l) => l.qty != null);
    // After the first truck, only fixed quantities call for another truck.
    if (k > 0 && !fixedLeft) break;
    const truck = req.trucks[Math.min(k, req.trucks.length - 1)];
    const plan = runModel(model, { truck, lines, rules: req.rules, timeBudgetMs: req.timeBudgetMs, seed: req.seed }, onProgress && ((p) => onProgress({ ...p, truck: k })));
    unplaced = plan.unplaced;
    // A truck that takes none of the remaining fixed cartons will not be helped by another like it.
    const tookFixed = lines.some((l) => l.qty != null && (plan.loaded[l.sku.id] ?? 0) > 0);
    if (k > 0 && !tookFixed) break;
    plans.push(plan);
    for (const l of lines) if (l.qty != null) left.set(l.sku.id, l.qty - (plan.loaded[l.sku.id] ?? 0));
    if (!fixedLeft || !tookFixed) break;
  }
  return {
    model,
    trucks: plans,
    unplaced,
    totalCartons: plans.reduce((s, p) => s + p.totalCartons, 0),
    plansEvaluated: plans.reduce((s, p) => s + p.plansEvaluated, 0),
    elapsedMs: Math.round(performance.now() - t0),
  };
}
