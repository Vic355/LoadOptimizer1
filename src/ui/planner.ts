import { MODEL_ORDER, withDefaults, type ModelId, type PlacedBox, type PlanRequest, type PlanResult, type SearchProgress } from '../engine';
import type { WorkerRequest, WorkerResponse } from '../engine/worker';
import * as repo from '../db/repo';
import type { Destination, SavedPlan, Sku, TruckType } from '../db/repo';
import { t } from '../i18n/id';
import { combobox } from './combobox';
import { fmt, h } from './dom';
import { skuColor } from './colors';
import { TruckView, riskColor, type ColorMode } from './view3d';
import { printPlan } from './print';
import { describeRules } from './rules-text';
import { openSkuForm } from './sku-form';

interface Line {
  sku: Sku;
  qty: number | null;
}

interface CustomTruck {
  name: string;
  length: number;
  width: number;
  height: number;
}

/** The truck a plan is made for: a master-data truck, or a one-off size typed on the input screen. */
export interface PlanningTruck extends repo.PlanTruck {
  id: number | null;
  type: TruckType | null;
}

const CUSTOM = 'custom';

export class Planner {
  readonly el: HTMLElement;
  private reference = '';
  private destination: Destination | null = null;
  private truckId: number | typeof CUSTOM | null = null;
  private custom: CustomTruck = { name: '', length: 0, width: 0, height: 0 };
  private lines: Line[] = [];
  private results: Partial<Record<ModelId, PlanResult>> = {};
  private progress: Partial<Record<ModelId, SearchProgress>> = {};
  private stale = false;
  private selected: ModelId = 'standard';
  private colorMode: ColorMode = 'sku';
  private upToTier = 0;
  private showPerTier = false;
  private detailsOpen = false;
  private picked: PlacedBox | null = null;
  private trucks: TruckType[] = [];
  private view: TruckView | null = null;
  private workers: Worker[] = [];

  // Mount points that re-render independently.
  private refInput = h('input', { type: 'text', id: 'reference', placeholder: t.referencePlaceholder });
  private destCard = h('div', { class: 'dest-card' });
  private truckSelect = h('select', { id: 'truck-select' });
  private truckNote = h('p', { class: 'hint' });
  private customBox = h('details', { class: 'custom-truck' });
  private linesBox = h('div', { class: 'lines' });
  private runBtn = h('button', { class: 'btn primary run', type: 'button' }, t.run);
  private message = h('p', { class: 'message', role: 'status' });
  private modelCards = h('div', { class: 'model-cards' });
  private stageTools = h('div', { class: 'stage-tools' });
  private canvasHost = h('div', { class: 'canvas-host' });
  private pickedBox = h('div', { class: 'picked', hidden: true });
  private summaryBox = h('div', { class: 'summary-body' });
  private detailsBox = h('section', { class: 'details panel' });
  private loading = h('div', { class: 'loading-overlay', hidden: true });
  private destCombo: ReturnType<typeof combobox<Destination>>;

  constructor(private onSaved: () => void) {
    this.destCombo = combobox<Destination>({
      id: 'dest-search',
      placeholder: t.destinationPlaceholder,
      search: (q) => repo.searchDestinations(q),
      render: (d) => h('div', { class: 'opt' }, h('strong', {}, d.customer), h('span', { class: 'muted' }, ` ${d.city}`), h('div', { class: 'opt-meta' }, `${d.zone ?? ''} · ${d.vehicle_type_raw ?? ''}`)),
      keepText: (d) => `${d.customer} – ${d.city}`,
      onPick: (d) => this.setDestination(d),
    });
    this.el = h(
      'div',
      { class: 'planner' },
      this.inputPanel(),
      this.stagePanel(),
      h('aside', { class: 'summary panel' }, h('h2', {}, t.summary), this.summaryBox),
      this.detailsBox,
      this.loading,
    );
    this.reloadTrucks();
    this.runBtn.addEventListener('click', () => this.run());
    this.renderAll();
  }

  /** Called after master data changes so dropdowns and searches see the new rows. */
  reloadTrucks() {
    this.trucks = repo.listTrucks();
    if (typeof this.truckId === 'number' && !this.trucks.some((x) => x.id === this.truckId)) this.truckId = null;
    this.renderTruckSelect();
  }

  mount3d() {
    if (!TruckView.supported()) {
      this.canvasHost.replaceChildren(h('p', { class: 'no-webgl' }, t.noWebgl));
      return;
    }
    if (this.view) return;
    this.view = new TruckView(this.canvasHost);
    this.view.onPick = (box) => {
      this.picked = box;
      this.renderPicked();
    };
    this.update3d(true);
  }

  refreshTheme() {
    this.view?.refreshTheme();
  }

  // ---------- Input panel ----------

