import type { EngineLine, PlacedBox } from './types';
import { orientations, type Orientation } from './common';

/**
 * Free cuboid inside the truck. Spaces are produced by guillotine cuts, so every
 * space above the floor sits exactly on top of a placed block and is fully supported.
 */
export interface Space {
  x: number;
  y: number;
  z: number;
  l: number;
  w: number;
  h: number;
  /** Absolute height (from the floor) that nothing in this space may exceed. */
  ceiling: number;
  /** Space sits on plastic bales: only bales may go here. */
  balesOnly: boolean;
}

export interface BlockOptions {
  rng: () => number;
  /** 0 = greedy; higher values add randomness to block scores for the search loop. */
  noise: number;
  /** Optional score multiplier per line, e.g. to favour the tier's primary SKU. */
  lineWeight?: (lineIndex: number) => number;
  tierOf: (space: Space) => number;
}

interface Candidate {
  line: number;
  o: Orientation;
  nx: number;
  ny: number;
  nz: number;
  score: number;
}

const MIN_SPACE = 5;

/**
 * Block-building heuristic: repeatedly take the free space nearest the cab and floor,
 * put the best-scoring block of identical cartons in its corner, and split what is left.
 * Mutates `remaining` and returns the placed boxes.
 */
export function fillSpaces(
  initial: Space[],
  lines: EngineLine[],
  remaining: number[],
  opts: BlockOptions,
): PlacedBox[] {
  const boxes: PlacedBox[] = [];
  const spaces = initial.slice();
  const orients = lines.map((l) => orientations(l.sku));

  while (spaces.length) {
    // Nearest the cab first, then lowest, then from one wall.
    let pick = 0;
    for (let i = 1; i < spaces.length; i++) {
      const a = spaces[i];
      const b = spaces[pick];
      if (a.x < b.x || (a.x === b.x && (a.z < b.z || (a.z === b.z && a.y < b.y)))) pick = i;
    }
    const s = spaces.splice(pick, 1)[0];

    let best: Candidate | null = null;
    for (let li = 0; li < lines.length; li++) {
      const rem = remaining[li];
      if (rem <= 0) continue;
      const sku = lines[li].sku;
      if (s.balesOnly && sku.packaging !== 'bale') continue;
      const top = Math.min(s.ceiling, sku.safeStackHeight, s.z + s.h);
      const usableH = top - s.z;
      for (const o of orients[li]) {
        if (o.dx > s.l || o.dy > s.w || o.dz > usableH) continue;
        let nx = Math.floor(s.l / o.dx);
        let ny = Math.floor(s.w / o.dy);
        let nz = Math.floor(usableH / o.dz);
        // Keep blocks as full cuboids within the remaining quantity: full columns first, then rows.
        if (nx * ny * nz > rem) {
          if (ny * nz <= rem) {
            nx = Math.floor(rem / (ny * nz));
          } else if (nz <= rem) {
            nx = 1;
            ny = Math.floor(rem / nz);
          } else {
            nx = 1;
            ny = 1;
            nz = rem;
          }
        }
        const volume = nx * o.dx * ny * o.dy * nz * o.dz;
        // Prefer blocks that use the space's full width and usable height (flat walls are easier to load).
        const fit = ((ny * o.dy) / s.w) * 0.15 + ((nz * o.dz) / usableH) * 0.15 + 0.7;
        let score = volume * fit;
        if (opts.lineWeight) score *= opts.lineWeight(li);
        if (opts.noise > 0) score *= 1 + opts.noise * (opts.rng() - 0.5);
        if (!best || score > best.score) best = { line: li, o, nx, ny, nz, score };
      }
    }
    if (!best) continue;

    const { line, o, nx, ny, nz } = best;
    const sku = lines[line].sku;
    const tier = opts.tierOf(s);
    for (let ix = 0; ix < nx; ix++)
      for (let iy = 0; iy < ny; iy++)
        for (let iz = 0; iz < nz; iz++)
          boxes.push({
            skuId: sku.id,
            x: s.x + ix * o.dx,
            y: s.y + iy * o.dy,
            z: s.z + iz * o.dz,
            dx: o.dx,
            dy: o.dy,
            dz: o.dz,
            tier,
          });
    remaining[line] -= nx * ny * nz;

    const bl = nx * o.dx;
    const bw = ny * o.dy;
    const bh = nz * o.dz;
    const above: Space = {
      x: s.x,
      y: s.y,
      z: s.z + bh,
      l: bl,
      w: bw,
      h: s.h - bh,
      ceiling: Math.min(s.ceiling, sku.safeStackHeight),
      balesOnly: s.balesOnly || sku.packaging === 'bale',
    };
    // Two guillotine options for the floor remainder; keep the one with the larger single piece.
    const sideA: Space = { ...s, y: s.y + bw, l: s.l, w: s.w - bw };
    const frontA: Space = { ...s, x: s.x + bl, l: s.l - bl, w: bw };
    const sideB: Space = { ...s, y: s.y + bw, l: bl, w: s.w - bw };
    const frontB: Space = { ...s, x: s.x + bl, l: s.l - bl, w: s.w };
    const vol = (q: Space) => q.l * q.w * q.h;
    const useA = Math.max(vol(sideA), vol(frontA)) >= Math.max(vol(sideB), vol(frontB));
    const parts = useA ? [above, sideA, frontA] : [above, sideB, frontB];
    for (const p of parts) if (p.l >= MIN_SPACE && p.w >= MIN_SPACE && p.h >= MIN_SPACE) spaces.push(p);
  }
  return boxes;
}
