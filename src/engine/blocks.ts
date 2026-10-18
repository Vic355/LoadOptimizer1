import type { EngineLine, PlacedBox } from './types';
import type { ModelRules } from './rules';
import { layerLimit, orientations, type Orientation } from './common';

/**
 * Free cuboid inside the truck. Spaces are produced by guillotine cuts, so every space
 * above the floor sits exactly on top of a placed block (callers check support otherwise).
 */
export interface Space {
  x: number;
  y: number;
  z: number;
  l: number;
  w: number;
  h: number;
  /** Cartons already stacked under this space. */
  stackCount: number;
  /** Strictest stack limit of the cartons below (Infinity when none apply). */
  stackLimit: number;
}

export interface BlockOptions {
  rules: ModelRules;
  rng: () => number;
  /** 0 = greedy; higher values add randomness to block scores for the search loop. */
  noise: number;
  /** Score multiplier per line, e.g. to favour a tier's main SKU; 0 excludes the line. */
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
 * Block-building heuristic: repeatedly take the free space nearest the cab, then the floor,
 * then one wall; put the best-scoring block of identical cartons in its corner; split the rest.
 * Taking the lowest space first fills the bottom layer across the width before stacking.
 * Mutates `remaining` and returns the placed boxes.
 */
export function fillSpaces(initial: Space[], lines: EngineLine[], remaining: number[], opts: BlockOptions): PlacedBox[] {
  const boxes: PlacedBox[] = [];
  const spaces = initial.slice();
  const orients = lines.map((l) => orientations(l.sku, opts.rules.rotation));
  const maxWeight = Math.max(1e-6, ...lines.map((l) => l.sku.weight));

  while (spaces.length) {
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
      const weight = opts.lineWeight ? opts.lineWeight(li) : 1;
      if (weight <= 0) continue;
      const sku = lines[li].sku;
      const limit = Math.min(s.stackLimit, layerLimit(sku, opts.rules));
      const layersLeft = limit - s.stackCount;
      if (layersLeft < 1) continue;
      for (const o of orients[li]) {
        if (o.dx > s.l || o.dy > s.w || o.dz > s.h) continue;
        let nx = Math.floor(s.l / o.dx);
        let ny = Math.floor(s.w / o.dy);
        let nz = Math.min(Math.floor(s.h / o.dz), layersLeft);
        // Keep blocks as full cuboids within the remaining quantity: whole layers first, so a
        // short line still covers the floor before it stacks.
        if (nx * ny * nz > rem) {
          if (nx * ny <= rem) nz = Math.floor(rem / (nx * ny));
          else if (ny <= rem) {
            nz = 1;
            nx = Math.floor(rem / ny);
          } else {
            nz = 1;
            nx = 1;
            ny = rem;
          }
        }
        const volume = nx * o.dx * ny * o.dy * nz * o.dz;
        // Prefer blocks that use the space's full width and height (flat walls are easier to load).
        const fit = ((ny * o.dy) / s.w) * 0.15 + ((nz * o.dz) / s.h) * 0.15 + 0.7;
        let score = volume * fit * weight;
        if (opts.rules.heavyBottom) {
          const w = sku.weight / maxWeight;
          score *= s.z < 0.5 ? 1 + 0.25 * w : 1 + 0.25 * (1 - w);
        }
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
          boxes.push({ skuId: sku.id, x: s.x + ix * o.dx, y: s.y + iy * o.dy, z: s.z + iz * o.dz, dx: o.dx, dy: o.dy, dz: o.dz, tier });
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
      stackCount: s.stackCount + nz,
      stackLimit: Math.min(s.stackLimit, layerLimit(sku, opts.rules)),
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
