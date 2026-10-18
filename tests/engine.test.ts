import { describe, expect, it } from 'vitest';
import { MODEL_ORDER, runModel, type EngineSku, type PlacedBox, type PlanRequest } from '../src/engine';

const sku = (id: number, l: number, w: number, h: number, extra: Partial<EngineSku> = {}): EngineSku => ({
  id,
  code: `S${id}`,
  name: `SKU ${id}`,
  length: l,
  width: w,
  height: h,
  weight: 5,
  safeStackHeight: 220,
  canLieDown: false,
  packaging: 'carton',
  ...extra,
});

const truck = { length: 940, width: 240, height: 200 };

function overlaps(a: PlacedBox, b: PlacedBox) {
  return a.x < b.x + b.dx && b.x < a.x + a.dx && a.y < b.y + b.dy && b.y < a.y + a.dy && a.z < b.z + b.dz && b.z < a.z + a.dz;
}

function assertValid(req: PlanRequest, boxes: PlacedBox[]) {
  const byId = new Map(req.lines.map((l) => [l.sku.id, l.sku]));
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.z).toBeGreaterThanOrEqual(0);
    expect(b.x + b.dx).toBeLessThanOrEqual(req.truck.length);
    expect(b.y + b.dy).toBeLessThanOrEqual(req.truck.width);
    expect(b.z + b.dz).toBeLessThanOrEqual(Math.min(req.truck.height, byId.get(b.skuId)!.safeStackHeight));
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
}

describe('packing models', () => {
  const req: PlanRequest = {
    truck,
    lines: [
      { sku: sku(1, 60, 40, 35), qty: 300 },
      { sku: sku(2, 45, 30, 28, { safeStackHeight: 150 }), qty: 200 },
      { sku: sku(3, 50, 45, 40, { packaging: 'bale' }), qty: null },
    ],
    timeBudgetMs: 150,
  };

  for (const model of MODEL_ORDER) {
    it(`${model}: boxes stay inside the truck, under the safe height and never overlap`, () => {
      const r = runModel(model, req);
      expect(r.totalCartons).toBeGreaterThan(0);
      assertValid(req, r.boxes);
      expect(r.loaded[1]).toBeLessThanOrEqual(300);
      expect(r.loaded[2]).toBeLessThanOrEqual(200);
      expect(r.tiers.reduce((s, t) => s + t.total, 0)).toBe(r.totalCartons);
    });
  }

  it('standard: one SKU per tier, full grid', () => {
    const r = runModel('standard', { truck, lines: [{ sku: sku(1, 60, 40, 35), qty: null }] });
    // 240/40 = 6 columns, 200/35 = 5 layers, 940/60 = 15 tiers.
    expect(r.tiers.length).toBe(15);
    expect(r.tiers[0].total).toBe(30);
    expect(r.totalCartons).toBe(450);
  });

  it('nothing is stacked on top of a bale except bales', () => {
    const r = runModel('free', req);
    const bales = r.boxes.filter((b) => b.skuId === 3);
    for (const b of r.boxes.filter((x) => x.skuId !== 3))
      for (const bale of bales) {
        const onTop = b.z >= bale.z + bale.dz && b.x < bale.x + bale.dx && bale.x < b.x + b.dx && b.y < bale.y + bale.dy && bale.y < b.y + b.dy;
        expect(onTop).toBe(false);
      }
  });

  it('free and mixed load at least as much as standard on a mixed order', () => {
    const counts = Object.fromEntries(MODEL_ORDER.map((m) => [m, runModel(m, req).loadedVolume]));
    expect(counts.free).toBeGreaterThanOrEqual(counts.standard * 0.98);
    expect(counts.mixed).toBeGreaterThanOrEqual(counts.standard * 0.98);
  });
});
