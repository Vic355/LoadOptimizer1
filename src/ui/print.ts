import { POSES, poseOf, type PlacedBox, type PlanResult, type Pose, type Tier } from '../engine';
import * as repo from '../db/repo';
import type { Destination, PlanTruck, Sku } from '../db/repo';
import { t } from '../i18n/id';
import { fmt, h, svg } from './dom';
import { skuColor } from './colors';

/** One truck of the shipment on the sheet. */
export interface PrintTruck {
  plan: PlanResult;
  truck: PlanTruck;
  plateNo: string | null;
  /** 1-based position of the truck in the shipment. */
  seq: number;
}

interface PrintInput {
  trucks: PrintTruck[];
  shipmentNo: string;
  /** The shipment number is a temporary draft number. */
  draft: boolean;
  destination: Destination | null;
  note: string;
  skus: Sku[];
  /** The 3D view of one truck (the one on screen); the other trucks get a drawn overview. */
  snapshot: { seq: number; url: string } | null;
}

/** Colour: light SKU tints with dark numbers. Gray: white cartons told apart by number and hatching, for black-only printers and less ink. */
type InkMode = 'color' | 'gray';

const TIERS_PER_PAGE = 6;
/** Tiers per row on the loader page, and rows per page. */
const STRIP_MAX = 12;
const STRIP_ROWS = 3;
const MODE_KEY = 'tlo-print-mode';

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`;
}

const GRAYS = ['#f4f4f4', '#d6d6d6', '#e8e8e8', '#c4c4c4', '#fafafa', '#dedede'];

/** Hatching per SKU for the gray sheet: the n-th SKU gets the n-th pattern (the first is plain white). */
const PATTERNS: ((id: string) => SVGElement)[] = [
  (id) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, svg('rect', { width: 8, height: 8, fill: '#fff' })),
  (id) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('rect', { width: 8, height: 8, fill: '#fff' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#888', 'stroke-width': 1.2 })),
  (id) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, svg('rect', { width: 8, height: 8, fill: '#fff' }), svg('circle', { cx: 4, cy: 4, r: 1.3, fill: '#777' })),
  (id) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' }, svg('rect', { width: 8, height: 8, fill: '#fff' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#888', 'stroke-width': 1.2 })),
  (id) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, svg('rect', { width: 8, height: 8, fill: '#fff' }), svg('line', { x1: 0, y1: 4, x2: 8, y2: 4, stroke: '#888', 'stroke-width': 1.2 })),
  (id) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse' }, svg('rect', { width: 8, height: 8, fill: '#fff' }), svg('line', { x1: 4, y1: 0, x2: 4, y2: 8, stroke: '#888', 'stroke-width': 1.2 })),
  (id) => svg('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('rect', { width: 8, height: 8, fill: '#fff' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#888', 'stroke-width': 1 }), svg('line', { x1: 0, y1: 0, x2: 8, y2: 0, stroke: '#888', 'stroke-width': 1 })),
  (id) => svg('pattern', { id, width: 10, height: 10, patternUnits: 'userSpaceOnUse' }, svg('rect', { width: 10, height: 10, fill: '#fff' }), svg('rect', { x: 3, y: 3, width: 4, height: 4, fill: '#999' })),
];

function savedMode(): InkMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'gray' ? 'gray' : 'color';
  } catch {
    return 'color';
  }
}

/** Truck cab pictogram, facing right when `flip` is false. */
function cabIcon(size = 26): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 40 30', width: size, height: (size * 30) / 40, class: 'p-icon', 'aria-hidden': 'true' },
    svg('path', { d: 'M3 6h20v16H3z', fill: 'none', stroke: '#111', 'stroke-width': 2 }),
    svg('path', { d: 'M23 10h8l6 7v5H23z', fill: '#fff', stroke: '#111', 'stroke-width': 2, 'stroke-linejoin': 'round' }),
    svg('path', { d: 'M26 12h4.5l3.5 4.5H26z', fill: '#111' }),
    svg('circle', { cx: 10, cy: 24, r: 3.2, fill: '#fff', stroke: '#111', 'stroke-width': 2 }),
    svg('circle', { cx: 31, cy: 24, r: 3.2, fill: '#fff', stroke: '#111', 'stroke-width': 2 }),
  );
}

/** Rear doors pictogram: two door leaves with handles. */
function doorIcon(size = 22): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 30 30', width: size, height: size, class: 'p-icon', 'aria-hidden': 'true' },
    svg('rect', { x: 3, y: 2, width: 24, height: 26, fill: 'none', stroke: '#111', 'stroke-width': 2 }),
    svg('line', { x1: 15, y1: 2, x2: 15, y2: 28, stroke: '#111', 'stroke-width': 2 }),
    svg('line', { x1: 12, y1: 12, x2: 12, y2: 18, stroke: '#111', 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
    svg('line', { x1: 18, y1: 12, x2: 18, y2: 18, stroke: '#111', 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
  );
}

function eyeIcon(size = 18): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 24 16', width: size, height: (size * 16) / 24, class: 'p-icon', 'aria-hidden': 'true' },
    svg('path', { d: 'M1 8c3-5 7-7 11-7s8 2 11 7c-3 5-7 7-11 7S4 13 1 8z', fill: 'none', stroke: '#111', 'stroke-width': 1.6 }),
    svg('circle', { cx: 12, cy: 8, r: 3.2, fill: '#111' }),
  );
}

/**
 * A carton in one of the poses A–F, drawn like the overview (the door is the face towards the
 * lower right). The face towards the door is shaded and the top of the carton (the taped flaps)
 * has a thick seam line along its length, so the loader can match it to the real carton.
 */
function poseIcon(pose: Pose, size = 46): SVGElement {
  const K = 0.866;
  const P = (x: number, y: number, z: number): [number, number] => [(x - y) * K, (x + y) * 0.5 - z];
  const pts = (list: [number, number][]) => list.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
  const carton = [32, 20, 16];
  const axes = POSES[pose];
  const [l, w, hh] = axes.map((a) => carton[a]);
  const el = svg('svg', { viewBox: '-22 -26 52 44', width: size, height: (size * 44) / 52, class: 'p-pose', 'aria-hidden': 'true' });
  const top = [P(0, 0, hh), P(l, 0, hh), P(l, w, hh), P(0, w, hh)];
  const door = [P(l, 0, 0), P(l, w, 0), P(l, w, hh), P(l, 0, hh)];
  const side = [P(0, w, 0), P(l, w, 0), P(l, w, hh), P(0, w, hh)];
  el.append(
    svg('polygon', { points: pts(top), fill: '#fff', stroke: '#111', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
    svg('polygon', { points: pts(side), fill: '#fff', stroke: '#111', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
    svg('polygon', { points: pts(door), fill: '#9a9a9a', stroke: '#111', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
  );
  // The seam: on the face across the carton's height axis, along its length axis, through the middle.
  const up = axes.indexOf(2);
  const along = axes.indexOf(0);
  const ext = [l, w, hh];
  const a: [number, number, number] = [ext[0] / 2, ext[1] / 2, ext[2] / 2];
  a[up] = ext[up];
  const b: [number, number, number] = [...a];
  a[along] = 0;
  b[along] = ext[along];
  el.append(svg('line', { x1: P(...a)[0], y1: P(...a)[1], x2: P(...b)[0], y2: P(...b)[1], stroke: '#111', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  return el;
}

/** Drawn overview of the whole load, used when there is no 3D snapshot or the sheet saves ink. */
function isometric(plan: PlanResult, truck: PlanTruck, color: (skuId: number) => string): SVGElement {
  const K = 0.866;
  const P = (x: number, y: number, z: number): [number, number] => [(x - y) * K, (x + y) * 0.5 - z];
  const pts = (list: [number, number][]) => list.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
  const { length: L, width: W, height: H } = truck;
  const corners = [P(0, 0, 0), P(L, 0, 0), P(L, W, 0), P(0, W, 0), P(0, 0, H), P(L, 0, H), P(L, W, H), P(0, W, H)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const pad = 10;
  const el = svg('svg', { viewBox: `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${Math.max(...xs) - Math.min(...xs) + pad * 2} ${Math.max(...ys) - Math.min(...ys) + pad * 2}`, class: 'p-snap', role: 'img', 'aria-label': t.view3d });
  el.append(
    svg('polygon', { points: pts([P(0, 0, 0), P(L, 0, 0), P(L, W, 0), P(0, W, 0)]), fill: '#fff', stroke: '#999' }),
    svg('polygon', { points: pts([P(0, 0, 0), P(L, 0, 0), P(L, 0, H), P(0, 0, H)]), fill: '#fff', stroke: '#bbb' }),
    svg('polygon', { points: pts([P(0, 0, 0), P(0, W, 0), P(0, W, H), P(0, 0, H)]), fill: '#fff', stroke: '#bbb' }),
  );
  // Painter's order: boxes farthest from the viewer (smallest x + y + z at the centre) first.
  const depth = (b: (typeof plan.boxes)[number]) => b.x + b.dx / 2 + b.y + b.dy / 2 + b.z + b.dz / 2;
  const boxes = [...plan.boxes].sort((a, b) => depth(a) - depth(b));
  for (const b of boxes) {
    const c = color(b.skuId);
    const { x, y, z, dx: l, dy: w, dz: hh } = b;
    el.append(
      svg('polygon', { points: pts([P(x, y, z + hh), P(x + l, y, z + hh), P(x + l, y + w, z + hh), P(x, y + w, z + hh)]), fill: shade(c, 0.35), stroke: '#111', 'stroke-opacity': 0.4, 'stroke-width': 0.6 }),
      svg('polygon', { points: pts([P(x + l, y, z), P(x + l, y + w, z), P(x + l, y + w, z + hh), P(x + l, y, z + hh)]), fill: c, stroke: '#111', 'stroke-opacity': 0.4, 'stroke-width': 0.6 }),
      svg('polygon', { points: pts([P(x, y + w, z), P(x + l, y + w, z), P(x + l, y + w, z + hh), P(x, y + w, z + hh)]), fill: shade(c, -0.15), stroke: '#111', 'stroke-opacity': 0.4, 'stroke-width': 0.6 }),
    );
  }
  el.append(svg('polyline', { points: pts([P(0, 0, H), P(L, 0, H), P(L, W, H), P(0, W, H), P(0, 0, H)]), fill: 'none', stroke: '#555', 'stroke-dasharray': '5 4' }));
  return el;
}

/**
 * Builds the loader sheet as an on-screen A4 landscape preview, one set of pages per truck of the
 * shipment: a cover page with the whole load, a loader page with every tier in one line from the
 * door to the cab, then six tiers per page drawn as seen from the door. Every carton in a tier
 * drawing carries its SKU number and its pose letter (A–F). Colour or black-and-white (less ink)
 * is picked in the toolbar.
 */
export function printPlan({ trucks, shipmentNo, draft, destination, note, skus, snapshot }: PrintInput) {
  document.getElementById('print-root')?.remove();
  const idx = (id: number) => skus.findIndex((s) => s.id === id);
  const label = (id: number) => String(idx(id) + 1);
  const company = repo.getMeta('company_name') || t.companyDefault;
  const printed = new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
  const destText = destination ? `${destination.customer} · ${destination.city}${destination.zone ? ` · ${destination.zone}` : ''}` : '–';
  const shipmentText = `${shipmentNo}${draft ? ` (${t.draftTag})` : ''}`;
  let mode = savedMode();

  const fill = (id: number) => (mode === 'gray' ? `url(#p-pat-${idx(id) % PATTERNS.length})` : shade(skuColor(idx(id)), 0.55));
  const edge = (id: number) => (mode === 'gray' ? '#111' : skuColor(idx(id)));
  const swatch = (id: number) =>
    svg(
      'svg',
      { viewBox: '0 0 30 18', class: 'p-sw', 'aria-hidden': 'true' },
      svg('rect', { x: 0.75, y: 0.75, width: 28.5, height: 16.5, rx: 3, fill: fill(id), stroke: edge(id), 'stroke-width': 1.5 }),
      svg('rect', { x: 8, y: 3, width: 14, height: 12, rx: 2, fill: '#fff' }),
      svg('text', { x: 15, y: 13, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#111' }, label(id)),
    );
  const poseOfBox = (b: PlacedBox): Pose => {
    const s = skus[idx(b.skuId)];
    return s ? poseOf(b, repo.plannedDims(s)) : 'A';
  };
  /** Legend of the poses used in a plan, with a drawing of each. */
  const poseLegend = (boxes: PlacedBox[]) => {
    const used = [...new Set(boxes.map(poseOfBox))].sort();
    return h(
      'div',
      { class: 'p-poses' },
      h('strong', {}, `${t.poseTitle}:`),
      ...used.map((p) => h('span', { class: 'p-pose-item' }, poseIcon(p), h('b', {}, p), t.poses[p])),
      h('span', { class: 'p-pose-hint' }, t.poseHint),
    );
  };

  const truckPages = ({ plan, truck, plateNo, seq }: PrintTruck): HTMLElement[] => {
    const W = truck.width || 1;
    const H = truck.height || 1;
    const tierWord = plan.segmentTiers ? t.segments : t.tierNo;
    const risky = new Set((plan.stability?.flagged ?? []).map((i) => plan.boxes[i]));
    // Tiers by position from the door to the cab (x = 0 is the cab), whatever the loading direction.
    const doorToCab = [...plan.tiers].sort((a, b) => b.x0 - a.x0);
    const rows: Tier[][] = [];
    const perRow = Math.max(1, Math.ceil(doorToCab.length / Math.ceil(Math.max(1, doorToCab.length) / STRIP_MAX)));
    // Rows run from the cab end: the first row holds the tiers nearest the cab, each row drawn door left, cab right.
    for (let end = doorToCab.length; end > 0; end -= perRow) rows.push(doorToCab.slice(Math.max(0, end - perRow), end));
    const loaderPages = Math.ceil(rows.length / STRIP_ROWS);
    const tierPages = Math.ceil(plan.tiers.length / TIERS_PER_PAGE);
    const pageCount = 1 + loaderPages + tierPages;
    const truckText = `${t.truckOf(seq, trucks.length)}${plateNo ? ` · ${plateNo}` : ''}`;
    const posesBySku = new Map<number, Set<Pose>>();
    for (const b of plan.boxes) {
      const set = posesBySku.get(b.skuId) ?? new Set<Pose>();
      set.add(poseOfBox(b));
      posesBySku.set(b.skuId, set);
    }

    /** Front view of one tier from the door: y runs left to right, z runs up (SVG y is flipped). */
    const tierDrawing = (tier: Tier, cls: string, numbers: boolean) => {
      const boxes = plan.boxes.filter((b) => b.tier === tier.index).sort((a, b) => a.x - b.x);
      const pad = 4;
      const drawing = svg('svg', { viewBox: `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`, class: cls, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': `${t.seenFromDoor} ${tierWord} ${tier.index}` });
      drawing.append(svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'none', stroke: '#111', 'stroke-width': 1.5 }));
      // Boxes nearer the door are drawn last so they cover the ones behind; hidden boxes are drawn faint (and left out in black and white).
      for (const b of boxes) {
        const front = b.x + b.dx >= tier.x0 + tier.depth - 0.5;
        if (!front && mode === 'gray') continue;
        const y = H - b.z - b.dz;
        const warn = front && risky.has(b);
        drawing.append(
          svg('rect', {
            x: b.y,
            y,
            width: b.dy,
            height: b.dz,
            fill: fill(b.skuId),
            'fill-opacity': front ? 1 : 0.4,
            stroke: warn ? (mode === 'gray' ? '#000' : '#c0141c') : edge(b.skuId),
            'stroke-width': warn ? 3 : 0.8,
            'stroke-dasharray': warn && mode === 'gray' ? '6 3' : 'none',
          }),
        );
        if (numbers && front && b.dy > 14 && b.dz > 10) {
          // SKU number and pose letter, e.g. "3B"; a white tag keeps them readable on any fill or hatching.
          const text = `${warn ? '⚠' : ''}${label(b.skuId)}${poseOfBox(b)}`;
          const size = Math.min(14, b.dz * 0.5, b.dy / (0.62 * text.length + 0.5));
          const tagW = size * (0.62 * text.length + 0.4);
          drawing.append(
            svg('rect', { x: b.y + b.dy / 2 - tagW / 2, y: y + b.dz / 2 - size * 0.62, width: tagW, height: size * 1.24, rx: 2, fill: '#fff' }),
            svg('text', { x: b.y + b.dy / 2, y: y + b.dz / 2 + size * 0.36, 'text-anchor': 'middle', 'font-size': size, fill: '#111', 'font-weight': 700 }, text),
          );
        }
      }
      return drawing;
    };

    /** Where a tier sits in the truck: a small bar from the door (left) to the cab (right), this tier filled. */
    const position = (tier: Tier) => {
      const L = truck.length || 1;
      const el = svg('svg', { viewBox: '0 0 100 8', class: 'p-pos', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      el.append(svg('rect', { x: 0.5, y: 0.5, width: 99, height: 7, fill: '#fff', stroke: '#111', 'stroke-width': 0.6 }));
      const x = ((L - tier.x0 - tier.depth) / L) * 100;
      el.append(svg('rect', { x: Math.max(0.5, x), y: 0.5, width: Math.max(1.5, (tier.depth / L) * 100), height: 7, fill: '#111' }));
      return h('div', { class: 'p-posrow' }, doorIcon(13), el, cabIcon(17));
    };

    const grid = (tier: Tier) => (tier.columns ? h('span', { class: 'p-grid-text' }, `↔ ${tier.columns} ${t.across} · ↕ ${tier.layers} ${t.stacked}`) : null);
    const counts = (tier: Tier) => Object.entries(tier.counts).map(([id, c]) => h('span', { class: 'p-count' }, swatch(Number(id)), h('strong', {}, fmt.int(c))));

    const legend = () =>
      h(
        'div',
        { class: 'p-howto' },
        h('strong', {}, `${t.howToRead}:`),
        h('span', {}, cabIcon(), t.cabLong),
        h('span', {}, doorIcon(), t.doorLong),
        h('span', {}, eyeIcon(), t.legendView),
        h('span', {}, h('span', { class: 'p-box' }), t.legendTick),
        skus[0] ? h('span', {}, swatch(skus[0].id), t.legendSku) : null,
        h('span', {}, h('b', {}, '⚠'), t.legendWarn),
      );

    const pageHead = (n: number, extra: string) =>
      h(
        'header',
        { class: 'p-head small' },
        h('strong', {}, `${company} · ${t.shipmentLabel} ${shipmentText} · ${truckText} · ${truck.name} · ${t.models[plan.model]}`),
        h('span', {}, `${t.page(n, pageCount)}${extra ? ` · ${extra}` : ''}`),
      );

    const coverPage = () =>
      h(
        'section',
        { class: 'p-page' },
        h(
          'header',
          { class: 'p-head' },
          h('div', {}, h('div', { class: 'p-company' }, company), h('h1', {}, t.printTitle), h('div', { class: 'p-shipment' }, `${t.shipmentLabel} ${shipmentText} · ${truckText}`)),
          h('div', { class: 'p-right' }, h('div', {}, t.page(1, pageCount)), h('div', {}, `${t.printDate} ${printed}`)),
        ),
        h(
          'table',
          { class: 'p-facts' },
          h('tr', {}, h('th', {}, t.shipmentLabel), h('td', {}, h('strong', {}, shipmentText)), h('th', {}, t.plateNo), h('td', {}, h('strong', {}, plateNo ?? '–'))),
          h('tr', {}, h('th', {}, t.printModel), h('td', {}, t.models[plan.model]), h('th', {}, t.truck), h('td', {}, `${truck.name} · ${fmt.dims(truck.length, truck.width, truck.height)} cm`)),
          h(
            'tr',
            {},
            h('th', {}, t.destination),
            h('td', {}, destText),
            h('th', {}, t.total),
            h('td', {}, h('strong', {}, fmt.int(plan.totalCartons)), ` ${t.cartons} · `, h('strong', {}, fmt.int(plan.tiers.length)), ` ${plan.segmentTiers ? t.segments : t.tiers}`),
          ),
          note ? h('tr', {}, h('th', {}, t.reference), h('td', { colspan: 3 }, note)) : null,
        ),
        h(
          'div',
          { class: 'p-cover-body' },
          h(
            'figure',
            { class: 'p-snapfig' },
            snapshot && snapshot.seq === seq && mode === 'color'
              ? h('img', { src: snapshot.url, alt: t.view3d, class: 'p-snap' })
              : isometric(plan, truck, (id) => (mode === 'gray' ? GRAYS[idx(id) % GRAYS.length] : shade(skuColor(idx(id)), 0.45))),
            h('figcaption', {}, t.snapshotCaption),
          ),
          h(
            'div',
            { class: 'p-cover-side' },
            h(
              'table',
              { class: 'p-legend' },
              h('tr', {}, h('th', {}, '#'), h('th', {}, 'SKU'), h('th', {}, t.plannedDims), h('th', {}, t.pose), h('th', { class: 'num' }, t.planned)),
              ...skus
                .filter((s) => plan.loaded[s.id] || plan.unplaced[s.id])
                .map((s) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, swatch(s.id)),
                    h('td', {}, `${s.code} · ${s.name}`),
                    h('td', {}, fmt.dims(...repo.plannedDims(s))),
                    h('td', {}, [...(posesBySku.get(s.id) ?? [])].sort().join(', ') || '–'),
                    h('td', { class: 'num' }, h('strong', {}, fmt.int(plan.loaded[s.id] ?? 0))),
                  ),
                ),
            ),
            poseLegend(plan.boxes),
            Object.keys(plan.unplaced).length
              ? h(
                  'div',
                  { class: 'p-unplaced' },
                  h('strong', {}, `${seq < trucks.length ? t.nextTruckCarries(seq + 1) : t.unplaced}: `),
                  Object.entries(plan.unplaced)
                    .map(([id, n]) => {
                      const s = skus[idx(Number(id))];
                      return `${s ? `${s.code} ${s.name}` : id}, ${fmt.int(n)} ${t.cartons}`;
                    })
                    .join(' · '),
                )
              : null,
            risky.size ? h('div', { class: 'p-unplaced' }, `⚠ ${t.riskPrint(risky.size)}`) : null,
            plan.stability?.endFace ? h('p', { class: 'p-note' }, t.doorNote) : null,
            plan.segmentTiers ? h('p', { class: 'p-note' }, t.segmentNote) : plan.tiers.some((x) => x.interlocked) ? h('p', { class: 'p-note' }, t.interlockNote) : null,
            h('div', { class: 'p-signs' }, h('div', {}, h('div', { class: 'p-line' }), t.loaderSign), h('div', {}, h('div', { class: 'p-line' }), t.checkerSign)),
          ),
        ),
      );

    /**
     * One row of the loader strip, one box per tier, the door side on the left and the cab side on
     * the right. A row that does not reach the door or the cab names the tier it continues with.
     */
    const stripRow = (row: Tier[], r: number) => {
      const first = Math.min(...row.map((x) => x.index));
      const last = Math.max(...row.map((x) => x.index));
      const atDoor = r === rows.length - 1;
      const atCab = r === 0;
      return h(
        'div',
        { class: 'p-strip-row' },
        h('div', { class: 'p-strip-label' }, t.rowTiers(tierWord, first, last)),
        h(
          'div',
          { class: 'p-strip' },
          atDoor ? h('div', { class: 'p-end' }, doorIcon(26), h('span', {}, t.door)) : h('div', { class: 'p-end more' }, `◀ ${tierWord} ${last + 1}`),
          h(
            'div',
            { class: 'p-cells', style: `grid-template-columns: repeat(${perRow}, minmax(0, 1fr))` },
            ...row.map((tier) => {
              const warn = plan.boxes.some((b) => b.tier === tier.index && risky.has(b));
              return h(
                'div',
                { class: 'p-cell' },
                h('div', { class: 'p-cell-no' }, warn ? h('span', { class: 'p-warn' }, '⚠') : null, String(tier.index)),
                tierDrawing(tier, 'p-mini', false),
                h('div', { class: 'p-cell-counts' }, ...counts(tier)),
                h('div', { class: 'p-cell-total' }, `= ${fmt.int(tier.total)}`),
                h('span', { class: 'p-box big' }),
                h('div', { class: 'p-cell-line' }),
              );
            }),
            // Only the door-end row can be short; its tiers stay against the door.
            ...Array.from({ length: perRow - row.length }, () => h('div', { class: 'p-cell empty' })),
          ),
          atCab ? h('div', { class: 'p-end' }, cabIcon(34), h('span', {}, t.cab)) : h('div', { class: 'p-end more' }, `${tierWord} ${first - 1} ▶`),
        ),
      );
    };

    const loaderPage = (p: number) =>
      h(
        'section',
        { class: 'p-page' },
        pageHead(2 + p, ''),
        h('div', { class: 'p-loader-title' }, h('h2', {}, t.loaderPageTitle), h('span', {}, t.loaderPageHint)),
        h('div', { class: 'p-strips' }, ...rows.slice(p * STRIP_ROWS, (p + 1) * STRIP_ROWS).map((row, i) => stripRow(row, p * STRIP_ROWS + i))),
        h(
          'div',
          { class: 'p-direction' },
          h('strong', {}, `${t.loadDirection}:`),
          plan.rules.fillFrom === 'door' ? h('span', {}, doorIcon(16), ' ', t.door, ' → ', t.cab, ' ', cabIcon(20)) : h('span', {}, cabIcon(20), ' ', t.cab, ' → ', t.door, ' ', doorIcon(16)),
          h('span', {}, `${tierWord} 1 → ${plan.tiers.length}`),
        ),
        legend(),
        poseLegend(plan.boxes),
      );

    const tierCard = (tier: Tier) => {
      const boxes = plan.boxes.filter((b) => b.tier === tier.index);
      const warn = boxes.filter((b) => risky.has(b)).length;
      return h(
        'article',
        { class: 'p-card' },
        h(
          'div',
          { class: 'p-card-head' },
          h('strong', {}, `${tierWord} ${tier.index}`, h('small', {}, ` / ${plan.tiers.length}`)),
          warn ? h('span', { class: 'p-warn' }, `⚠ ${warn}`) : null,
          h('span', {}, h('strong', {}, fmt.int(tier.total)), ` ${t.cartons}`),
        ),
        position(tier),
        h('div', { class: 'p-seen' }, eyeIcon(14), t.seenFromDoor),
        tierDrawing(tier, 'p-svg', true),
        h('div', { class: 'p-sides' }, h('span', {}, `◀ ${t.left}`), grid(tier), h('span', {}, `${t.right} ▶`)),
        h('div', { class: 'p-counts' }, ...Object.entries(tier.counts).map(([id, c]) => h('span', { class: 'p-count' }, swatch(Number(id)), ` ${skus[idx(Number(id))]?.code ?? id}: `, h('strong', {}, fmt.int(c))))),
        h('div', { class: 'p-actual' }, h('span', { class: 'p-box' }), `${t.actual}:`, h('span', { class: 'p-line' }), h('span', {}, `☐ ${t.photo}`), h('span', {}, `☐ ${t.checker}`)),
      );
    };

    const tierPage = (p: number) => {
      const slice = plan.tiers.slice(p * TIERS_PER_PAGE, (p + 1) * TIERS_PER_PAGE);
      return h(
        'section',
        { class: 'p-page' },
        pageHead(2 + loaderPages + p, t.tiersOnPage(slice[0].index, slice[slice.length - 1].index, plan.tiers.length)),
        h('div', { class: 'p-grid' }, ...slice.map(tierCard)),
      );
    };

    return [coverPage(), ...Array.from({ length: loaderPages }, (_, p) => loaderPage(p)), ...Array.from({ length: tierPages }, (_, p) => tierPage(p))];
  };

  const sheet = h('div', { class: 'p-sheet' });
  const render = () => {
    const defs = svg('svg', { width: 0, height: 0, class: 'p-defs', 'aria-hidden': 'true' }, svg('defs', {}, ...PATTERNS.map((make, i) => make(`p-pat-${i}`))));
    sheet.className = `p-sheet ${mode}`;
    sheet.replaceChildren(defs, ...trucks.flatMap(truckPages));
  };

  const close = () => root.remove();
  const modeButtons = (['color', 'gray'] as InkMode[]).map((m) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(m === mode) }, m === 'color' ? t.printColor : t.printGray);
    b.classList.toggle('on', m === mode);
    b.addEventListener('click', () => {
      mode = m;
      try {
        localStorage.setItem(MODE_KEY, m);
      } catch {
        // Storage may be blocked; the choice then lasts for this sheet only.
      }
      modeButtons.forEach((x, i) => {
        const on = ['color', 'gray'][i] === m;
        x.classList.toggle('on', on);
        x.setAttribute('aria-pressed', String(on));
      });
      render();
    });
    return b;
  });
  const toolbar = h(
    'div',
    { class: 'p-toolbar' },
    h('strong', {}, t.printPreview),
    h('div', { class: 'seg' }, ...modeButtons),
    h('span', { class: 'muted' }, t.printHint),
    h('button', { class: 'btn', type: 'button', onclick: close }, t.close),
    h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, t.print),
  );
  render();
  const root = h('div', { id: 'print-root', tabindex: '-1' }, toolbar, sheet);
  // Show the sheet as an on-screen preview first; printing (or saving as PDF) is one click from there.
  document.body.append(root);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  (toolbar.querySelector('.btn.primary') as HTMLButtonElement).focus();
}
