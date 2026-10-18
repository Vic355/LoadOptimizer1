import type { EngineTruck, PlacedBox, StabilityReport } from './types';
import { DEFAULT_PHYSICS, type PhysicsRules } from './rules';

// Bump test, worked out the way a physics engine treats a rigid box on a surface. A push of
// a g (as a share of gravity) acts on each carton; a bump of v g makes it lighter, leaving
// (1 - v) g of grip. The carton slides when a > friction x (1 - v) and it has room to move.
// A stack standing free above its neighbour by height H on a base B tips when
// a x H > (1 - v) x B, i.e. when H > B x (1 - v) / a. Defaults: EN 12195-1 road transport.

/** Faces closer than this count as touching. */
const TOUCH = 3;
const BUCKET = 25;

export const TIP = 1;
export const SLIDE = 2;
export const OVERHANG = 4;

export interface StabilityOptions {
  physics?: PhysicsRules;
  /**
   * True when x = 0 is the door end instead of the cab (the tier builder works in loading order,
   * so with "fill from the door" its coordinates are mirrored). It swaps braking and speeding up.
   */
  reversed?: boolean;
}

/** Highest a tier of this depth may stand above its neighbour under push `g` before it tips. */
export function maxStep(depth: number, g: number, physics: PhysicsRules): number {
  return g > 0 ? (depth * (1 - physics.bumpG)) / g : Infinity;
}

/** Push in g towards x = 0 (`towardsStart`) or away from it, in the builder's coordinates. */
export function pushAlongX(physics: PhysicsRules, towardsStart: boolean, reversed = false): number {
  return towardsStart !== reversed ? physics.brakeG : physics.accelG;
}

type Axis = 'x' | 'y';

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * Flags cartons that could tip, slide or are not resting on their centre. The open end faces of
 * the load are not counted as risky: they are reported separately, to be blocked or strapped.
 */
export function checkStability(boxes: PlacedBox[], truck: EngineTruck, opts: StabilityOptions = {}): StabilityReport {
  const physics = opts.physics ?? DEFAULT_PHYSICS;
  const gap = physics.slideGapCm;
  const grip = Math.max(0, 1 - physics.bumpG);
  const dirs: { axis: Axis; sign: 1 | -1; g: number }[] = [
    { axis: 'x', sign: -1, g: pushAlongX(physics, true, opts.reversed) },
    { axis: 'x', sign: 1, g: pushAlongX(physics, false, opts.reversed) },
    { axis: 'y', sign: -1, g: physics.sideG },
    { axis: 'y', sign: 1, g: physics.sideG },
  ];
  const buckets = new Map<number, number[]>();
  let loadStart = Infinity;
  let loadEnd = 0;
  boxes.forEach((b, i) => {
    loadStart = Math.min(loadStart, b.x);
    loadEnd = Math.max(loadEnd, b.x + b.dx);
    for (let k = Math.floor(b.x / BUCKET); k <= Math.floor((b.x + b.dx - 1e-6) / BUCKET); k++) {
      const list = buckets.get(k);
      if (list) list.push(i);
      else buckets.set(k, [i]);
    }
  });
  const stamp = new Int32Array(boxes.length).fill(-1);
  const near = (self: number, x0: number, x1: number) => {
    const out: number[] = [];
    for (let k = Math.floor(x0 / BUCKET); k <= Math.floor(x1 / BUCKET); k++)
      for (const i of buckets.get(k) ?? [])
        if (stamp[i] !== self) {
          stamp[i] = self;
          out.push(i);
        }
    return out;
  };

  const flags: number[] = new Array(boxes.length).fill(0);
  let endFace = 0;
  boxes.forEach((b, i) => {
    const top = b.z + b.dz;
    const around = near(i, b.x - gap - TOUCH, b.x + b.dx + gap + TOUCH);

    // Resting on its centre: the middle of the base must be over a supporting carton.
    if (b.z > 0.5) {
      const cx = b.x + b.dx / 2;
      const cy = b.y + b.dy / 2;
      let centred = false;
      let area = 0;
      for (const j of around) {
        const o = boxes[j];
        if (j === i || Math.abs(o.z + o.dz - b.z) > 0.5) continue;
        const ox = overlap(b.x, b.x + b.dx, o.x, o.x + o.dx);
        const oy = overlap(b.y, b.y + b.dy, o.y, o.y + o.dy);
        if (ox > 0 && oy > 0) area += ox * oy;
        if (cx >= o.x - 0.5 && cx <= o.x + o.dx + 0.5 && cy >= o.y - 0.5 && cy <= o.y + o.dy + 0.5) centred = true;
      }
      if (!centred || area < 0.5 * b.dx * b.dy) flags[i] |= OVERHANG;
    }

    for (const d of dirs) {
      const lo = d.axis === 'x' ? b.x : b.y;
      const hi = d.axis === 'x' ? b.x + b.dx : b.y + b.dy;
      const size = hi - lo;
      const limit = d.axis === 'x' ? truck.length : truck.width;
      const face = d.sign > 0 ? hi : lo;
      const toWall = d.sign > 0 ? limit - face : face;
      if (toWall <= gap) continue;
      if (d.axis === 'x' && (d.sign > 0 ? face >= loadEnd - TOUCH : face <= loadStart + TOUCH)) {
        endFace++;
        continue;
      }
      // Nearest obstacle on this side within reach, and the height of what stands beside this face.
      // A carton with an obstacle within the slide gap can only lean or shift that far, so it is held.
      let free = toWall;
      let neighbourTop = 0;
      for (const j of around) {
        if (j === i) continue;
        const o = boxes[j];
        const perp = d.axis === 'x' ? overlap(b.y, b.y + b.dy, o.y, o.y + o.dy) : overlap(b.x, b.x + b.dx, o.x, o.x + o.dx);
        if (perp <= 1) continue;
        const olo = d.axis === 'x' ? o.x : o.y;
        const ohi = d.axis === 'x' ? o.x + o.dx : o.y + o.dy;
        const dist = d.sign > 0 ? olo - face : face - ohi;
        if (dist < -0.5) continue;
        if (overlap(b.z, top, o.z, o.z + o.dz) > 1) free = Math.min(free, dist);
        if (dist <= gap && o.z < top - 0.5) neighbourTop = Math.max(neighbourTop, o.z + o.dz);
      }
      if (free <= gap) continue;
      if (d.g > physics.friction * grip) flags[i] |= SLIDE;
      if (top - neighbourTop > maxStep(size, d.g, physics)) flags[i] |= TIP;
    }
  });

  let tip = 0;
  let slide = 0;
  let overhang = 0;
  const flagged: number[] = [];
  flags.forEach((f, i) => {
    if (!f) return;
    flagged.push(i);
    if (f & TIP) tip++;
    if (f & SLIDE) slide++;
    if (f & OVERHANG) overhang++;
  });
  return { risky: flagged.length, tip, slide, overhang, endFace, flagged, flags: flagged.map((i) => flags[i]) };
}