  private inputPanel(): HTMLElement {
    this.refInput.addEventListener('input', () => (this.reference = this.refInput.value.trim()));
    this.truckSelect.addEventListener('change', () => {
      const v = this.truckSelect.value;
      this.truckId = v === CUSTOM ? CUSTOM : Number(v) || null;
      if (this.truckId === CUSTOM) this.customBox.open = true;
      this.truckChanged();
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
          personalTag(s),
          h('div', { class: 'opt-meta' }, `${s.code} · ${fmt.dims(...repo.plannedDims(s))} cm · ${fmt.d3(s.volume_m3)} m³ · ${t.safeLayersShort(s.safe_stack_layers)}`),
        ),
      onPick: (s) => this.addLine(s, null),
    });

    const ai = h(
      'div',
      { class: 'ai-input' },
      h('div', { class: 'ai-head' }, h('button', { class: 'btn ghost', type: 'button', disabled: true }, '✦ ', t.aiInput), h('span', { class: 'tag soon' }, t.aiSoon)),
      h('p', { class: 'hint' }, t.aiInputHint),
    );

    this.renderCustomBox();
    return h(
      'section',
      { class: 'input panel' },
      h('h2', {}, t.inputTitle),
      h('label', { for: 'dest-search' }, t.destination),
      this.destCombo.el,
      this.destCard,
      h('label', { for: 'truck-select' }, t.truck),
      this.truckSelect,
      this.truckNote,
      this.customBox,
      h(
        'div',
        { class: 'label-row' },
        h('label', { for: 'sku-search' }, t.skuLines),
        h(
          'span',
          { class: 'label-actions' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => openSkuForm(null, (s) => this.addLine(s, null)) }, `+ ${t.newSku}`),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.pasteDialog() }, t.pasteExcel),
        ),
      ),
      sku.el,
      h('p', { class: 'hint' }, t.qtyHint),
      this.linesBox,
      h('label', { for: 'reference' }, t.reference),
      this.refInput,
      this.runBtn,
      this.message,
      ai,
    );
  }

  private renderCustomBox() {
    const num = (key: 'length' | 'width' | 'height', label: string) => {
      const input = h('input', { type: 'number', min: 1, step: 'any', inputmode: 'decimal', value: this.custom[key] || '', 'aria-label': label });
      input.addEventListener('input', () => (this.custom[key] = Number(input.value) || 0));
      return h('label', {}, label, input);
    };
    const name = h('input', { type: 'text', value: this.custom.name, placeholder: 'mis. Tronton ODOL B 1234' });
    name.addEventListener('input', () => (this.custom.name = name.value.trim()));
    const keep = h('input', { type: 'checkbox' });
    const apply = () => {
      if (!(this.custom.length > 0 && this.custom.width > 0 && this.custom.height > 0)) return this.say(t.truckNoDims);
      if (keep.checked) {
        const label = this.custom.name || `${t.customTruckLabel} ${fmt.dims(this.custom.length, this.custom.width, this.custom.height)}`;
        const id = repo.saveTruck({
          code: `ODOL-${Date.now().toString(36).toUpperCase()}`,
          name: label,
          variant: null,
          body_type: 'box',
          est_volume_min: null,
          est_volume_max: null,
          inner_length_cm: this.custom.length,
          inner_width_cm: this.custom.width,
          inner_height_cm: this.custom.height,
          dims_estimated: 0,
          is_template: 1,
          notes: null,
        });
        this.reloadTrucks();
        this.truckId = id;
        this.say(t.templateSaved);
      } else this.truckId = CUSTOM;
      this.renderTruckSelect();
      this.truckChanged();
    };
    this.customBox.replaceChildren(
      h('summary', {}, t.customTruck),
      h('p', { class: 'hint' }, t.customTruckHint),
      h('div', { class: 'dims-grid' }, num('length', t.lengthCm), num('width', t.widthCm), num('height', t.heightCm)),
      h('label', {}, t.customName, name),
      h('label', { class: 'check' }, keep, ` ${t.saveAsTemplate}`),
      h('button', { class: 'btn small', type: 'button', onclick: apply }, t.useCustom),
    );
  }

  private truckChanged() {
    this.markStale();
    this.renderTruckNote();
    this.update3d(true);
    this.renderSummary();
    this.renderDetails();
  }

  private setDestination(d: Destination) {
    this.destination = d;
    const max = repo.maxTruckFor(d.id);
    if (max) this.truckId = max.id;
    this.markStale();
    this.renderAll();
    this.update3d(true);
  }

  private addLine(s: Sku, qty: number | null) {
    const existing = this.lines.find((l) => l.sku.id === s.id);
    if (existing) existing.qty = qty ?? existing.qty;
    else this.lines.push({ sku: s, qty });
    this.markStale();
    this.renderLines();
  }

  /** After a SKU is edited, every line using it plans with the new size. */
  private replaceSku(oldId: number, next: Sku) {
    for (const l of this.lines) if (l.sku.id === oldId) l.sku = next;
    this.markStale();
    this.renderLines();
  }

  private pasteDialog() {
    const area = h('textarea', { rows: 8, placeholder: 'DUM-001\t180\nDUM-003\t' });
    const result = h('p', { class: 'hint' });
    const dialog = h('dialog', { class: 'form-dialog' });
    const add = () => {
      let added = 0;
      const missing: string[] = [];
      for (const raw of area.value.split(/\r?\n/)) {
        const [code, qtyText] = raw.split(/\t|;|,/).map((x) => x.trim());
        if (!code) continue;
        const s = repo.skuByCode(code);
        if (!s) {
          if (!/^(no|kode|sap|material)/i.test(code)) missing.push(code);
          continue;
        }
        const q = parseInt((qtyText ?? '').replace(/\./g, ''), 10);
        this.addLine(s, Number.isFinite(q) && q > 0 ? q : null);
        added++;
      }
      result.textContent = t.pasteResult(added, missing);
      if (!missing.length) dialog.close();
    };
    dialog.append(
      h('h3', {}, t.pasteTitle),
      h('p', { class: 'hint' }, t.pasteHint),
      area,
      result,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, t.close), h('button', { class: 'btn primary', type: 'button', onclick: add }, t.pasteAdd)),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    area.focus();
  }

  private markStale() {
    if (Object.keys(this.results).length) this.stale = true;
    this.renderModelCards();
  }

  private renderTruckSelect() {
    const max = this.destination ? repo.maxTruckFor(this.destination.id) : null;
    const option = (tr: TruckType) => {
      const vol = tr.est_volume_max ? ` · ${fmt.d1(tr.est_volume_max)} m³` : '';
      const dims = repo.truckHasDims(tr) ? ` · ${fmt.dims(tr.inner_length_cm, tr.inner_width_cm, tr.inner_height_cm)} cm` : '';
      return h('option', { value: tr.id, selected: tr.id === this.truckId }, `${repo.truckLabel(tr)}${tr.is_template ? dims : `${vol}${dims}`}${max?.id === tr.id ? ` ✓ ${t.listedForDest}` : ''}`);
    };
    const standard = this.trucks.filter((x) => !x.is_template);
    const templates = this.trucks.filter((x) => x.is_template);
    this.truckSelect.replaceChildren(
      h('option', { value: '' }, '—'),
      ...standard.map(option),
      ...(templates.length ? [h('optgroup', { label: t.isTemplate }, ...templates.map(option))] : []),
      h('option', { value: CUSTOM, selected: this.truckId === CUSTOM }, `${t.customTruck}…`),
    );
    this.renderTruckNote();
  }

  private currentTruck(): PlanningTruck | null {
    if (this.truckId === CUSTOM) {
      const c = this.custom;
      if (!(c.length > 0 && c.width > 0 && c.height > 0)) return null;
      return { id: null, type: null, name: c.name || t.customTruckLabel, length: c.length, width: c.width, height: c.height };
    }
    const tr = this.trucks.find((x) => x.id === this.truckId);
    if (!tr) return null;
    return { id: tr.id, type: tr, name: repo.truckLabel(tr), ...repo.toEngineTruck(tr) };
  }

  private renderTruckNote() {
    const tr = this.trucks.find((x) => x.id === this.truckId);
    const notes: string[] = [];
    let warn = false;
    if (this.truckId === CUSTOM) notes.push(t.customTruckHint);
    else if (!tr) notes.push(t.truckDefaultHint);
    else {
      if (!repo.truckHasDims(tr)) {
        notes.push(t.truckNoDims);
        warn = true;
      }
      const max = this.destination ? repo.maxTruckFor(this.destination.id) : null;
      if (max && repo.truckSize(tr) > repo.truckSize(max)) {
        notes.push(`⚠ ${t.overMax} (${repo.truckLabel(max)}).`);
        warn = true;
      }
    }
    this.truckNote.textContent = notes.join(' ');
    this.truckNote.classList.toggle('warn', warn);
  }

  private renderLines() {
    if (!this.lines.length) {
      this.linesBox.replaceChildren(h('p', { class: 'empty' }, t.noLines));
      return;
    }
    let dragFrom = -1;
    this.linesBox.replaceChildren(
      ...this.lines.map((line, i) => {
        const qty = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', placeholder: t.qtyMax, value: line.qty ?? '', 'aria-label': `${t.qty} ${line.sku.name}` });
        qty.addEventListener('change', () => {
          const v = parseInt(qty.value, 10);
          line.qty = Number.isFinite(v) && v > 0 ? v : null;
          this.markStale();
        });
        const s = line.sku;
        const [pl, pw, ph] = repo.plannedDims(s);
        const modified = s.mod_length_cm || s.mod_width_cm || s.mod_height_cm;
        const row = h(
          'div',
          { class: 'line', draggable: 'true' },
          h('span', { class: 'grip', title: t.dragHandle, 'aria-hidden': 'true' }, '⋮⋮'),
          h('span', { class: 'swatch', style: `background:${skuColor(i)}` }),
          h(
            'div',
            { class: 'line-main' },
            h('div', { class: 'line-name' }, `${s.code} · ${s.name}`, s.packaging === 'bundle' ? h('span', { class: 'tag' }, t.bundle) : null, s.is_dummy ? h('span', { class: 'tag' }, t.dummy) : null, personalTag(s)),
            h('div', { class: 'line-meta' }, `${fmt.d3(s.volume_m3)} m³ · ${t.safeLayersShort(s.safe_stack_layers)} · ${fmt.dims(pl, pw, ph)} cm${modified ? ` (${t.modShort})` : ''}`),
          ),
          qty,
          h(
            'div',
            { class: 'line-actions' },
            h('button', { class: 'icon', type: 'button', title: t.moveUp, 'aria-label': t.moveUp, disabled: i === 0, onclick: () => this.moveLine(i, i - 1) }, '↑'),
            h('button', { class: 'icon', type: 'button', title: t.editSku, 'aria-label': t.editSku, onclick: () => openSkuForm(s, (next) => this.replaceSku(s.id, next)) }, '✎'),
            h('button', { class: 'icon', type: 'button', title: t.remove, 'aria-label': t.remove, onclick: () => this.removeLine(i) }, '×'),
          ),
        );
        row.addEventListener('dragstart', (e) => {
          dragFrom = i;
          e.dataTransfer?.setData('text/plain', String(i));
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          row.classList.add('drop');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          if (dragFrom >= 0 && dragFrom !== i) this.moveLine(dragFrom, i);
        });
        return row;
      }),
    );
  }

  private moveLine(from: number, to: number) {
    const [line] = this.lines.splice(from, 1);
    this.lines.splice(to, 0, line);
    this.markStale();
    this.renderLines();
  }

  private removeLine(i: number) {
    this.lines.splice(i, 1);
    this.markStale();
    this.renderLines();
  }

  // ---------- Optimisation ----------

  private run() {
    const tr = this.currentTruck();
    if (!tr) return this.say(this.truckId === CUSTOM ? t.truckNoDims : t.needTruck);
    if (!(tr.length && tr.width && tr.height)) return this.say(t.truckNoDims);
    if (!this.lines.length) return this.say(t.needLines);
    this.say('');
    const rules = repo.loadRules();
    const base = {
      truck: { length: tr.length, width: tr.width, height: tr.height },
      lines: this.lines.map((l) => ({ sku: repo.toEngineSku(l.sku), qty: l.qty })),
    };
    this.cancel();
    this.results = {};
    this.progress = {};
    this.stale = false;
    this.upToTier = 0;
    this.picked = null;
    this.runBtn.disabled = true;
    this.runBtn.textContent = t.running;
    this.renderModelCards();
    this.renderLoading();
    // One worker per model, so the three searches run side by side.
    for (const model of MODEL_ORDER) {
      const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
      this.workers.push(worker);
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.type === 'progress') this.progress[msg.model] = msg.progress;
        else if (msg.type === 'result') {
          this.results[msg.result.model] = msg.result;
          worker.terminate();
          this.renderModelCards();
          if (msg.result.model === this.selected) this.showSelected();
        } else {
          this.say(msg.message);
          worker.terminate();
          this.results[msg.model] = undefined;
          this.progress[msg.model] = { evaluated: 0, bestCartons: 0, fraction: 1 };
        }
        this.renderLoading();
        if (MODEL_ORDER.every((m) => this.results[m] || this.progress[m]?.fraction === 1)) this.finishRun();
      };
      const req: PlanRequest = { ...base, rules: rules[model] };
      worker.postMessage({ model, req } satisfies WorkerRequest);
    }
  }

  private finishRun() {
    this.workers = [];
    this.runBtn.disabled = false;
    this.runBtn.textContent = t.run;
    this.loading.hidden = true;
    this.renderModelCards();
    this.showSelected();
  }

  private cancel() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.runBtn.disabled = false;
    this.runBtn.textContent = t.run;
    this.loading.hidden = true;
  }

  private renderLoading() {
    const tr = this.currentTruck();
    this.loading.hidden = false;
    this.loading.replaceChildren(
      h(
        'section',
        { class: 'loading-card', role: 'dialog', 'aria-label': t.loadingTitle },
        h('h3', {}, t.loadingTitle),
        h('p', { class: 'muted' }, t.loadingSub(tr?.name ?? '', this.lines.length)),
        ...MODEL_ORDER.map((m) => {
          const r = this.results[m];
          const p = this.progress[m];
          const pct = r ? 100 : Math.round((p?.fraction ?? 0) * 100);
          return h(
            'div',
            { class: 'lp-row' },
            h('div', { class: 'lp-head' }, h('strong', {}, t.models[m]), h('span', { class: 'mono' }, r ? t.loadingDone(r.totalCartons) : `${pct}%`)),
            h('div', { class: 'lp-bar' }, h('span', { class: r ? 'done' : '', style: `width:${pct}%` })),
            h('div', { class: 'hint' }, r ? t.plansEvaluated(r.plansEvaluated, r.elapsedMs) : p ? t.loadingBest(p.evaluated, p.bestCartons) : ''),
          );
        }),
        h('div', { class: 'lp-foot' }, h('span', { class: 'hint' }, t.loadingHint), h('button', { class: 'btn', type: 'button', onclick: () => this.cancel() }, t.cancel)),
      ),
    );
  }

  private say(text: string) {
    this.message.textContent = text;
  }

  private selectedPlan(): PlanResult | null {
    return this.stale ? null : this.results[this.selected] ?? null;
  }

  private selectModel(m: ModelId) {
    this.selected = m;
    this.upToTier = 0;
    this.picked = null;
    this.renderModelCards();
    this.showSelected();
  }

  private showSelected() {
    this.update3d(false);
    this.renderStageTools();
    this.renderPicked();
    this.renderSummary();
    this.renderDetails();
  }

  // ---------- Stage: model cards + 3D ----------

  private stagePanel(): HTMLElement {
    return h(
      'section',
      { class: 'stage panel' },
      this.modelCards,
      h('div', { class: 'canvas-wrap' }, this.canvasHost, this.pickedBox, h('div', { class: 'axis-labels' }, h('span', {}, `◀ ${t.cab}`), h('span', {}, `${t.door} ▶`))),
      this.stageTools,
      h('p', { class: 'hint' }, t.viewHint),
    );
  }

  private renderModelCards() {
    const { results, stale } = this;
    const running = this.workers.length > 0;
    if (!Object.keys(results).length && !running) {
      this.modelCards.replaceChildren(h('p', { class: 'empty-state' }, t.emptyState));
      return;
    }
    const ranked = MODEL_ORDER.filter((m) => results[m]).sort((a, b) => results[b]!.totalCartons - results[a]!.totalCartons);
    const rank = (m: ModelId) => {
      const r = results[m]!;
      const better = ranked.filter((x) => results[x]!.totalCartons > r.totalCartons).length;
      return better === 0 ? t.rankFirst : t.rankNth(better + 1);
    };
    this.modelCards.replaceChildren(
      ...(stale ? [h('p', { class: 'stale-note' }, t.staleNote)] : []),
      ...MODEL_ORDER.map((m) => {
        const r = results[m];
        const on = m === this.selected;
        return h(
          'button',
          { type: 'button', class: `model-card${on ? ' selected' : ''}${stale ? ' stale' : ''}`, 'aria-pressed': String(on), disabled: !r, onclick: () => this.selectModel(m) },
          h('div', { class: 'mc-head' }, h('span', { class: 'mc-name' }, t.models[m]), r ? h('span', { class: `rank${rank(m) === t.rankFirst ? ' first' : ''}` }, rank(m)) : null),
          h('div', { class: 'mc-tag' }, t.modelTagline[m]),
          r
            ? [
                h('div', { class: 'mc-num' }, fmt.int(r.totalCartons), h('small', {}, ` ${t.cartons}`)),
                h('div', { class: 'mc-meta' }, `${fmt.pct(r.volumeUtilization)} · ${fmt.int(r.tiers.length)} ${r.segmentTiers ? t.segments : t.tiers}`),
                stabilityBadge(r),
                h('div', { class: 'mc-sel' }, on ? t.chosen : t.pick),
              ]
            : h('div', { class: 'mc-wait' }, h('span', { class: 'spinner' }), t.running),
        );
      }),
    );
  }

  private renderStageTools() {
    const plan = this.selectedPlan();
    if (!plan) {
      this.stageTools.replaceChildren();
      return;
    }
    const n = plan.tiers.length;
    const set = (v: number) => {
      this.upToTier = v >= n ? 0 : Math.max(1, v);
      this.renderStageTools();
      this.update3d(false);
      this.renderSummary();
    };
    const mode = h(
      'div',
      { class: 'seg' },
      ...(['sku', 'tier', 'risk'] as ColorMode[]).map((c) =>
        h('button', { type: 'button', class: this.colorMode === c ? 'on' : '', onclick: () => ((this.colorMode = c), this.renderStageTools(), this.update3d(false)) }, c === 'sku' ? t.colorBySku : c === 'tier' ? t.colorByTier : t.colorByRisk),
      ),
    );
    const current = this.upToTier || n;
    this.stageTools.replaceChildren(
      mode,
      h(
        'div',
        { class: 'stepper' },
        h('button', { class: 'icon', type: 'button', 'aria-label': t.prevTier, title: t.prevTier, disabled: current <= 1, onclick: () => set(current - 1) }, '‹'),
        h('span', { class: 'mono step-label' }, this.upToTier ? t.upTo(this.upToTier, n) : t.allTiers(n)),
        h('button', { class: 'icon', type: 'button', 'aria-label': t.nextTier, title: t.nextTier, disabled: !this.upToTier, onclick: () => set(current + 1) }, '›'),
      ),
      h('button', { class: 'btn small', type: 'button', onclick: () => set(1) }, t.stepThrough),
      h('button', { class: 'btn small', type: 'button', disabled: !this.upToTier, onclick: () => set(n) }, t.all),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.view?.frameCamera() }, t.resetView),
    );
  }

  private renderPicked() {
    const b = this.picked;
    const plan = this.selectedPlan();
    if (!b || !plan) {
      this.pickedBox.hidden = true;
      return;
    }
    const line = this.lines.find((l) => l.sku.id === b.skuId);
    const below = plan.boxes.filter((o) => o.tier === b.tier && o.z < b.z && o.y < b.y + b.dy && b.y < o.y + o.dy && o.x < b.x + b.dx && b.x < o.x + o.dx).length;
    this.pickedBox.hidden = false;
    this.pickedBox.replaceChildren(
      h('strong', {}, t.picked),
      h('div', {}, line ? `${line.sku.code} · ${line.sku.name}` : String(b.skuId)),
      h('div', { class: 'muted' }, t.pickedWhere(b.tier, below + 1, plan.segmentTiers)),
      h('div', { class: 'muted mono' }, `${fmt.dims(b.dx, b.dy, b.dz)} cm`),
      ...[riskText(plan, b)].filter((x): x is HTMLDivElement => !!x),
    );
  }

  private update3d(truckChanged: boolean) {
    if (!this.view) return;
    const tr = this.currentTruck();
    if (truckChanged) this.view.setTruck(tr ? { length: tr.length, width: tr.width, height: tr.height } : null);
    this.view.setPlan(this.selectedPlan(), this.colorMode, this.lines.map((l) => l.sku.id), this.upToTier, this.upToTier);
  }

  private focusTier(tier: number) {
    this.upToTier = tier;
    this.renderStageTools();
    this.update3d(false);
    this.renderSummary();
    this.canvasHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- Summary ----------

  private renderSummary() {
    const tr = this.currentTruck();
    const d = this.destination;
    const plan = this.selectedPlan();
    const skuOf = (id: number) => this.lines.find((l) => l.sku.id === id)?.sku;
    const skuIdx = (id: number) => this.lines.findIndex((l) => l.sku.id === id);
    const out: (HTMLElement | null)[] = [];

    if (plan) {
      out.push(
        h(
          'div',
          { class: 'kpis' },
          h('div', { class: 'kpi big' }, h('span', { class: 'kpi-label' }, t.totalCartons), h('span', { class: 'kpi-value' }, fmt.int(plan.totalCartons)), h('span', { class: 'kpi-sub' }, t.models[plan.model])),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, plan.segmentTiers ? t.segmentCount : t.tierCount), h('span', { class: 'kpi-value' }, fmt.int(plan.tiers.length))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.utilization), h('span', { class: 'kpi-value' }, fmt.pct(plan.volumeUtilization))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.usedLength), h('span', { class: 'kpi-value' }, fmt.m(plan.usedLength))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.totalWeight), h('span', { class: 'kpi-value' }, `${fmt.int(plan.totalWeight)} kg`)),
        ),
      );
      out.push(stabilityBlock(plan, this.colorMode === 'risk'));
      const unplaced = Object.entries(plan.unplaced);
      if (unplaced.length)
        out.push(
          h(
            'div',
            { class: 'alert unplaced' },
            h('strong', {}, t.unplaced),
            ...unplaced.map(([id, n]) => h('div', {}, `${skuOf(Number(id))?.code ?? id} · ${skuOf(Number(id))?.name ?? ''}: `, h('strong', {}, fmt.int(n)), ` ${t.cartons}`)),
          ),
        );
      out.push(
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => this.print() }, t.print), h('button', { class: 'btn', type: 'button', onclick: () => this.save() }, t.savePlan)),
      );
    }

    if (tr)
      out.push(
        h(
          'dl',
          { class: 'facts' },
          h('dt', {}, t.truckInfo),
          h('dd', {}, h('strong', {}, tr.name)),
          h('dt', {}, t.innerDims),
          h('dd', {}, `${fmt.dims(tr.length, tr.width, tr.height)} cm`, tr.type?.dims_estimated ? h('span', { class: 'tag warn' }, t.estimated) : null),
          h('dt', {}, t.calcVolume),
          h('dd', {}, `${fmt.d1((tr.length * tr.width * tr.height) / 1e6)} m³`),
        ),
      );

    if (d)
      out.push(
        h(
          'dl',
          { class: 'facts' },
          h('dt', {}, t.destinationInfo),
          h('dd', {}, h('strong', {}, d.customer)),
          h('dt', {}, t.city),
          h('dd', {}, d.city),
          h('dt', {}, t.zone),
          h('dd', {}, d.zone ?? '–'),
          h('dt', {}, t.maxTruck),
          h('dd', {}, (() => {
            const m = repo.maxTruckFor(d.id);
            return m ? repo.truckLabel(m) : d.vehicle_type_raw ?? '–';
          })()),
        ),
      );

    if (plan)
      out.push(
        h(
          'div',
          { class: 'per-tier' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => ((this.showPerTier = !this.showPerTier), this.renderSummary()) }, this.showPerTier ? t.hidePerTier : t.showPerTier),
          this.showPerTier
            ? h(
                'ol',
                { class: 'tier-list' },
                ...plan.tiers.map((tier) =>
                  h(
                    'li',
                    { class: tier.index === this.upToTier ? 'on' : '' },
                    h(
                      'button',
                      { type: 'button', onclick: () => this.focusTier(tier.index) },
                      h('span', { class: 'tl-no' }, `${plan.segmentTiers ? t.segments : t.tierNo} ${tier.index}`),
                      h('span', { class: 'tl-chips' }, ...Object.entries(tier.counts).map(([id, c]) => h('span', { class: 'chip', title: skuOf(Number(id))?.name ?? '' }, h('i', { style: `background:${skuColor(skuIdx(Number(id)))}` }), `${skuOf(Number(id))?.code ?? id} ${fmt.int(c)}`))),
                      h('span', { class: 'tl-total' }, fmt.int(tier.total)),
                    ),
                  ),
                ),
              )
            : null,
        ),
      );

    this.summaryBox.replaceChildren(...(out.filter(Boolean) as HTMLElement[]));
    if (!this.summaryBox.childElementCount) this.summaryBox.append(h('p', { class: 'muted' }, t.emptyState));
  }

  private save() {
    const plan = this.selectedPlan();
    const tr = this.currentTruck();
    if (!plan || !tr) return;
    repo.saveShipmentPlan(
      this.reference || null,
      this.destination?.id ?? null,
      tr.id,
      { name: tr.name, length: tr.length, width: tr.width, height: tr.height },
      this.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
      plan,
    );
    this.say(`${t.saved} ✓`);
    this.onSaved();
  }

  private print() {
    const plan = this.selectedPlan();
    const tr = this.currentTruck();
    if (!plan || !tr) return;
    printPlan({ plan, truck: tr, destination: this.destination, reference: this.reference, skus: this.lines.map((l) => l.sku), snapshot: this.view?.snapshot() ?? null });
  }

  // ---------- Details ----------

  private renderDetails() {
    const open = this.detailsOpen;
    const head = h(
      'button',
      { class: 'details-head', type: 'button', 'aria-expanded': String(open), onclick: () => ((this.detailsOpen = !open), this.renderDetails()) },
      h('span', {}, t.details),
      h('span', { class: 'link' }, open ? t.hideDetails : t.showDetails),
    );
    if (!open) {
      this.detailsBox.replaceChildren(head);
      return;
    }
    const plan = this.selectedPlan();
    const tr = this.currentTruck();
    const d = this.destination;
    const lines = this.lines;
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
                    { class: tier.index === this.upToTier ? 'on' : '', onclick: () => this.focusTier(tier.index) },
                    h('td', {}, String(tier.index)),
                    h('td', {}, `${fmt.int(tier.depth)} cm`),
                    h('td', {}, tier.columns ? `${tier.columns} × ${tier.layers}${tier.interlocked ? ` · ${t.interlockedShort}` : ''}` : '–'),
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
            h('thead', {}, h('tr', {}, ...[t.code, t.name, t.plannedDims, t.volume, t.safeLayers, t.weight, t.requested, t.planned, t.remaining].map((x, i) => h('th', { class: i >= 3 ? 'num' : '' }, x)))),
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
                  h('td', {}, fmt.dims(...repo.plannedDims(l.sku))),
                  h('td', { class: 'num' }, fmt.d3(l.sku.volume_m3)),
                  h('td', { class: 'num' }, fmt.int(l.sku.safe_stack_layers)),
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
          h('dd', {}, tr.name),
          h('dt', {}, t.innerDims),
          h('dd', {}, `${fmt.dims(tr.length, tr.width, tr.height)} cm`, tr.type?.dims_estimated ? h('span', { class: 'tag warn' }, t.estimated) : null),
          h('dt', {}, t.estVolume),
          h('dd', {}, tr.type?.est_volume_max ? `${fmt.d1(tr.type.est_volume_max)} m³` : '–'),
          h('dt', {}, t.calcVolume),
          h('dd', {}, `${fmt.d2((tr.length * tr.width * tr.height) / 1e6)} m³`),
          h('dt', {}, t.bodyType),
          h('dd', {}, tr.type ? t.bodyTypes[tr.type.body_type] : '–'),
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
          h('dt', {}, t.zone),
          h('dd', {}, d.zone ?? '–'),
          h('dt', {}, t.vehicleRaw),
          h('dd', {}, d.vehicle_type_raw ?? '–'),
          h('dt', {}, t.maxTruck),
          h('dd', {}, (() => {
            const m = repo.maxTruckFor(d.id);
            return m ? repo.truckLabel(m) : '–';
          })()),
        )
      : h('p', { class: 'muted' }, t.destinationPlaceholder);

    const rules = repo.loadRules();
    const rulesBody = h(
      'div',
      { class: 'rules' },
      h('h4', {}, 'Semua model'),
      h('ul', {}, ...t.fixedRules.map((r) => h('li', {}, r))),
      ...MODEL_ORDER.map((m) =>
        h('div', { class: m === this.selected ? 'rule-block on' : 'rule-block' }, h('h4', {}, `${t.models[m]}${m === this.selected ? ` · ${t.chosen}` : ''}`), h('ul', {}, ...describeRules(plan?.model === m ? plan.rules : rules[m]).map((r) => h('li', {}, r)))),
      ),
    );

    this.detailsBox.replaceChildren(
      head,
      section(t.detailTiers, tierTable, true),
      section(t.detailSkus, skuTable, true),
      section(t.detailTruck, truckBody),
      section(t.detailDestination, destBody),
      section(t.detailRules, rulesBody),
    );
  }

  private renderDestCard() {
    const d = this.destination;
    if (!d) {
      this.destCard.replaceChildren();
      return;
    }
    const max = repo.maxTruckFor(d.id);
    this.destCard.replaceChildren(
      h('div', { class: 'dc-name' }, d.customer),
      h('div', { class: 'dc-meta' }, `${d.city} · ${d.zone ?? ''}`),
      h('div', { class: 'dc-meta' }, `${t.maxTruck}: `, h('strong', {}, max ? repo.truckLabel(max) : d.vehicle_type_raw ?? '–')),
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

  /** Reopens a saved plan: its inputs and the saved result for its model. */
  loadSaved(saved: SavedPlan) {
    this.cancel();
    const result = repo.planResult(saved.id);
    const truck = JSON.parse(saved.truck_json) as repo.PlanTruck;
    this.destination = saved.destination_id ? repo.listDestinations().find((d) => d.id === saved.destination_id) ?? null : null;
    if (saved.truck_type_id && this.trucks.some((x) => x.id === saved.truck_type_id)) this.truckId = saved.truck_type_id;
    else {
      this.truckId = CUSTOM;
      this.custom = { ...truck };
      this.renderCustomBox();
    }
    // The SKUs exactly as planned, so a reopened plan matches its saved result.
    this.lines = repo.shipmentLines(saved.shipment_id);
    this.reference = saved.reference ?? '';
    this.refInput.value = this.reference;
    this.destCombo.setText(this.destination ? `${this.destination.customer} – ${this.destination.city}` : '');
    this.results = result ? { [result.model]: result } : {};
    this.selected = saved.model;
    this.stale = false;
    this.upToTier = 0;
    this.picked = null;
    this.renderAll();
    this.update3d(true);
  }

  /** Fills the form with a sample shipment so first-time viewers see a plan immediately. */
  loadExample() {
    const dest = repo.searchDestinations('UNIRAMA DUTA NIAGA, PT (GD)', 1)[0] ?? repo.listDestinations()[0];
    if (dest) {
      this.destination = dest;
      this.truckId = repo.maxTruckFor(dest.id)?.id ?? null;
    }
    const skus = repo.listSkus();
    const pick = (code: string) => skus.find((s) => s.code === code);
    this.lines = (
      [
        ['DUM-001', 180],
        ['DUM-007', 120],
        ['DUM-004', 150],
        ['DUM-003', null],
      ] as [string, number | null][]
    )
      .map(([code, qty]) => ({ sku: pick(code)!, qty }))
      .filter((l) => l.sku);
    this.destCombo.setText(dest ? `${dest.customer} – ${dest.city}` : '');
    this.renderAll();
    this.update3d(true);
    this.run();
  }
}

function personalTag(s: Sku) {
  if (!s.personal) return null;
  return h('span', { class: 'tag personal', title: t.personalNote }, s.personal === 'new' ? t.personalNew : t.personalEdited);
}

function stabilityBadge(r: PlanResult) {
  const s = r.stability;
  if (!s) return null;
  return h('div', { class: `mc-risk ${s.risky ? 'bad' : 'ok'}` }, s.risky ? `⚠ ${t.stabilityRisk(s.risky)}` : `✓ ${t.stabilityOk}`);
}

function stabilityBlock(plan: PlanResult, legend: boolean) {
  const s = plan.stability;
  if (!s) return h('div', { class: 'stability' }, h('span', { class: 'kpi-label' }, t.stability), h('p', { class: 'hint' }, t.stabilityOld));
  const item = (flag: number, label: string) => h('span', { class: 'chip' }, h('i', { style: `background:${riskColor(flag)}` }), label);
  return h(
    'div',
    { class: `stability ${s.risky ? 'bad' : 'ok'}` },
    h('span', { class: 'kpi-label' }, t.stability),
    h('strong', {}, s.risky ? `⚠ ${t.stabilityRisk(s.risky)}` : `✓ ${t.stabilityOk}`),
    s.risky ? h('div', { class: 'small' }, t.stabilityParts(s.tip, s.slide, s.overhang)) : null,
    s.endFace ? h('div', { class: 'small' }, t.doorNote) : null,
    legend ? h('div', { class: 'risk-legend' }, item(1, t.riskTip), item(2, t.riskSlide), item(4, t.riskOverhang), item(0, t.riskNone)) : null,
    h('p', { class: 'hint' }, t.stabilityHint(...physicsNumbers(plan))),
  );
}

function riskText(plan: PlanResult, b: PlacedBox) {
  const s = plan.stability;
  const k = s ? s.flagged.indexOf(plan.boxes.indexOf(b)) : -1;
  if (!s || k < 0) return null;
  const f = s.flags[k];
  return h('div', { class: 'risk-text' }, `⚠ ${[f & 1 ? t.riskTip : '', f & 2 ? t.riskSlide : '', f & 4 ? t.riskOverhang : ''].filter(Boolean).join(' · ')}`);
}

function physicsNumbers(plan: PlanResult): [number, number, number, number, number] {
  const p = withDefaults(plan.model, plan.rules).physics;
  return [p.brakeG, p.accelG, p.sideG, p.bumpG, p.friction];
}
