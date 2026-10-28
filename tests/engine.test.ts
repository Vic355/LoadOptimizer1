import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, MODEL_ORDER, poseOf, runModel, runShipment, type EngineSku, type ModelId, type PlacedBox, type PlanRequest } from '../src/engine';
import { parseMaterialDescription, skuFromSap } from '../src/db/material';
import { SAP_SKU_ROWS } from '../src/db/seed-skus';
import { supportFraction } from '../src/engine/common';
import { rowPattern } from '../src/engine/tiers';
import { checkStability, TIP } from '../src/engine/stability';

const sku = (id: number, l: number, w: number, h: number, extra: Partial<EngineSku> = {}): EngineSku => ({
  id,
  code: `S${id}`,
  name: `SKU ${id}`,
  length: l,
  width: w,
  height: h,
  weight: 5,
  safeLayers: 6,
  canLieDown: false,
  group: 'A',
  ...extra,
});

const truck = { length: 940, width: 240, height: 200 };

function overlaps(a: PlacedBox, b: PlacedBox) {
  const e = 1e-6;
  return a.x < b.x + b.dx - e && b.x < a.x + a.dx - e && a.y < b.y + b.dy - e && b.y < a.y + a.dy - e && a.z < b.z + b.dz - e && b.z < a.z + a.dz - e;
}

/** Cartons below and above in the same stack column, counted from the floor. */
function stackDepth(b: PlacedBox, boxes: PlacedBox[]): number {
  const cx = b.x + b.dx / 2;
  const cy = b.y + b.dy / 2;
  return boxes.filter((o) => o.z < b.z + 1e-6 && cx > o.x && cx < o.x + o.dx && cy > o.y && cy < o.y + o.dy).length;
}

