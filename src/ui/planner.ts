import { MODEL_ORDER, type ModelId, type PlanRequest, type PlanResult } from '../engine';
import type { WorkerResponse } from '../engine/worker';
import * as repo from '../db/repo';
import type { Destination, Sku, TruckType } from '../db/repo';
import { t } from '../i18n/id';
import { combobox } from './combobox';
import { fmt, h } from './dom';
import { skuColor } from './colors';
import { TruckView, type ColorMode } from './view3d';
import { printPlan } from './print';

interface Line {
  sku: Sku;
  qty: number | null;
}

export interface PlannerState {
  so: string;
  destination: Destination | null;
  truckId: number | null;
  lines: Line[];
  results: Partial<Record<ModelId, PlanResult>>;
  stale: boolean;
  selected: ModelId;
  colorMode: ColorMode;
  upToTier: number;
  highlightTier: number;
  showPerTier: boolean;
  detailsOpen: boolean;
  running: boolean;
  message: string;
}

export class Planner {
  readonly el: HTMLElement;
  private state: PlannerState = {
    so: '',
    destination: null,
    truckId: null,
    lines: [],
    results: {},
    stale: false,
    selected: 'standard',
    colorMode: 'sku',
    upToTier: 0,
    highlightTier: 0,
    showPerTier: false,
    detailsOpen: true,
    running: false,
    message: '',
  };
  private trucks: TruckType[] = [];
  private view: TruckView | null = null;
  private worker: Worker | null = null;

  // Mount points that re-render independently.
  private destCard = h('div', { class: 'dest-card' });
  private truckSelect = h('select', { id: 'truck-select' });
  private truckNote = h('p', { class: 'hint' });
  private linesBox = h('div', { class: 'lines' });
  private runBtn = h('button', { class: 'btn primary run', type: 'button' }, t.run);
  private message = h('p', { class: 'message', role: 'status' });
  private modelCards = h('div', { class: 'model-cards' });
  private stageTools = h('div', { class: 'stage-tools' });
  private canvasHost = h('div', { class: 'canvas-host' });
  private summaryBox = h('div', { class: 'summary-body' });
  private detailsBox = h('section', { class: 'details panel' });

  constructor() {
    this.el = h('div', { class: 'planner' }, this.inputPanel(), this.stagePanel(), h('aside', { class: 'summary panel' }, h('h2', {}, t.summary), this.summaryBox), this.detailsBox);
    this.reloadTrucks();
    this.runBtn.addEventListener('click', () => this.run());
    this.renderAll();
  }

  /** Called after master data changes so dropdowns and searches see the new rows. */
  reloadTrucks() {
    this.trucks = repo.listTrucks();
    this.renderTruckSelect();
  }

  mount3d() {
    if (this.view || !TruckView.supported()) {
      if (!TruckView.supported()) this.canvasHost.replaceChildren(h('p', { class: 'no-webgl' }, t.noWebgl));
      return;
    }
    this.view = new TruckView(this.canvasHost);
    this.update3d(true);
  }

  // ---------- Input panel ----------

