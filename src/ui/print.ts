import type { PlanResult } from '../engine';
import type { Destination, Sku, TruckType } from '../db/repo';
import { t } from '../i18n/id';
import { fmt, h, svg } from './dom';
import { skuColor } from './colors';

interface PrintInput {
  plan: PlanResult;
  truck: TruckType;
  destination: Destination | null;
  so: string;
  skus: Sku[];
  snapshot: string | null;
}

/** Builds the loader sheet (one front view per tier, as seen from the door) as a print preview. */
export function printPlan({ plan, truck, destination, so, skus, snapshot }: PrintInput) {
  document.getElementById('print-root')?.remove();
  const W = truck.inner_width_cm ?? 1;
  const H = truck.inner_height_cm ?? 1;
  const idx = (id: number) => skus.findIndex((s) => s.id === id);
  const label = (id: number) => String(idx(id) + 1);
  const tierWord = plan.segmentTiers ? t.segments : t.tierNo;

  const header = h(
    'header',
    { class: 'p-head' },
    h('div', {}, h('h1', {}, t.printTitle), h('p', {}, `${t.printModel}: ${t.models[plan.model]} · ${t.printDate}: ${new Date().toLocaleString('id-ID')}`)),
    h(
      'table',
      { class: 'p-facts' },
      h('tr', {}, h('th', {}, t.soNumber), h('td', {}, so || '–'), h('th', {}, t.truck), h('td', {}, `${truck.name} (${fmt.dims(truck.inner_length_cm, truck.inner_width_cm, truck.inner_height_cm)} cm)`)),
      h('tr', {}, h('th', {}, t.destination), h('td', {}, destination ? `${destination.customer}, ${destination.city}` : '–'), h('th', {}, t.zone), h('td', {}, destination?.zone ?? '–')),
      h('tr', {}, h('th', {}, t.totalCartons), h('td', {}, h('strong', {}, fmt.int(plan.totalCartons))), h('th', {}, plan.segmentTiers ? t.segmentCount : t.tierCount), h('td', {}, h('strong', {}, fmt.int(plan.tiers.length)))),
    ),
  );

  const legend = h(
    'table',
    { class: 'p-legend' },
    h('tr', {}, h('th', {}, '#'), h('th', {}, t.code), h('th', {}, t.name), h('th', {}, t.dims), h('th', {}, t.loaded)),
    ...skus.map((s, i) =>
      h(
        'tr',
        {},
        h('td', {}, h('span', { class: 'p-sw', style: `background:${skuColor(i)}` }, String(i + 1))),
        h('td', {}, s.code),
        h('td', {}, s.name),
        h('td', {}, fmt.dims(s.length_cm, s.width_cm, s.height_cm)),
        h('td', {}, fmt.int(plan.loaded[s.id] ?? 0)),
      ),
    ),
  );

  const cards = plan.tiers.map((tier) => {
    const boxes = plan.boxes.filter((b) => b.tier === tier.index).sort((a, b) => b.x - a.x);
    const pad = 4;
    const drawing = svg('svg', { viewBox: `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`, class: 'p-svg', preserveAspectRatio: 'xMidYMid meet' });
    drawing.append(svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'none', stroke: '#222', 'stroke-width': 1.5 }));
    // Front view from the door: y goes left to right, z goes up (SVG y is flipped).
    for (const b of boxes) {
      const front = b.x + b.dx >= tier.x0 + tier.depth - 0.5;
      const y = H - b.z - b.dz;
      drawing.append(
        svg('rect', { x: b.y, y, width: b.dy, height: b.dz, fill: skuColor(idx(b.skuId)), 'fill-opacity': front ? 0.85 : 0.35, stroke: '#111', 'stroke-width': 0.6 }),
      );
      if (b.dy > 14 && b.dz > 10)
        drawing.append(svg('text', { x: b.y + b.dy / 2, y: y + b.dz / 2 + 4, 'text-anchor': 'middle', 'font-size': Math.min(12, b.dz * 0.5), fill: '#fff', 'font-weight': 700 }, label(b.skuId)));
    }
    return h(
      'article',
      { class: 'p-card' },
      h(
        'div',
        { class: 'p-card-head' },
        h('strong', {}, `${tierWord} ${tier.index} / ${plan.tiers.length}`),
        h('span', {}, `${t.depth} ${fmt.int(tier.depth)} cm`),
        h('span', { class: 'p-total' }, `${fmt.int(tier.total)} ${t.cartons}`),
      ),
      drawing,
      h('div', { class: 'p-caption' }, t.viewFromDoor, tier.columns ? ` · ${tier.columns} ${t.columnsWord} × ${tier.layers} ${t.layersWord}` : ''),
      h(
        'div',
        { class: 'p-counts' },
        ...Object.entries(tier.counts).map(([id, c]) => h('span', {}, h('span', { class: 'p-sw', style: `background:${skuColor(idx(Number(id)))}` }, label(Number(id))), ` ${skus[idx(Number(id))]?.code ?? id}: ${fmt.int(c)}`)),
      ),
      h('div', { class: 'p-check' }, h('span', {}, `☐ ${t.photo}`), h('span', {}, `☐ ${t.checker}`)),
    );
  });

  const close = () => root.remove();
  const toolbar = h(
    'div',
    { class: 'p-toolbar' },
    h('strong', {}, t.printPreview),
    h('span', { class: 'muted' }, t.printHint),
    h('button', { class: 'btn', type: 'button', onclick: close }, t.close),
    h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, t.print),
  );
  const root = h(
    'div',
    { id: 'print-root' },
    toolbar,
    h(
      'div',
      { class: 'p-sheet' },
      header,
      h('div', { class: 'p-top' }, legend, snapshot ? h('img', { src: snapshot, alt: t.view3d, class: 'p-snap' }) : null),
      plan.segmentTiers ? h('p', { class: 'p-note' }, t.segmentNote) : null,
      h('div', { class: 'p-grid' }, ...cards),
    ),
  );
  // Show the sheet as an on-screen preview first; printing (or saving as PDF) is one click from there.
  document.body.append(root);
  root.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  (toolbar.querySelector('.btn.primary') as HTMLButtonElement).focus();
}
