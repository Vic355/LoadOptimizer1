import type { PlanResult, Tier } from '../engine';
import * as repo from '../db/repo';
import type { Destination, PlanTruck, Sku } from '../db/repo';
import { t } from '../i18n/id';
import { fmt, h, svg } from './dom';
import { skuColor } from './colors';

interface PrintInput {
  plan: PlanResult;
  truck: PlanTruck;
  destination: Destination | null;
  reference: string;
  skus: Sku[];
  snapshot: string | null;
}

const TIERS_PER_PAGE = 6;

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const m = (v: number) => Math.max(0, Math.min(255, Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`;
}

/** Drawn overview of the whole load, used when there is no 3D snapshot (e.g. reprinting from history). */
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
    svg('polygon', { points: pts([P(0, 0, 0), P(L, 0, 0), P(L, W, 0), P(0, W, 0)]), fill: '#eee', stroke: '#999' }),
    svg('polygon', { points: pts([P(0, 0, 0), P(L, 0, 0), P(L, 0, H), P(0, 0, H)]), fill: '#f5f5f5', stroke: '#bbb' }),
    svg('polygon', { points: pts([P(0, 0, 0), P(0, W, 0), P(0, W, H), P(0, 0, H)]), fill: '#f0f0f0', stroke: '#bbb' }),
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
      svg('polygon', { points: pts([P(x, y + w, z), P(x + l, y + w, z), P(x + l, y + w, z + hh), P(x, y + w, z + hh)]), fill: shade(c, -0.3), stroke: '#111', 'stroke-opacity': 0.4, 'stroke-width': 0.6 }),
    );
  }
  el.append(svg('polyline', { points: pts([P(0, 0, H), P(L, 0, H), P(L, W, H), P(0, W, H), P(0, 0, H)]), fill: 'none', stroke: '#555', 'stroke-dasharray': '5 4' }));
  return el;
}

/**
 * Builds the loader sheet as an on-screen A4 landscape preview: a cover page with the whole load,
 * then six tiers per page drawn as seen from the door, each with a line for the actual count.
 */
export function printPlan({ plan, truck, destination, reference, skus, snapshot }: PrintInput) {
  document.getElementById('print-root')?.remove();
  const W = truck.width || 1;
  const H = truck.height || 1;
  const idx = (id: number) => skus.findIndex((s) => s.id === id);
  const label = (id: number) => String(idx(id) + 1);
  const tierWord = plan.segmentTiers ? t.segments : t.tierNo;
  const company = repo.getMeta('company_name') || t.companyPlaceholder;
  const printed = new Date().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
  const tierPages = Math.ceil(plan.tiers.length / TIERS_PER_PAGE);
  const pageCount = 1 + tierPages;
  const destText = destination ? `${destination.customer} · ${destination.city}${destination.zone ? ` · ${destination.zone}` : ''}` : '–';
  const risky = new Set((plan.stability?.flagged ?? []).map((i) => plan.boxes[i]));
  const swatch = (id: number) => h('span', { class: 'p-sw', style: `background:${skuColor(idx(id))}` }, label(id));

  const cover = h(
    'section',
    { class: 'p-page' },
    h(
      'header',
      { class: 'p-head' },
      h('div', {}, h('div', { class: 'p-company' }, company), h('h1', {}, t.printTitle)),
      h('div', { class: 'p-right' }, h('div', {}, t.page(1, pageCount)), h('div', {}, `${t.printDate} ${printed}`)),
    ),
    h(
      'table',
      { class: 'p-facts' },
      h('tr', {}, h('th', {}, t.printModel), h('td', {}, t.models[plan.model]), h('th', {}, t.truck), h('td', {}, `${truck.name} · ${fmt.dims(truck.length, truck.width, truck.height)} cm`)),
      h(
        'tr',
        {},
        h('th', {}, t.destination),
        h('td', {}, destText),
        h('th', {}, t.total),
        h('td', {}, h('strong', {}, fmt.int(plan.totalCartons)), ` ${t.cartons} · `, h('strong', {}, fmt.int(plan.tiers.length)), ` ${plan.segmentTiers ? t.segments : t.tiers}`),
      ),
      reference ? h('tr', {}, h('th', {}, t.reference), h('td', { colspan: 3 }, reference)) : null,
    ),
    h(
      'div',
      { class: 'p-cover-body' },
      h(
        'figure',
        { class: 'p-snapfig' },
        snapshot ? h('img', { src: snapshot, alt: t.view3d, class: 'p-snap' }) : isometric(plan, truck, (id) => skuColor(idx(id))),
        h('figcaption', {}, t.snapshotCaption),
      ),
      h(
        'div',
        { class: 'p-cover-side' },
        h(
          'table',
          { class: 'p-legend' },
          h('tr', {}, h('th', {}, '#'), h('th', {}, 'SKU'), h('th', {}, t.plannedDims), h('th', { class: 'num' }, t.planned)),
          ...skus.map((s) =>
            h('tr', {}, h('td', {}, swatch(s.id)), h('td', {}, `${s.code} · ${s.name}`), h('td', {}, fmt.dims(...repo.plannedDims(s))), h('td', { class: 'num' }, fmt.int(plan.loaded[s.id] ?? 0))),
          ),
        ),
        Object.keys(plan.unplaced).length
          ? h(
              'div',
              { class: 'p-unplaced' },
              h('strong', {}, `${t.unplaced}: `),
              Object.entries(plan.unplaced)
                .map(([id, n]) => {
                  const s = skus[idx(Number(id))];
                  return `${s ? `${s.code} ${s.name}` : id}, ${fmt.int(n)} ${t.cartons}`;
                })
                .join(' · '),
            )
          : null,
        risky.size ? h('div', { class: 'p-unplaced' }, t.riskPrint(risky.size)) : null,
        plan.stability?.doorFace ? h('p', { class: 'p-note' }, t.doorNote) : null,
        plan.segmentTiers ? h('p', { class: 'p-note' }, t.segmentNote) : plan.tiers.some((x) => x.interlocked) ? h('p', { class: 'p-note' }, t.interlockNote) : null,
        h('div', { class: 'p-signs' }, h('div', {}, h('div', { class: 'p-line' }), t.loaderSign), h('div', {}, h('div', { class: 'p-line' }), t.checkerSign)),
      ),
    ),
  );

  const tierCard = (tier: Tier) => {
    const boxes = plan.boxes.filter((b) => b.tier === tier.index).sort((a, b) => a.x - b.x);
    const pad = 4;
    const drawing = svg('svg', { viewBox: `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`, class: 'p-svg', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': `${t.viewFromDoor} ${tierWord} ${tier.index}` });
    drawing.append(svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'none', stroke: '#111', 'stroke-width': 1.5 }));
    // Front view from the door: y runs left to right, z runs up (SVG y is flipped). Boxes nearer the
    // door are drawn last so they cover the ones behind; hidden boxes are drawn faded.
    for (const b of boxes) {
      const front = b.x + b.dx >= tier.x0 + tier.depth - 0.5;
      const y = H - b.z - b.dz;
      const warn = front && risky.has(b);
      drawing.append(
        svg('rect', { x: b.y, y, width: b.dy, height: b.dz, fill: skuColor(idx(b.skuId)), 'fill-opacity': front ? 0.9 : 0.35, stroke: warn ? '#c0141c' : '#111', 'stroke-width': warn ? 3 : 0.7 }),
      );
      if (front && b.dy > 14 && b.dz > 10)
        drawing.append(svg('text', { x: b.y + b.dy / 2, y: y + b.dz / 2 + 4, 'text-anchor': 'middle', 'font-size': Math.min(13, b.dz * 0.5), fill: '#fff', 'font-weight': 700 }, `${warn ? '⚠' : ''}${label(b.skuId)}`));
    }
    const grid = tier.columns ? ` · ${tier.layers} ${t.layersWord}${tier.interlocked ? `, ${t.interlockedShort}` : ''}` : '';
    return h(
      'article',
      { class: 'p-card' },
      h(
        'div',
        { class: 'p-card-head' },
        h('strong', {}, `${tierWord} ${tier.index} / ${plan.tiers.length}`),
        boxes.some((b) => risky.has(b)) ? h('span', { class: 'p-warn' }, `⚠ ${boxes.filter((b) => risky.has(b)).length}`) : null,
        h('span', {}, `${fmt.int(tier.total)} ${t.cartons}`),
      ),
      drawing,
      h('div', { class: 'p-caption' }, `${t.viewFromDoor}${grid}`),
      h(
        'div',
        { class: 'p-counts' },
        ...Object.entries(tier.counts).map(([id, c]) => h('span', {}, swatch(Number(id)), ` ${skus[idx(Number(id))]?.code ?? id}: ${fmt.int(c)}`)),
      ),
      h('div', { class: 'p-actual' }, `${t.actual}:`, h('span', { class: 'p-line' })),
      h('div', { class: 'p-check' }, h('span', {}, `☐ ${t.photo}`), h('span', {}, `☐ ${t.checker}`)),
    );
  };

  const pages = [cover];
  for (let p = 0; p < tierPages; p++) {
    const slice = plan.tiers.slice(p * TIERS_PER_PAGE, (p + 1) * TIERS_PER_PAGE);
    pages.push(
      h(
        'section',
        { class: 'p-page' },
        h(
          'header',
          { class: 'p-head small' },
          h('strong', {}, `${t.printTitle} · ${t.models[plan.model]} · ${truck.name}${destination ? ` · ${destination.customer}` : ''}`),
          h('span', {}, `${t.page(p + 2, pageCount)} · ${t.tiersOnPage(slice[0].index, slice[slice.length - 1].index, plan.tiers.length)}`),
        ),
        h('div', { class: 'p-grid' }, ...slice.map(tierCard)),
      ),
    );
  }

  const close = () => root.remove();
  const toolbar = h(
    'div',
    { class: 'p-toolbar' },
    h('strong', {}, t.printPreview),
    h('span', { class: 'muted' }, t.printHint),
    h('button', { class: 'btn', type: 'button', onclick: close }, t.close),
    h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, t.print),
  );
  const root = h('div', { id: 'print-root', tabindex: '-1' }, toolbar, h('div', { class: 'p-sheet' }, ...pages));
  // Show the sheet as an on-screen preview first; printing (or saving as PDF) is one click from there.
  document.body.append(root);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  (toolbar.querySelector('.btn.primary') as HTMLButtonElement).focus();
}
