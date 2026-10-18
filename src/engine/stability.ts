import type { EngineTruck, PlacedBox, StabilityReport } from './types';

// Rule-based bump test. Instead of simulating physics, each carton is checked against the load
// accelerations used for cargo securing (EN 12195-1, road transport): 0.8 g forward when braking,
// 0.5 g backwards and 0.5 g sideways. A free-standing stack tips when acceleration x height is
// more than gravity x half its base, i.e. when height / base > 1 / a.

export const FORWARD_G = 0.8;
const BACKWARD_G = 0.5;
const SIDEWAYS_G = 0.5;
/** Faces closer than this count as touching. */
const TOUCH = 3;
/** Cartons with more free room than this on a side can slide into it. */
export const SLIDE_GAP = 10;
const BUCKET = 25;

export const TIP = 1;
export const SLIDE = 2;
export const OVERHANG = 4;

type Axis = 'x' | 'y';
interface Dir {
  axis: Axis;
  sign: 1 | -1;
  g: number;
}
const DIRS: Dir[] = [
  { axis: 'x', sign: -1, g: FORWARD_G },
  { axis: 'x', sign: 1, g: BACKWARD_G },
  { axis: 'y', sign: -1, g: SIDEWAYS_G },
  { axis: 'y', sign: 1, g: SIDEWAYS_G },
];

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * Flags cartons that could tip, slide or are not resting on their centre. The face of the load
 * at the door is not counted: it is held by the closed doors and should be blocked or strapped.
 */
export function checkStability(boxes: PlacedBox[], truck: EngineTruck): StabilityReport {
  const buckets = new Map<number, number[]>();
  let loadEnd = 0;
  boxes.forEach((b, i) => {
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
  let doorFace = 0;
  boxes.forEach((b, i) => {
    const top = b.z + b.dz;
    const around = near(i, b.x - SLIDE_GAP - TOUCH, b.x + b.dx + SLIDE_GAP + TOUCH);

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

    for (const d of DIRS) {
      const lo = d.axis === 'x' ? b.x : b.y;
      const hi = d.axis === 'x' ? b.x + b.dx : b.y + b.dy;
      const size = hi - lo;
      const limit = d.axis === 'x' ? truck.length : truck.width;
      const face = d.sign > 0 ? hi : lo;
      const toWall = d.sign > 0 ? limit - face : face;
      if (toWall <= SLIDE_GAP) continue;
      if (d.axis === 'x' && d.sign > 0 && face >= loadEnd - TOUCH) {
        doorFace++;
        continue;
      }
      // Nearest obstacle on this side within reach, and the height of what stands beside this face.
      // A carton with an obstacle within SLIDE_GAP can only lean or shift that far, so it is held.
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
        if (dist <= SLIDE_GAP && o.z < top - 0.5) neighbourTop = Math.max(neighbourTop, o.z + o.dz);
      }
      if (free <= SLIDE_GAP) continue;
      flags[i] |= SLIDE;
      if (top - neighbourTop > size / d.g) flags[i] |= TIP;
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
  return { risky: flagged.length, tip, slide, overhang, doorFace, flagged, flags: flagged.map((i) => flags[i]) };
}