  private inputPanel(): HTMLElement {
    const so = h('input', { type: 'text', id: 'so', placeholder: t.soPlaceholder });
    so.addEventListener('input', () => (this.state.so = so.value.trim()));

    const dest = combobox<Destination>({
      id: 'dest-search',
      placeholder: t.destinationPlaceholder,
      search: (q) => repo.searchDestinations(q),
      render: (d) =>
        h('div', { class: 'opt' }, h('strong', {}, d.customer), h('span', { class: 'muted' }, ` ${d.city}`), h('div', { class: 'opt-meta' }, `${d.ship_to_no ?? '–'} · ${d.zone ?? ''} · ${d.vehicle_type_raw ?? ''}`)),
      keepText: (d) => `${d.customer} – ${d.city}`,
      onPick: (d) => this.setDestination(d),
    });

    this.truckSelect.addEventListener('change', () => {
      this.state.truckId = Number(this.truckSelect.value) || null;
      this.markStale();
      this.renderTruckNote();
      this.update3d(true);
      this.renderSummary();
      this.renderDetails();
    });

    const sku = combobox<Sku>({
      id: 'sku-search',
      placeholder: t.skuPlaceholder,
      search: (q) => repo.searchSkus(q),
      render: (s) =>
        h(
          'div',
          { class: 'opt' },
          h('strong', {}, s.name),
          s.is_dummy ? h('span', { class: 'tag' }, t.dummy) : null,
          h('div', { class: 'opt-meta' }, `${s.code} · ${fmt.dims(s.length_cm, s.width_cm, s.height_cm)} cm · ${fmt.d3(s.volume_m3)} m³ · ${t.safeHeight} ${fmt.int(s.safe_stack_height_cm)} cm`),
        ),
      onPick: (s) => this.addLine(s),
    });

    const ai = h(
      'div',
      { class: 'ai-input' },
      h('div', { class: 'ai-head' }, h('button', { class: 'btn ghost', type: 'button', disabled: true }, '✦ ', t.aiInput), h('span', { class: 'tag soon' }, t.aiSoon)),
      h('p', { class: 'hint' }, t.aiInputHint),
    );

    return h(
      'section',
      { class: 'input panel' },
      h('h2', {}, t.inputTitle),
      ai,
      h('label', { for: 'so' }, t.soNumber),
      so,
      h('label', { for: 'dest-search' }, t.destination),
      dest.el,
      this.destCard,
      h('label', { for: 'truck-select' }, t.truck),
      this.truckSelect,
      this.truckNote,
      h('label', { for: 'sku-search' }, t.skuLines),
      sku.el,
      h('p', { class: 'hint' }, t.qtyHint),
      this.linesBox,
      this.runBtn,
      this.message,
    );
  }

  private setDestination(d: Destination) {
    this.state.destination = d;
    const max = repo.maxTruckFor(d.id);
    if (max) this.state.truckId = max.id;
    this.markStale();
    this.renderAll();
    this.update3d(true);
  }

  private addLine(s: Sku) {
    if (this.state.lines.some((l) => l.sku.id === s.id)) return;
    this.state.lines.push({ sku: s, qty: null });
    this.markStale();
    this.renderLines();
  }

  private markStale() {
    if (Object.keys(this.state.results).length) this.state.stale = true;
    this.renderModelCards();
  }

  private renderTruckSelect() {
    const allowed = this.state.destination ? repo.allowedTrucks(this.state.destination.id).map((x) => x.id) : [];
    this.truckSelect.replaceChildren(
      h('option', { value: '' }, '—'),
      ...this.trucks.map((tr) => {
        const vol = tr.est_volume_max ? ` · ${tr.est_volume_min && tr.est_volume_min !== tr.est_volume_max ? `${fmt.int(tr.est_volume_min)}–` : ''}${fmt.int(tr.est_volume_max)} m³` : '';
        return h('option', { value: tr.id, selected: tr.id === this.state.truckId }, `${tr.name}${vol}${allowed.includes(tr.id) ? ` ✓ ${t.allowedForDest}` : ''}`);
      }),
    );
    this.renderTruckNote();
  }

  private currentTruck(): TruckType | null {
    return this.trucks.find((x) => x.id === this.state.truckId) ?? null;
  }

  private renderTruckNote() {
    const tr = this.currentTruck();
    const notes: string[] = [];
    if (!tr) notes.push(t.truckDefaultHint);
    else {
      if (!repo.truckHasDims(tr)) notes.push(t.truckNoDims);
      if (this.state.destination) {
        const allowed = repo.allowedTrucks(this.state.destination.id);
        const max = allowed[0];
        if (!allowed.some((a) => a.id === tr.id)) {
          if (max && (tr.est_volume_max ?? 0) > (max.est_volume_max ?? 0)) notes.push(`⚠ ${t.overMax} (${max.name}).`);
          else notes.push(`⚠ ${t.notListed}.`);
        }
      }
    }
    this.truckNote.textContent = notes.join(' ');
    this.truckNote.classList.toggle('warn', notes.some((n) => n.startsWith('⚠') || n === t.truckNoDims));
  }

