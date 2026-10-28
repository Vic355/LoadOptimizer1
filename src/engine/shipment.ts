import type { EngineLine, ModelId, PlanResult, SearchProgress, ShipmentRequest, ShipmentResult } from './types';
import { runModel } from './models';

/** Safety stop for very large orders; the rest is listed as unplaced. */
export const MAX_TRUCKS = 30;

/**
 * Plans a shipment truck by truck: each truck takes what is left of the fixed quantities, in line
 * order, and "fill max" lines fill whatever space each truck has left. A new truck is added while
 * fixed quantities remain; trucks after the given list repeat the last one.
 */
export function runShipment(model: ModelId, req: ShipmentRequest, onProgress?: (p: SearchProgress) => void): ShipmentResult {
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