function assertValid(model: ModelId, req: PlanRequest, boxes: PlacedBox[]) {
  const byId = new Map(req.lines.map((l) => [l.sku.id, l.sku]));
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.z).toBeGreaterThanOrEqual(0);
    expect(b.x + b.dx).toBeLessThanOrEqual(req.truck.length + 1e-6);
    expect(b.y + b.dy).toBeLessThanOrEqual(req.truck.width + 1e-6);
    expect(b.z + b.dz).toBeLessThanOrEqual(req.truck.height + 1e-6);
    const min = req.rules.interlock ? req.rules.interlockMinSupport : 1;
    expect(supportFraction(b, boxes)).toBeGreaterThanOrEqual(min - 1e-6);
    if (req.rules.respectSafeStack) expect(stackDepth(b, boxes)).toBeLessThanOrEqual(byId.get(b.skuId)!.safeLayers);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${model} overlap ${i}/${j}`).toBe(false);
}

const lines = [
  { sku: sku(1, 60, 40, 35), qty: 300 },
  { sku: sku(2, 45, 30, 28, { safeLayers: 5, group: 'B' }), qty: 200 },
  { sku: sku(3, 50, 45, 40, { canLieDown: true }), qty: null },
];
const reqFor = (model: ModelId): PlanRequest => ({ truck, lines, rules: DEFAULT_RULES[model], timeBudgetMs: 150 });

describe('packing models', () => {
  for (const model of MODEL_ORDER) {
    it(`${model}: inside the truck, supported, within stack limits, no overlaps`, () => {
      const req = reqFor(model);
      const r = runModel(model, req);
      expect(r.totalCartons).toBeGreaterThan(0);
      assertValid(model, req, r.boxes);
      expect(r.loaded[1]).toBeLessThanOrEqual(300);
      expect(r.loaded[2]).toBeLessThanOrEqual(200);
      expect(r.tiers.reduce((s, t) => s + t.total, 0)).toBe(r.totalCartons);
    });
  }

  it('bebas ignores the safe stack limit and stacks to the roof', () => {
    const one = [{ sku: sku(1, 60, 40, 30, { safeLayers: 2 }), qty: null }];
    const free = runModel('free', { truck, lines: one, rules: DEFAULT_RULES.free, timeBudgetMs: 100 });
    const standard = runModel('standard', { truck, lines: one, rules: DEFAULT_RULES.standard, timeBudgetMs: 100 });
    expect(Math.max(...free.boxes.map((b) => b.z + b.dz))).toBeGreaterThan(60);
    expect(Math.max(...standard.boxes.map((b) => b.z + b.dz))).toBeLessThanOrEqual(60);
  });

  it('standard tiers are one carton deep with a full bottom layer', () => {
    const r = runModel('standard', { truck, lines: [{ sku: sku(1, 60, 40, 35), qty: null }], rules: DEFAULT_RULES.standard, timeBudgetMs: 100 });
    for (const tier of r.tiers) {
      const bottom = r.boxes.filter((b) => b.tier === tier.index && b.z === 0);
      expect(bottom.reduce((s, b) => s + b.dy, 0)).toBeGreaterThanOrEqual(240 - 40);
      expect(tier.depth).toBe(Math.max(...bottom.map((b) => b.dx)));
    }
  });

  it('standard keeps each SKU in neighbouring tiers', () => {
    const r = runModel('standard', reqFor('standard'));
    const mainOf = r.tiers.map((t) => Number(Object.entries(t.counts).sort((a, b) => b[1] - a[1])[0][0]));
    const firstSeen = new Map<number, number>();
    mainOf.forEach((id, i) => {
      if (!firstSeen.has(id)) firstSeen.set(id, i);
      else expect(mainOf[i - 1]).toBe(id);
    });
  });

  it('interlocked rows offset their joints and stay within the support rule', () => {
    const p = rowPattern(240, { dx: 60, dy: 40, dz: 35 }, 60, true, 0.6);
    expect(p.b).not.toBeNull();
    const ja = p.a.map((s) => s.y + s.dy);
    for (const s of p.b!) if (s.y + s.dy < 239) expect(ja.some((j) => Math.abs(j - (s.y + s.dy)) < 3)).toBe(false);
    // With full support required there is no gap-free offset row for this carton.
    expect(rowPattern(240, { dx: 60, dy: 40, dz: 35 }, 60, true, 1).b).toBeNull();
  });

  it('bebas and campuran load at least as much as standar on a mixed order', () => {
    const counts = Object.fromEntries(MODEL_ORDER.map((m) => [m, runModel(m, reqFor(m)).totalCartons]));
    expect(counts.free).toBeGreaterThanOrEqual(counts.standard);
    expect(counts.mixed).toBeGreaterThanOrEqual(counts.standard * 0.97);
  });
});

describe('stability check', () => {
  const box = (x: number, y: number, z: number, dx = 60, dy = 40, dz = 35): PlacedBox => ({ skuId: 1, x, y, z, dx, dy, dz, tier: 1 });
  const big = { length: 600, width: 245, height: 250 };

  it('flags a lone tall column in open space', () => {
    const column = [0, 35, 70, 105].map((z) => box(200, 100, z));
    const r = checkStability(column, big);
    expect(r.tip).toBeGreaterThan(0);
    expect(r.flags.some((f) => f & TIP)).toBe(true);
  });

  it('accepts a full-width wall against the cab', () => {
    const wall: PlacedBox[] = [];
    for (let z = 0; z < 210; z += 35) for (let y = 0; y + 40 <= 245; y += 40) wall.push(box(0, y + 2.5, z));
    expect(checkStability(wall, big).risky).toBe(0);
  });

  it('flags a carton not resting on its centre', () => {
    const r = checkStability([box(0, 0, 0), box(0, 30, 35)], big);
    expect(r.overhang).toBe(1);
  });

  it('rejects interlock patterns that leave wide gaps when a gap limit is set', () => {
    expect(rowPattern(245, { dx: 60, dy: 40, dz: 35 }, 60, true, 0.6, 10).b).toBeNull();
  });

  it('standar is no less stable than bebas and campuran', () => {
    const t2 = { length: 735, width: 245, height: 250 };
    const order = [
      { sku: sku(1, 60, 40, 35), qty: 180 },
      { sku: sku(2, 58, 39, 30, { safeLayers: 5 }), qty: 120 },
      { sku: sku(3, 45, 30, 28, { canLieDown: true, safeLayers: 7 }), qty: 150 },
    ];
    const risk = (m: ModelId) => runModel(m, { truck: t2, lines: order, rules: DEFAULT_RULES[m], timeBudgetMs: 300 }).stability!.risky;
    const standard = risk('standard');
    expect(standard).toBeLessThanOrEqual(risk('free'));
    expect(standard).toBeLessThanOrEqual(risk('mixed'));
  });
});

describe('physics rules and fill direction', () => {
  const box = (x: number, y: number, z: number): PlacedBox => ({ skuId: 1, x, y, z, dx: 60, dy: 40, dz: 35, tier: 1 });
  const big = { length: 600, width: 245, height: 250 };
  const tower = [0, 35, 70].map((z) => box(200, 100, z));

  it('bumps make tipping easier and friction stops sliding', () => {
    const calm = checkStability(tower, big, { physics: { ...DEFAULT_RULES.standard.physics, brakeG: 0.5, accelG: 0.5 } });
    const bumpy = checkStability(tower, big, { physics: { ...DEFAULT_RULES.standard.physics, brakeG: 0.5, accelG: 0.5, bumpG: 0.5 } });
    expect(bumpy.tip).toBeGreaterThan(calm.tip);
    const grippy = checkStability(tower, big, { physics: { ...DEFAULT_RULES.standard.physics, friction: 1.5 } });
    expect(grippy.slide).toBe(0);
  });

  it('fills from the door when asked', () => {
    for (const model of MODEL_ORDER) {
      const rules = { ...DEFAULT_RULES[model], fillFrom: 'door' as const };
      const req: PlanRequest = { truck, lines: lines.map((l) => ({ ...l, qty: l.qty ?? 40 })), rules, timeBudgetMs: 150 };
      const r = runModel(model, req);
      assertValid(model, req, r.boxes);
      const maxX = Math.max(...r.boxes.map((b) => b.x + b.dx));
      const minX = Math.min(...r.boxes.map((b) => b.x));
      expect(truck.length - maxX).toBeLessThan(minX + 1);
      // Tier 1 is loaded first, so it sits at the door.
      const t1 = r.tiers.find((t) => t.index === 1)!;
      expect(t1.x0 + t1.depth).toBeGreaterThan(truck.length - 101);
    }
  });
});

describe('shipments over several trucks', () => {
  const small = { length: 300, width: 240, height: 200 };

  it('adds trucks until every fixed quantity is loaded, in line order', () => {
    for (const model of MODEL_ORDER) {
      const order = [
        { sku: sku(1, 60, 40, 35), qty: 300 },
        { sku: sku(2, 45, 30, 28, { group: 'B' }), qty: 120 },
      ];
      const r = runShipment(model, { trucks: [small], lines: order, rules: DEFAULT_RULES[model], timeBudgetMs: 60 });
      expect(r.trucks.length, model).toBeGreaterThan(1);
      expect(r.unplaced).toEqual({});
      expect(r.totalCartons).toBe(420);
      const per = (id: number) => r.trucks.reduce((s, p) => s + (p.loaded[id] ?? 0), 0);
      expect(per(1)).toBe(300);
      expect(per(2)).toBe(120);
      for (const p of r.trucks) assertValid(model, { truck: small, lines: order, rules: DEFAULT_RULES[model] }, p.boxes);
      // The first truck carries the first line before the second.
      expect(r.trucks[0].loaded[1]).toBeGreaterThan(0);
    }
  });

  it('uses the trucks given, then repeats the last one; "fill max" lines do not add trucks', () => {
    const tiny = { length: 120, width: 240, height: 200 };
    const r = runShipment('standard', { trucks: [tiny, small], lines: [{ sku: sku(1, 60, 40, 35), qty: 200 }, { sku: sku(3, 50, 45, 40), qty: null }], rules: DEFAULT_RULES.standard, timeBudgetMs: 60 });
    expect(Math.max(...r.trucks[0].boxes.map((b) => b.x + b.dx))).toBeLessThanOrEqual(120);
    expect(r.trucks.length).toBeGreaterThan(1);
    expect(r.trucks.slice(1).every((p) => p.boxes.every((b) => b.x + b.dx <= 300))).toBe(true);
    const only = runShipment('standard', { trucks: [small], lines: [{ sku: sku(3, 50, 45, 40), qty: null }], rules: DEFAULT_RULES.standard, timeBudgetMs: 60 });
    expect(only.trucks).toHaveLength(1);
  });

  it('stops when a carton fits no truck and reports it unplaced', () => {
    const r = runShipment('standard', { trucks: [small], lines: [{ sku: sku(1, 60, 40, 35), qty: 10 }, { sku: sku(2, 400, 300, 300), qty: 3 }], rules: DEFAULT_RULES.standard, timeBudgetMs: 60 });
    expect(r.trucks).toHaveLength(1);
    expect(r.unplaced).toEqual({ 2: 3 });
  });

  it('bebas builds real tiers now', () => {
    const r = runModel('free', { truck, lines, rules: DEFAULT_RULES.free, timeBudgetMs: 100 });
    expect(r.segmentTiers).toBe(false);
  });
});

describe('carton poses', () => {
  const dims: [number, number, number] = [50, 30, 20];
  it('names which face is up and which faces the door', () => {
    expect(poseOf({ dx: 30, dy: 50, dz: 20 }, dims)).toBe('A');
    expect(poseOf({ dx: 50, dy: 30, dz: 20 }, dims)).toBe('B');
    expect(poseOf({ dx: 20, dy: 50, dz: 30 }, dims)).toBe('C');
    expect(poseOf({ dx: 50, dy: 20, dz: 30 }, dims)).toBe('D');
    expect(poseOf({ dx: 20, dy: 30, dz: 50 }, dims)).toBe('E');
    expect(poseOf({ dx: 30, dy: 20, dz: 50 }, dims)).toBe('F');
    // Equal sides: the upright pose is named first.
    expect(poseOf({ dx: 40, dy: 40, dz: 30 }, [40, 40, 30])).toBe('A');
  });
});

describe('SAP material descriptions', () => {
  it('reads the size in mm and the board grade, and flags odd grades', () => {
    expect(parseMaterialDescription('CCBOX;STD,PPSB,355L,215W,175H,K150/M150/')).toEqual({ length_cm: 35.5, width_cm: 21.5, height_cm: 17.5, boxCode: 'PPSB', board: 'K150/M150', issues: [] });
    const issues = (s: string) => parseMaterialDescription(s)!.issues;
    expect(issues('CCBOX;STD,SFTPCK LION,510L,410W,300H,425')).toEqual(['gsm-only']);
    expect(issues('CCBOX;STD,NVT150S,440L,370W,505H,550G')).toEqual(['gsm-only']);
    expect(issues('CCBOX;STD,LNL1,485L,455W,310H,550GSM')).toEqual(['gsm-only']);
    expect(issues('CCBOX;STD,BRJR,490L,240W,550H,150K/150M/')).toEqual(['reversed']);
    expect(issues('CCBOX;STD,HECTR1P,675L,454W,327H,K275/M1')).toEqual(['truncated']);
    expect(issues('CCBOX;STD,HPFS,400L,400W,375H,K150/M15/M')).toEqual(['truncated']);
    expect(issues('CCBOX;STD,NL2M,680L,330W,360H,125/150M/1')).toEqual(['no-k']);
    expect(issues('CCBOX;STD,PPBL,370L,310W,319H,WK200/M150')).toEqual(['white-kraft']);
    expect(issues('CCBOX;STD,D2D3,530L,445W,370H,K200/M150')).toEqual([]);
    const homeline = parseMaterialDescription('CCBOX;STD,HL4R,466.5L,366.5W,419H,K200/M')!;
    expect(homeline.issues).toEqual(['decimal', 'truncated']);
    expect(homeline.length_cm).toBeCloseTo(46.65);
    expect(parseMaterialDescription('no size here')).toBeNull();
  });

  it('every supplied SKU row has a size', () => {
    const parsed = SAP_SKU_ROWS.map((r) => skuFromSap(...r));
    expect(parsed.every((p) => p && p.length_cm > 0 && p.width_cm > 0 && p.height_cm > 0)).toBe(true);
    expect(parsed.filter((p) => p!.issues.some((i) => i !== 'white-kraft')).map((p) => p!.code)).toHaveLength(10);
  });
});