  private renderLines() {
    const { lines } = this.state;
    if (!lines.length) {
      this.linesBox.replaceChildren(h('p', { class: 'empty' }, t.noLines));
      return;
    }
    this.linesBox.replaceChildren(
      ...lines.map((line, i) => {
        const qty = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', placeholder: t.qtyMax, value: line.qty ?? '', 'aria-label': `${t.qty} ${line.sku.name}` });
        qty.addEventListener('change', () => {
          const v = parseInt(qty.value, 10);
          line.qty = Number.isFinite(v) && v > 0 ? v : null;
          this.markStale();
        });
        const s = line.sku;
        return h(
          'div',
          { class: 'line' },
          h('span', { class: 'swatch', style: `background:${skuColor(i)}` }),
          h(
            'div',
            { class: 'line-main' },
            h('div', { class: 'line-name' }, s.name, s.packaging === 'bale' ? h('span', { class: 'tag' }, t.bale) : null, s.is_dummy ? h('span', { class: 'tag' }, t.dummy) : null),
            h('div', { class: 'line-meta' }, `${s.code} · ${fmt.d3(s.volume_m3)} m³ · ${t.safeHeight} ${fmt.int(s.safe_stack_height_cm)} cm`),
          ),
          qty,
          h(
            'div',
            { class: 'line-actions' },
            h('button', { class: 'icon', type: 'button', title: t.moveUp, 'aria-label': t.moveUp, disabled: i === 0, onclick: () => this.moveLine(i) }, '↑'),
            h('button', { class: 'icon', type: 'button', title: t.remove, 'aria-label': t.remove, onclick: () => this.removeLine(i) }, '×'),
          ),
        );
      }),
    );
  }

  private moveLine(i: number) {
    const l = this.state.lines;
    [l[i - 1], l[i]] = [l[i], l[i - 1]];
    this.markStale();
    this.renderLines();
  }

  private removeLine(i: number) {
    this.state.lines.splice(i, 1);
    this.markStale();
    this.renderLines();
  }

  // ---------- Optimisation ----------

