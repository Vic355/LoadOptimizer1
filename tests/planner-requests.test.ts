import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, MODEL_ORDER, moveTier, runModel, runShipment, volumeLowerBound, type EngineSku, type PlacedBox, type PlanResult } from '../src/engine';
import { skuFromSap } from '../src/db/material';
import { SAP_SKU_ROWS } from '../src/db/seed-skus';
import { supportFraction } from '../src/engine/common';
import { LANGS } from '../src/i18n/id';

const sap = (code: string, id: number): EngineSku => {
  const row = SAP_SKU_ROWS.find((r) => r[0] === code)!;
  const s = skuFromSap(row[0], row[1], row[2], row[3])!;
  return { id, code, name: s.name, length: s.length_cm, width: s.width_cm, height: s.height_cm, weight: 0, safeLayers: s.safe_stack_layers, canLieDown: false, group: s.product_group };
};

// The example shipment: Paseo Baby Puresoft, Paseo Elegant Travelpack and Nice Softpack 320.
const order = [
  { sku: sap('69921603', 1), qty: 300 },
  { sku: sap('69920852', 2), qty: 200 },
  { sku: sap('69921667', 3), qty: 120 },
];
const semi = { length: 735, width: 245, height: 250 };

function overlaps(a: PlacedBox, b: PlacedBox) {
  const e = 1e-6;
  return a.x < b.x + b.dx - e && b.x < a.x + a.dx - e && a.y < b.y + b.dy - e && b.y < a.y + a.dy - e && a.z < b.z + b.dz - e && b.z < a.z + a.dz - e;
}

function expectValid(plan: PlanResult) {
  for (const b of plan.boxes) {
    expect(b.x).toBeGreaterThanOrEqual(-1e-6);
    expect(b.x + b.dx).toBeLessThanOrEqual(semi.length + 1e-6);
    expect(supportFraction(b, plan.boxes)).toBeGreaterThanOrEqual(plan.rules.interlockMinSupport - 1e-6);
  }
  for (let i = 0; i < plan.boxes.length; i++) for (let j = i + 1; j < plan.boxes.length; j++) expect(overlaps(plan.boxes[i], plan.boxes[j])).toBe(false);
}

describe('standard model: safety first, no stray tiers', () => {
  it('leaves no tier of a few cartons in the middle of the load and stays more stable than before', () => {
    const r = runShipment('standard', { trucks: [semi], lines: order, rules: DEFAULT_RULES.standard, timeBudgetMs: 400 });
    expect(r.trucks).toHaveLength(1);
    const p = r.trucks[0];
    expect(p.totalCartons).toBe(620);
    // Before this change the plan had 20 tiers, several of 3 to 5 cartons, and 289 cartons at risk.
    expect(p.tiers.length).toBeLessThanOrEqual(11);
    const inner = p.tiers.slice(0, -1);
    expect(Math.min(...inner.map((t) => t.total))).toBeGreaterThanOrEqual(15);
    expect(p.stability!.risky).toBeLessThan(150);
    expectValid(p);
  });

  it('the "level tiers" rule is optional and off by default', () => {
    expect(DEFAULT_RULES.standard.levelTiers).toBe(false);
    const level = runModel('standard', { truck: semi, lines: order, rules: { ...DEFAULT_RULES.standard, levelTiers: true }, timeBudgetMs: 200 });
    const plain = runModel('standard', { truck: semi, lines: order, rules: DEFAULT_RULES.standard, timeBudgetMs: 200 });
    // Leaving space to keep tiers level needs more tiers for the same cartons.
    expect(level.tiers.length).toBeGreaterThanOrEqual(plain.tiers.length);
  });
});

describe('group by SKU', () => {
  for (const model of MODEL_ORDER) {
    it(`${model}: each SKU's tiers follow one another`, () => {
      const r = runModel(model, { truck: semi, lines: order, rules: { ...DEFAULT_RULES[model], groupBySku: true }, timeBudgetMs: 200 });
      const seen: number[] = [];
      for (const tier of r.tiers) {
        const ids = Object.keys(tier.counts).map(Number);
        // A tier holds one SKU, or the end of one SKU and the start of the next.
        expect(ids.length).toBeLessThanOrEqual(2);
        for (const id of ids) {
          if (!seen.includes(id)) seen.push(id);
          // Once a later SKU has started, an earlier one only comes back in the tier where they meet.
          else expect(seen.slice(seen.indexOf(id) + 1).length).toBeLessThanOrEqual(1);
        }
      }
      expect(r.totalCartons).toBe(620);
    });
  }
});

describe('truck target', () => {
  const cdd = { length: 263, width: 200, height: 190 };

  it('works out the fewest trucks the carton volume allows', () => {
    expect(volumeLowerBound({ trucks: [cdd], lines: order, rules: DEFAULT_RULES.standard })).toBe(2);
    expect(volumeLowerBound({ trucks: [semi], lines: order, rules: DEFAULT_RULES.standard })).toBe(1);
  });

  it('reports whether the target was reached, and never plans more trucks than without one', () => {
    const plain = runShipment('free', { trucks: [cdd], lines: order, rules: DEFAULT_RULES.free, timeBudgetMs: 80 });
    const target = runShipment('free', { trucks: [cdd], lines: order, rules: DEFAULT_RULES.free, timeBudgetMs: 80, truckTarget: 'min' });
    expect(target.target?.goal).toBe(2);
    expect(target.trucks.length).toBeLessThanOrEqual(plain.trucks.length);
    expect(target.target?.reached).toBe(target.trucks.length <= 2);
    const one = runShipment('free', { trucks: [cdd], lines: order, rules: DEFAULT_RULES.free, timeBudgetMs: 80, truckTarget: 1 });
    expect(one.target).toMatchObject({ goal: 1, lowerBound: 2, reached: false, rounds: 1 });
  });
});

describe('moving tiers', () => {
  it('moves a tier to another position, renumbers the tiers and keeps every carton', () => {
    const p = runModel('standard', { truck: semi, lines: order, rules: DEFAULT_RULES.standard, timeBudgetMs: 150 });
    const before = p.tiers.map((t) => t.total);
    const moved = moveTier(p, 1, 3, semi);
    expect(moved.edited).toBe(true);
    expect(moved.totalCartons).toBe(p.totalCartons);
    expect(moved.tiers.map((t) => t.total)).toEqual([before[1], before[2], before[0], ...before.slice(3)]);
    expect(moved.tiers.map((t) => t.index)).toEqual(p.tiers.map((t) => t.index));
    expectValid(moved);
    // Moving it back gives the original layout.
    const back = moveTier(moved, 3, 1, semi);
    expect(back.tiers.map((t) => [t.x0, t.total])).toEqual(p.tiers.map((t) => [t.x0, t.total]));
  });
});

describe('languages', () => {
  it('English has every text that Bahasa Indonesia has', () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keys(v).map((x) => `${k}.${x}`) : [k]));
    expect(keys(LANGS.en).sort()).toEqual(keys(LANGS.id).sort());
  });
});
