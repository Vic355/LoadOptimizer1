import * as repo from './repo';
import type { SavedPlan } from './repo';

// One row per saved plan: what was planned (the inputs of a model) and how it went (what it should
// learn to predict). Exported as CSV so it can be trained on outside the app.

const COLUMNS = [
  'plan_id', 'shipment_no', 'truck_seq', 'plate_no', 'created', 'loaded_on', 'status', 'model',
  'truck', 'truck_length_cm', 'truck_width_cm', 'truck_height_cm',
  'sku_count', 'cartons', 'weight_kg', 'volume_utilization', 'used_length_cm',
  'tiers', 'tier_height_max_cm', 'tier_height_mean_cm', 'tier_step_max_cm', 'interlocked_share',
  'risky', 'tip', 'slide', 'overhang',
  'fill_from', 'safety_first', 'max_gap_cm', 'brake_g', 'accel_g', 'side_g', 'friction',
  'followed_plan', 'complaint', 'affected_cartons', 'actual_total', 'note',
] as const;

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** The CSV cell for a value: quoted when it holds a separator, quote or line break. */
function cell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(p: SavedPlan): Array<string | number | null> {
  const result = repo.planResult(p.id);
  const truck = JSON.parse(p.truck_json) as repo.PlanTruck;
  const outcome = repo.parseOutcome(p);
  const actual = p.actual_json ? (Object.values(JSON.parse(p.actual_json)) as Array<number | null>).filter((v): v is number => v != null) : [];

  // Height of each tier: the top of its tallest carton.
  const tops = new Map<number, number>();
  for (const b of result?.boxes ?? []) tops.set(b.tier, Math.max(tops.get(b.tier) ?? 0, b.z + b.dz));
  const heights = [...tops.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  const steps = heights.slice(1).map((h, i) => Math.abs(h - heights[i]));
  const tiers = result?.tiers ?? [];
  const rules = result?.rules;
  const stability = result?.stability;

  return [
    p.id, p.shipment_no, p.truck_seq, p.plate_no, p.created_at, outcome.loadedOn ?? '', p.status, p.model,
    truck.name, truck.length, truck.width, truck.height,
    result ? Object.keys(result.loaded).length : null, p.total_cartons, result ? round(result.totalWeight) : null, round(p.volume_utilization, 3), result ? round(result.usedLength, 1) : null,
    p.tier_count, heights.length ? Math.max(...heights) : null, heights.length ? round(heights.reduce((a, b) => a + b, 0) / heights.length, 1) : null, steps.length ? Math.max(...steps) : 0,
    tiers.length ? round(tiers.filter((x) => x.interlocked).length / tiers.length, 3) : null,
    stability?.risky ?? null, stability?.tip ?? null, stability?.slide ?? null, stability?.overhang ?? null,
    rules?.fillFrom ?? null, rules ? Number(rules.safetyFirst) : null, rules?.maxGapCm ?? null, rules?.physics.brakeG ?? null, rules?.physics.accelG ?? null, rules?.physics.sideG ?? null, rules?.physics.friction ?? null,
    outcome.followed ?? '', outcome.complaint ?? '', outcome.affectedCartons ?? null, actual.length ? actual.reduce((a, b) => a + b, 0) : null, outcome.note ?? p.planner_note ?? '',
  ];
}

export function trainingCsv(plans: SavedPlan[]): string {
  const lines = [COLUMNS.join(','), ...plans.map((p) => row(p).map(cell).join(','))];
  // The byte order mark lets Excel open the Indonesian text correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}