  private run() {
    const tr = this.currentTruck();
    if (!tr) return this.say(t.needTruck);
    if (!repo.truckHasDims(tr)) return this.say(t.truckNoDims);
    if (!this.state.lines.length) return this.say(t.needLines);
    this.say('');
    const req: PlanRequest = {
      truck: repo.toEngineTruck(tr),
      lines: this.state.lines.map((l) => ({ sku: repo.toEngineSku(l.sku), qty: l.qty })),
      timeBudgetMs: 700,
    };
    this.worker?.terminate();
    this.worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    this.state.results = {};
    this.state.stale = false;
    this.state.running = true;
    this.state.upToTier = 0;
    this.state.highlightTier = 0;
    this.runBtn.disabled = true;
    this.runBtn.textContent = t.running;
    this.renderModelCards();
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'result') {
        this.state.results[msg.result.model] = msg.result;
        this.renderModelCards();
        if (msg.result.model === this.state.selected) this.showSelected();
      } else {
        this.state.running = false;
        this.runBtn.disabled = false;
        this.runBtn.textContent = t.run;
        if (msg.type === 'error') this.say(msg.message);
        this.renderModelCards();
        this.worker?.terminate();
        this.worker = null;
      }
    };
    this.worker.postMessage(req);
  }

  private say(text: string) {
    this.state.message = text;
    this.message.textContent = text;
  }

  private selectedPlan(): PlanResult | null {
    return this.state.results[this.state.selected] ?? null;
  }

  private selectModel(m: ModelId) {
    this.state.selected = m;
    this.state.upToTier = 0;
    this.state.highlightTier = 0;
    this.renderModelCards();
    this.showSelected();
  }

  private showSelected() {
    this.update3d(false);
    this.renderStageTools();
    this.renderSummary();
    this.renderDetails();
  }

  // ---------- Stage: model cards + 3D ----------

  private stagePanel(): HTMLElement {
    return h('section', { class: 'stage panel' }, this.modelCards, h('div', { class: 'canvas-wrap' }, this.canvasHost, h('div', { class: 'axis-labels' }, h('span', {}, `◀ ${t.cab}`), h('span', {}, `${t.door} ▶`))), this.stageTools);
  }

  private renderModelCards() {
    const { results, selected, running, stale } = this.state;
    const any = Object.keys(results).length > 0;
    if (!any && !running) {
      this.modelCards.replaceChildren(h('p', { class: 'empty-state' }, t.emptyState));
      return;
    }
    const best = Math.max(...MODEL_ORDER.map((m) => results[m]?.totalCartons ?? 0));
    this.modelCards.replaceChildren(
      ...(stale ? [h('p', { class: 'stale-note' }, t.staleNote)] : []),
      ...MODEL_ORDER.map((m) => {
        const r = results[m];
        const card = h(
          'button',
          { type: 'button', class: `model-card${m === selected ? ' selected' : ''}${stale ? ' stale' : ''}`, 'aria-pressed': m === selected ? 'true' : 'false', disabled: !r, onclick: () => this.selectModel(m) },
          h('div', { class: 'mc-head' }, h('span', { class: 'mc-name' }, t.models[m]), m === selected ? h('span', { class: 'tag' }, t.chosen) : null),
          h('div', { class: 'mc-tag' }, t.modelTagline[m]),
          r
            ? [
                h('div', { class: 'mc-num' }, fmt.int(r.totalCartons), h('small', {}, ` ${t.cartons}`), r.totalCartons === best && best > 0 ? h('span', { class: 'best' }, '▲') : null),
                h('div', { class: 'mc-meta' }, `${fmt.pct(r.volumeUtilization)} · ${fmt.int(r.tiers.length)} ${r.segmentTiers ? t.segments : t.tiers}`),
                h('div', { class: 'mc-ai' }, t.plansEvaluated(r.plansEvaluated, r.elapsedMs)),
              ]
            : h('div', { class: 'mc-wait' }, h('span', { class: 'spinner' }), t.running),
        );
        return card;
      }),
    );
  }

  private renderStageTools() {
    const plan = this.selectedPlan();
    if (!plan) {
      this.stageTools.replaceChildren();
      return;
    }
    const mode = h('div', { class: 'seg' }, ...(['sku', 'tier'] as ColorMode[]).map((c) => h('button', { type: 'button', class: this.state.colorMode === c ? 'on' : '', onclick: () => ((this.state.colorMode = c), this.renderStageTools(), this.update3d(false)) }, c === 'sku' ? t.colorBySku : t.colorByTier)));
    const n = plan.tiers.length;
    const slider = h('input', { type: 'range', min: 0, max: n, step: 1, value: this.state.upToTier, 'aria-label': t.showUpTo });
    const label = h('span', { class: 'slider-val' }, this.state.upToTier ? `${this.state.upToTier} / ${n}` : t.all);
    slider.addEventListener('input', () => {
      this.state.upToTier = Number(slider.value);
      this.state.highlightTier = this.state.upToTier;
      label.textContent = this.state.upToTier ? `${this.state.upToTier} / ${n}` : t.all;
      this.update3d(false);
    });
    this.stageTools.replaceChildren(
      mode,
      h('label', { class: 'slider' }, `${t.showUpTo} `, slider, label),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => this.view?.frameCamera() }, t.resetView),
    );
  }

  private update3d(truckChanged: boolean) {
    if (!this.view) return;
    const tr = this.currentTruck();
    if (truckChanged) this.view.setTruck(tr && repo.truckHasDims(tr) ? repo.toEngineTruck(tr) : null);
    const plan = this.state.stale ? null : this.selectedPlan();
    this.view.setPlan(
      plan,
      this.state.colorMode,
      this.state.lines.map((l) => l.sku.id),
      this.state.upToTier,
      this.state.highlightTier,
    );
  }

  private focusTier(tier: number) {
    this.state.upToTier = tier;
    this.state.highlightTier = tier;
    this.renderStageTools();
    this.update3d(false);
    this.canvasHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- Summary ----------

  private renderSummary() {
    const tr = this.currentTruck();
    const d = this.state.destination;
    const plan = this.state.stale ? null : this.selectedPlan();
    const skuName = (id: number) => this.state.lines.find((l) => l.sku.id === id)?.sku;
    const skuIdx = (id: number) => this.state.lines.findIndex((l) => l.sku.id === id);

    const unplaced = plan ? Object.values(plan.unplaced).reduce((a, b) => a + b, 0) : 0;
    const kpis = plan
      ? h(
          'div',
          { class: 'kpis' },
          h('div', { class: 'kpi big' }, h('span', { class: 'kpi-label' }, t.totalCartons), h('span', { class: 'kpi-value' }, fmt.int(plan.totalCartons)), h('span', { class: 'kpi-sub' }, `${t.models[plan.model]}`)),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, plan.segmentTiers ? t.segmentCount : t.tierCount), h('span', { class: 'kpi-value' }, fmt.int(plan.tiers.length))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.utilization), h('span', { class: 'kpi-value' }, fmt.pct(plan.volumeUtilization))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.usedLength), h('span', { class: 'kpi-value' }, fmt.m(plan.usedLength))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.totalWeight), h('span', { class: 'kpi-value' }, `${fmt.int(plan.totalWeight)} kg`)),
        )
      : null;

    const truckBlock = tr
      ? h(
          'dl',
          { class: 'facts' },
          h('dt', {}, t.truckInfo),
          h('dd', {}, h('strong', {}, tr.name)),
          h('dt', {}, t.innerDims),
          h('dd', {}, `${fmt.dims(tr.inner_length_cm, tr.inner_width_cm, tr.inner_height_cm)} cm`, tr.dims_estimated ? h('span', { class: 'tag warn' }, t.estimated) : null),
          h('dt', {}, t.estVolume),
          h('dd', {}, tr.est_volume_max ? `${tr.est_volume_min && tr.est_volume_min !== tr.est_volume_max ? `${fmt.d1(tr.est_volume_min)}–` : ''}${fmt.d1(tr.est_volume_max)} m³` : '–'),
          h('dt', {}, t.calcVolume),
          h('dd', {}, repo.truckVolume(tr) ? `${fmt.d1(repo.truckVolume(tr)!)} m³` : '–'),
        )
      : null;

    const max = d ? repo.maxTruckFor(d.id) : null;
    const destBlock = d
      ? h(
          'dl',
          { class: 'facts' },
          h('dt', {}, t.destinationInfo),
          h('dd', {}, h('strong', {}, d.customer)),
          h('dt', {}, t.city),
          h('dd', {}, d.city),
          h('dt', {}, `${t.shipTo} / ${t.zone}`),
          h('dd', {}, `${d.ship_to_no ?? '–'} / ${d.zone ?? '–'}`),
          h('dt', {}, t.maxTruck),
          h('dd', {}, max?.name ?? d.vehicle_type_raw ?? '–'),
        )
      : null;

    const perTier = plan
      ? h(
          'div',
          { class: 'per-tier' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => ((this.state.showPerTier = !this.state.showPerTier), this.renderSummary()) }, this.state.showPerTier ? t.hidePerTier : t.showPerTier),
          this.state.showPerTier
            ? h(
                'ol',
                { class: 'tier-list' },
                ...plan.tiers.map((tier) =>
                  h(
                    'li',
                    { class: tier.index === this.state.highlightTier ? 'on' : '' },
                    h(
                      'button',
                      { type: 'button', onclick: () => this.focusTier(tier.index) },
                      h('span', { class: 'tl-no' }, `${plan.segmentTiers ? t.segments : t.tierNo} ${tier.index}`),
                      h('span', { class: 'tl-chips' }, ...Object.entries(tier.counts).map(([id, c]) => h('span', { class: 'chip', title: skuName(Number(id))?.name ?? '' }, h('i', { style: `background:${skuColor(skuIdx(Number(id)))}` }), fmt.int(c)))),
                      h('span', { class: 'tl-total' }, fmt.int(tier.total)),
                    ),
                  ),
                ),
              )
            : null,
        )
      : null;

    const actions = plan
      ? h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => this.save() }, t.savePlan),
          h('button', { class: 'btn primary', type: 'button', onclick: () => this.print() }, t.print),
        )
      : null;

    this.summaryBox.replaceChildren(
      ...[kpis, unplaced ? h('p', { class: 'alert' }, t.unplacedWarn(unplaced)) : null, actions, truckBlock, destBlock, perTier].filter((x) => x != null) as HTMLElement[],
    );
    if (!this.summaryBox.childElementCount) this.summaryBox.append(h('p', { class: 'muted' }, t.emptyState));
  }

  private save() {
    const plan = this.selectedPlan();
    const tr = this.currentTruck();
    if (!plan || !tr) return;
    repo.saveShipmentPlan(this.state.so || null, this.state.destination?.id ?? null, tr.id, this.state.lines.map((l) => ({ skuId: l.sku.id, qty: l.qty })), plan);
    this.say(`${t.saved} ✓`);
  }

  private print() {
    const plan = this.selectedPlan();
    const tr = this.currentTruck();
    if (!plan || !tr) return;
    printPlan({ plan, truck: tr, destination: this.state.destination, so: this.state.so, skus: this.state.lines.map((l) => l.sku), snapshot: this.view?.snapshot() ?? null });
  }

  // ---------- Details ----------

  private renderDetails() {
    const open = this.state.detailsOpen;
    const toggle = h('button', { class: 'btn ghost small', type: 'button', 'aria-expanded': String(open), onclick: () => ((this.state.detailsOpen = !open), this.renderDetails()) }, open ? t.hideDetails : t.showDetails);
    const head = h('div', { class: 'details-head' }, h('h2', {}, t.details), toggle);
    if (!open) {
      this.detailsBox.replaceChildren(head);
      return;
    }
    const plan = this.state.stale ? null : this.selectedPlan();
    const tr = this.currentTruck();
    const d = this.state.destination;
    const lines = this.state.lines;
    const skuIdx = (id: number) => lines.findIndex((l) => l.sku.id === id);
    const section = (title: string, body: Node, openByDefault = false) => h('details', { open: openByDefault }, h('summary', {}, title), h('div', { class: 'details-body' }, body));

    const tierTable = plan
      ? h(
          'div',
          {},
          plan.segmentTiers ? h('p', { class: 'hint' }, t.segmentNote) : null,
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, h('th', {}, plan.segmentTiers ? t.segments : t.tierNo), h('th', {}, t.depth), h('th', {}, t.grid), h('th', {}, t.content), h('th', { class: 'num' }, t.total))),
              h(
                'tbody',
                {},
                ...plan.tiers.map((tier) =>
                  h(
                    'tr',
                    { class: tier.index === this.state.highlightTier ? 'on' : '', onclick: () => this.focusTier(tier.index) },
                    h('td', {}, String(tier.index)),
                    h('td', {}, `${fmt.int(tier.depth)} cm`),
                    h('td', {}, tier.columns ? `${tier.columns} × ${tier.layers}` : t.mixedTier),
                    h('td', {}, ...Object.entries(tier.counts).map(([id, c]) => h('span', { class: 'chip' }, h('i', { style: `background:${skuColor(skuIdx(Number(id)))}` }), `${lines[skuIdx(Number(id))]?.sku.code ?? id}: ${fmt.int(c)}`))),
                    h('td', { class: 'num' }, fmt.int(tier.total)),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, t.emptyState);

    const skuTable = lines.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ...[t.code, t.name, t.dims, t.volume, t.safeHeight, t.weight, t.requested, t.loaded, t.remaining].map((x, i) => h('th', { class: i >= 3 ? 'num' : '' }, x)))),
            h(
              'tbody',
              {},
              ...lines.map((l, i) => {
                const loaded = plan?.loaded[l.sku.id] ?? 0;
                const rest = l.qty != null ? Math.max(0, l.qty - loaded) : null;
                return h(
                  'tr',
                  {},
                  h('td', {}, h('span', { class: 'chip' }, h('i', { style: `background:${skuColor(i)}` }), l.sku.code)),
                  h('td', {}, l.sku.name),
                  h('td', {}, fmt.dims(l.sku.length_cm, l.sku.width_cm, l.sku.height_cm)),
                  h('td', { class: 'num' }, fmt.d3(l.sku.volume_m3)),
                  h('td', { class: 'num' }, `${fmt.int(l.sku.safe_stack_height_cm)} cm`),
                  h('td', { class: 'num' }, l.sku.weight_kg != null ? fmt.d1(l.sku.weight_kg) : '–'),
                  h('td', { class: 'num' }, l.qty != null ? fmt.int(l.qty) : t.qtyMax),
                  h('td', { class: 'num' }, plan ? fmt.int(loaded) : '–'),
                  h('td', { class: `num${rest ? ' bad' : ''}` }, plan && rest != null ? fmt.int(rest) : '–'),
                );
              }),
            ),
          ),
        )
      : h('p', { class: 'muted' }, t.noLines);

    const truckBody = tr
      ? h(
          'dl',
          { class: 'facts wide' },
          h('dt', {}, t.name),
          h('dd', {}, `${tr.name} (${tr.code})`),
          h('dt', {}, t.innerDims),
          h('dd', {}, `${fmt.dims(tr.inner_length_cm, tr.inner_width_cm, tr.inner_height_cm)} cm`, tr.dims_estimated ? h('span', { class: 'tag warn' }, t.estimated) : null),
          h('dt', {}, t.estVolume),
          h('dd', {}, tr.est_volume_max ? `${fmt.d1(tr.est_volume_min ?? tr.est_volume_max)}–${fmt.d1(tr.est_volume_max)} m³` : '–'),
          h('dt', {}, t.calcVolume),
          h('dd', {}, repo.truckVolume(tr) ? `${fmt.d2(repo.truckVolume(tr)!)} m³` : '–'),
          h('dt', {}, t.payloadKg),
          h('dd', {}, tr.max_payload_kg ? fmt.int(tr.max_payload_kg) : '–'),
          h('dt', {}, t.notes),
          h('dd', {}, tr.notes ?? '–'),
        )
      : h('p', { class: 'muted' }, t.needTruck);

    const destBody = d
      ? h(
          'dl',
          { class: 'facts wide' },
          h('dt', {}, t.customer),
          h('dd', {}, d.customer),
          h('dt', {}, t.city),
          h('dd', {}, d.city),
          h('dt', {}, t.shipTo),
          h('dd', {}, d.ship_to_no ?? '–'),
          h('dt', {}, t.zone),
          h('dd', {}, d.zone ?? '–'),
          h('dt', {}, t.vehicleRaw),
          h('dd', {}, d.vehicle_type_raw ?? '–'),
          h('dt', {}, t.allowedTrucks),
          h('dd', {}, repo.allowedTrucks(d.id).map((x) => x.name).join(', ') || '–'),
          h('dt', {}, t.maxTruck),
          h('dd', {}, repo.maxTruckFor(d.id)?.name ?? '–'),
        )
      : h('p', { class: 'muted' }, t.destinationPlaceholder);

    const rules = h(
      'div',
      { class: 'rules' },
      h('h4', {}, 'Semua model'),
      h('ul', {}, ...t.rules.common.map((r) => h('li', {}, r))),
      ...MODEL_ORDER.map((m) => h('div', { class: m === this.state.selected ? 'rule-block on' : 'rule-block' }, h('h4', {}, `${t.models[m]}${m === this.state.selected ? ` · ${t.chosen}` : ''}`), h('ul', {}, ...t.rules[m].map((r) => h('li', {}, r))))),
    );

    this.detailsBox.replaceChildren(
      head,
      section(t.detailTiers, tierTable, true),
      section(t.detailSkus, skuTable, true),
      section(t.detailTruck, truckBody),
      section(t.detailDestination, destBody),
      section(t.detailRules, rules),
    );
  }

  private renderDestCard() {
    const d = this.state.destination;
    if (!d) {
      this.destCard.replaceChildren();
      return;
    }
    const max = repo.maxTruckFor(d.id);
    this.destCard.replaceChildren(
      h('div', { class: 'dc-name' }, d.customer),
      h('div', { class: 'dc-meta' }, `${d.city} · ${d.zone ?? ''} · ${t.shipTo} ${d.ship_to_no ?? '–'}`),
      h('div', { class: 'dc-meta' }, `${t.maxTruck}: `, h('strong', {}, max?.name ?? d.vehicle_type_raw ?? '–')),
    );
  }

  private renderAll() {
    this.renderDestCard();
    this.renderTruckSelect();
    this.renderLines();
    this.renderModelCards();
    this.renderStageTools();
    this.renderSummary();
    this.renderDetails();
  }

  /** Fills the form with a sample shipment so first-time viewers see a plan immediately. */
  loadExample() {
    const dest = repo.searchDestinations('UNIRAMA DUTA NIAGA, PT (GD)', 1)[0] ?? repo.listDestinations()[0];
    if (dest) {
      this.state.destination = dest;
      this.state.truckId = repo.maxTruckFor(dest.id)?.id ?? null;
    }
    const skus = repo.listSkus();
    const pick = (code: string) => skus.find((s) => s.code === code);
    this.state.lines = (
      [
        ['DUM-001', 180],
        ['DUM-007', 120],
        ['DUM-004', 150],
        ['DUM-003', null],
      ] as [string, number | null][]
    )
      .map(([code, qty]) => ({ sku: pick(code)!, qty }))
      .filter((l) => l.sku);
    this.state.so = 'SO-CONTOH-001';
    (this.el.querySelector('#so') as HTMLInputElement).value = this.state.so;
    (this.el.querySelector('#dest-search') as HTMLInputElement).value = dest ? `${dest.customer} – ${dest.city}` : '';
    this.renderAll();
    this.update3d(true);
    this.run();
  }
}
