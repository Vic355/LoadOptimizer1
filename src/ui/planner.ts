import { MODEL_ORDER, poseOf, withDefaults, type ModelId, type PlacedBox, type PlanResult, type SearchProgress, type ShipmentRequest, type ShipmentResult } from '../engine';
import type { WorkerRequest, WorkerResponse } from '../engine/worker';
import * as repo from '../db/repo';
import type { Destination, Sku, TruckType, Vehicle } from '../db/repo';
import { t } from '../i18n/id';
import { combobox } from './combobox';
import { confirmDialog, fmt, h } from './dom';
import { skuColor } from './colors';
import { TruckView, riskColor, type ColorMode } from './view3d';
import { printPlan } from './print';
import { describeRules } from './rules-text';
import { openSkuForm } from './sku-form';

interface Line {
  sku: Sku;
  qty: number | null;
}

interface Dims {
  length: number;
  width: number;
  height: number;
}

/** One truck of the shipment as entered: its type, the inner size used, and its plate number. */
interface TruckSlot {
  typeId: number | null;
  /** Inner size used for planning; starts as the type's size and may be changed (measured, ODOL). */
  dims: Dims;
  plateNo: string;
  /** Added by the calculation because the order needed another truck. */
  auto: boolean;
}

/** The truck a plan is made for: a truck type with the size used for this truck. */
export interface PlanningTruck extends repo.PlanTruck {
  id: number | null;
  type: TruckType | null;
}

const LABELS_KEY = 'tlo-3d-labels';

const typeDims = (tr: TruckType | null | undefined): Dims => ({ length: tr?.inner_length_cm ?? 0, width: tr?.inner_width_cm ?? 0, height: tr?.inner_height_cm ?? 0 });
const sameDims = (a: Dims, b: Dims) => a.length === b.length && a.width === b.width && a.height === b.height;
const hasDims = (d: Dims) => d.length > 0 && d.width > 0 && d.height > 0;
/** Temporary shipment number for drafts, until the real number is entered. */
const tempNumber = () => `TMP-${Date.now().toString(36).toUpperCase()}`;

function readLabels(): boolean {
  try {
    return localStorage.getItem(LABELS_KEY) !== 'off';
  } catch {
    return true;
  }
}

export class Planner {
  readonly el: HTMLElement;
  private shipmentNo = '';
  /** Draft number given at the first calculation while the shipment number is empty. */
  private tempNo = '';
  /** The saved shipment being edited (reopened from the history), if any. */
  private shipmentId: number | null = null;
  private note = '';
  private destination: Destination | null = null;
  private lines: Line[] = [];
  private slots: TruckSlot[] = [];
  private results: Partial<Record<ModelId, ShipmentResult>> = {};
  private progress: Partial<Record<ModelId, SearchProgress>> = {};
  private stale = false;
  private selected: ModelId = 'standard';
  private truckIdx = 0;
  private colorMode: ColorMode = 'sku';
  private upToTier = 0;
  private showPerTier = false;
  private detailsOpen = false;
  private picked: PlacedBox | null = null;
  private labels = readLabels();
  private trucks: TruckType[] = [];
  private vehicles: Vehicle[] = [];
  private view: TruckView | null = null;
  private workers: Worker[] = [];

  // Mount points that re-render independently.
  private shipmentHint = h('div', { class: 'shipment-hint' });
  private noteInput = h('input', { type: 'text', id: 'note', placeholder: t.notePlaceholder });
  private destCard = h('div', { class: 'dest-card' });
  private linesBox = h('div', { class: 'lines' });
  private trucksBox = h('div', { class: 'truck-slots' });
  private plateList = h('datalist', { id: 'plate-list' });
  private runBtn = h('button', { class: 'btn primary run', type: 'button' }, t.run);
  private message = h('p', { class: 'message', role: 'status' });
  private stageHead = h('div', { class: 'stage-head' });
  private stageTools = h('div', { class: 'stage-tools' });
  private canvasHost = h('div', { class: 'canvas-host' });
  private helper = h('div', { class: 'stage-helper' });
  private pickedBox = h('div', { class: 'picked', hidden: true });
  private summaryBox = h('div', { class: 'summary-body' });
  private detailsBox = h('section', { class: 'details panel' });
  private loading = h('div', { class: 'loading-overlay', hidden: true });
  private destCombo: ReturnType<typeof combobox<Destination>>;
  private shipmentCombo: ReturnType<typeof combobox<ShipmentPick>>;

  constructor(private onSaved: () => void) {
    // Shipment number: type a new one, or pick a saved shipment (or the example) to reopen it.
    this.shipmentCombo = combobox<ShipmentPick>({
      id: 'shipment-no',
      placeholder: t.shipmentNoPlaceholder,
      freeText: true,
      search: (q) => searchShipments(q),
      render: (p) =>
        p.kind === 'example'
          ? h('div', { class: 'opt' }, h('strong', {}, `✦ ${t.exampleShipment}`), h('div', { class: 'opt-meta' }, t.exampleShipmentHint))
          : h(
              'div',
              { class: 'opt' },
              h('strong', { class: 'mono' }, p.no),
              p.draft ? h('span', { class: 'tag' }, t.draftTag) : null,
              h('span', { class: 'muted' }, ` ${t.shipmentTrucks(p.trucks)} · ${t.models[p.model]}`),
              h('div', { class: 'opt-meta' }, [p.customer, p.city, p.plates, p.created.slice(0, 10)].filter(Boolean).join(' · ')),
            ),
      keepText: (p) => (p.kind === 'example' ? t.exampleNo : p.draft ? '' : p.no),
      onPick: (p) => (p.kind === 'example' ? this.loadExample() : this.loadShipment(p.id)),
    });
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
    this.slots = [this.newSlot(null)];
    this.reloadTrucks();
    this.runBtn.addEventListener('click', () => this.run());
    this.renderAll();
  }

  /** Called after master data changes so dropdowns and searches see the new rows. */
  reloadTrucks() {
    this.trucks = repo.listTrucks();
    this.vehicles = repo.listVehicles();
    for (const s of this.slots) if (s.typeId != null && !this.trucks.some((x) => x.id === s.typeId)) s.typeId = null;
    this.plateList.replaceChildren(...this.vehicles.map((v) => h('option', { value: v.plate_no }, this.typeOf(v.truck_type_id) ? repo.truckLabel(this.typeOf(v.truck_type_id)!) : '')));
    this.renderTrucks();
  }

  mount3d() {
    if (!TruckView.supported()) {
      this.canvasHost.replaceChildren(h('p', { class: 'no-webgl' }, t.noWebgl));
      return;
    }
    if (this.view) return;
    this.view = new TruckView(this.canvasHost);
    this.view.setLabels(this.labels);
    this.view.onPick = (box) => {
      this.picked = box;
      this.renderPicked();
    };
    this.update3d(true);
  }

  refreshTheme() {
    this.view?.refreshTheme();
  }

  private typeOf(id: number | null | undefined) {
    return id == null ? null : this.trucks.find((x) => x.id === id) ?? null;
  }

  private newSlot(typeId: number | null): TruckSlot {
    return { typeId, dims: typeDims(this.typeOf(typeId)), plateNo: '', auto: false };
  }

  // ---------- Input panel ----------

  private inputPanel(): HTMLElement {
    this.shipmentCombo.input.addEventListener('input', () => {
      this.shipmentNo = this.shipmentCombo.input.value.trim();
      this.renderShipmentHint();
      this.renderHelper();
    });
    this.noteInput.addEventListener('input', () => (this.note = this.noteInput.value.trim()));

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

    return h(
      'section',
      { class: 'input panel' },
      h('h2', {}, t.inputTitle),
      h('label', { for: 'dest-search' }, t.destination),
      this.destCombo.el,
      this.destCard,
      h(
        'div',
        { class: 'label-row' },
        h('label', { for: 'sku-search' }, t.productsTitle),
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
      h('div', { class: 'label-row' }, h('span', { class: 'label' }, t.trucksTitle)),
      h('p', { class: 'hint' }, t.trucksHint),
      this.trucksBox,
      this.plateList,
      h('label', { for: 'note' }, t.noteLabel),
      this.noteInput,
      this.runBtn,
      this.message,
      ai,
    );
  }

  private renderShipmentHint() {
    if (this.shipmentNo) {
      this.shipmentHint.replaceChildren();
      return;
    }
    this.shipmentHint.replaceChildren(
      h('div', { class: 'mini-helper' }, h('strong', {}, `ⓘ ${t.shipmentEmpty}`), h('span', {}, this.tempNo ? `${t.draftNo(this.tempNo)}. ${t.shipmentDraftHint}` : t.shipmentEmptyHint)),
    );
  }

  /** Truck cards: plate number, type and inner size of each truck in the shipment. */
  private renderTrucks() {
    const max = this.destination ? repo.maxTruckFor(this.destination.id) : null;
    const result = this.selectedResult();
    const option = (tr: TruckType, selected: boolean) => {
      const vol = tr.est_volume_max ? ` · ${fmt.d1(tr.est_volume_max)} m³` : '';
      return h('option', { value: tr.id, selected }, `${repo.truckLabel(tr)}${tr.is_template ? '' : vol}${max?.id === tr.id ? ` ✓ ${t.listedForDest}` : ''}`);
    };
    const cards = this.slots.map((slot, i) => {
      const type = this.typeOf(slot.typeId);
      const plan = result?.trucks[i];
      const unused = !!result && !this.stale && !plan;
      const plate = h('input', { type: 'text', list: 'plate-list', value: slot.plateNo, placeholder: t.platePlaceholder, autocomplete: 'off', 'aria-label': `${t.plateNo} ${t.truckN(i + 1)}` });
      plate.addEventListener('change', () => this.setPlate(i, plate.value));
      const standard = this.trucks.filter((x) => !x.is_template);
      const templates = this.trucks.filter((x) => x.is_template);
      const select = h(
        'select',
        { 'aria-label': `${t.truckType} ${t.truckN(i + 1)}` },
        h('option', { value: '' }, t.noType),
        ...standard.map((tr) => option(tr, tr.id === slot.typeId)),
        ...(templates.length ? [h('optgroup', { label: t.isTemplate }, ...templates.map((tr) => option(tr, tr.id === slot.typeId)))] : []),
      );
      select.addEventListener('change', () => {
        slot.typeId = Number(select.value) || null;
        slot.auto = false;
        const d = typeDims(this.typeOf(slot.typeId));
        if (hasDims(d) || slot.typeId != null) slot.dims = d;
        this.truckChanged();
      });
      const dim = (key: keyof Dims, label: string) => {
        const input = h('input', { type: 'number', min: 1, step: 'any', inputmode: 'decimal', value: slot.dims[key] || '', 'aria-label': `${label} ${t.truckN(i + 1)}` });
        input.addEventListener('change', () => {
          slot.dims = { ...slot.dims, [key]: Number(input.value.replace(',', '.')) || 0 };
          slot.auto = false;
          this.truckChanged();
        });
        return h('label', {}, label, input);
      };
      const edited = !!type && hasDims(typeDims(type)) && !sameDims(slot.dims, typeDims(type));
      const known = slot.plateNo ? this.vehicles.find((v) => v.plate_no === slot.plateNo) : null;
      const notes: (HTMLElement | null)[] = [];
      // A hint is always shown under the plate, so typing a plate does not move the run button under the pointer.
      const kt = this.typeOf(known?.truck_type_id);
      notes.push(
        h('p', { class: 'hint' }, known ? t.plateKnown(kt ? repo.truckLabel(kt) : t.noTypeShort, fmt.dims(known.inner_length_cm, known.inner_width_cm, known.inner_height_cm)) : slot.plateNo ? t.plateNew : t.plateEmpty),
      );
      if (!hasDims(slot.dims)) notes.push(h('p', { class: 'hint warn' }, type ? t.truckNoDims : t.truckDefaultHint));
      if (max && type && repo.truckSize(type) > repo.truckSize(max)) notes.push(h('p', { class: 'hint warn' }, `⚠ ${t.overMax} (${repo.truckLabel(max)}).`));
      return h(
        'div',
        { class: `truck-card${unused ? ' unused' : ''}${i === this.truckIdx && plan ? ' on' : ''}` },
        h(
          'div',
          { class: 'tc-head' },
          h('strong', {}, t.truckN(i + 1)),
          slot.auto ? h('span', { class: 'tag' }, t.autoTruck) : null,
          plan ? h('span', { class: 'muted small' }, `${fmt.int(plan.totalCartons)} ${t.cartons}`) : unused ? h('span', { class: 'muted small' }, t.truckUnused) : null,
          h('span', { class: 'spacer' }),
          i > 0 ? h('button', { class: 'icon', type: 'button', title: t.removeTruck, 'aria-label': `${t.removeTruck} ${i + 1}`, onclick: () => this.removeSlot(i) }, '×') : null,
        ),
        h('label', {}, t.plateNo, plate),
        h('label', {}, t.truckType, select),
        h('div', { class: 'dims-head' }, h('span', {}, t.innerSize), edited ? h('button', { class: 'link-btn', type: 'button', onclick: () => ((slot.dims = typeDims(type)), this.truckChanged()) }, t.sizeReset) : null),
        h('div', { class: 'dims-grid' }, dim('length', t.lengthShort), dim('width', t.widthShort), dim('height', t.heightShort)),
        edited ? h('p', { class: 'hint' }, h('span', { class: 'tag warn' }, t.sizeEdited), ` ${t.sizeEditedHint}`) : null,
        ...notes,
      );
    });
    this.trucksBox.replaceChildren(
      ...cards,
      h('button', { class: 'btn ghost small add-truck', type: 'button', onclick: () => this.addSlot() }, t.addTruck),
    );
  }

  /** A known plate number brings its truck type and last size. */
  private setPlate(i: number, raw: string) {
    const slot = this.slots[i];
    slot.plateNo = repo.normalizePlate(raw);
    if (slot.plateNo) slot.auto = false;
    const v = slot.plateNo ? this.vehicles.find((x) => x.plate_no === slot.plateNo) : null;
    if (v) {
      if (v.truck_type_id != null && this.typeOf(v.truck_type_id)) slot.typeId = v.truck_type_id;
      const d = { length: v.inner_length_cm ?? 0, width: v.inner_width_cm ?? 0, height: v.inner_height_cm ?? 0 };
      slot.dims = hasDims(d) ? d : typeDims(this.typeOf(slot.typeId));
      this.truckChanged();
    } else this.renderTrucks();
  }

  private addSlot() {
    const last = this.slots[this.slots.length - 1];
    this.slots.push({ ...this.newSlot(last?.typeId ?? null), dims: last ? { ...last.dims } : { length: 0, width: 0, height: 0 } });
    this.truckChanged();
  }

  private removeSlot(i: number) {
    this.slots.splice(i, 1);
    this.truckIdx = Math.min(this.truckIdx, this.slots.length - 1);
    this.truckChanged();
  }

  private truckChanged() {
    this.markStale();
    this.renderTrucks();
    this.update3d(true);
    this.renderSummary();
    this.renderDetails();
  }

  private setDestination(d: Destination) {
    this.destination = d;
    const max = repo.maxTruckFor(d.id);
    // Trucks not tied to a plate number or a typed size follow the destination's maximum truck.
    if (max) for (const s of this.slots) if (!s.plateNo && (s.typeId == null || sameDims(s.dims, typeDims(this.typeOf(s.typeId))))) Object.assign(s, { typeId: max.id, dims: typeDims(max) });
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
    this.renderHelper();
  }

  /** After a SKU is edited, every line using it plans with the new size. */
  private replaceSku(oldId: number, next: Sku) {
    for (const l of this.lines) if (l.sku.id === oldId) l.sku = next;
    this.markStale();
    this.renderLines();
  }

  private pasteDialog() {
    const area = h('textarea', { rows: 8, placeholder: '69921603\t180\n69920671\t' });
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
          if (!/^(no|kode|sap|material|sku)/i.test(code)) missing.push(code);
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
    this.renderStageHead();
    this.renderHelper();
  }

  /** The truck used for slot i: its type with the size entered for it. */
  private slotTruck(i: number): PlanningTruck | null {
    const slot = this.slots[i];
    if (!slot || !hasDims(slot.dims)) return null;
    const type = this.typeOf(slot.typeId);
    return { id: type?.id ?? null, type, name: type ? repo.truckLabel(type) : t.customTruckLabel, ...slot.dims };
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
    this.renderHelper();
  }

  // ---------- Optimisation ----------

  private run() {
    if (!this.lines.length) return this.say(t.needLines);
    // Trucks the last calculation added (and nobody changed) are worked out again.
    this.slots = this.slots.filter((s, i) => i === 0 || !s.auto);
    const trucks: PlanningTruck[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const tr = this.slotTruck(i);
      if (!tr) return this.say(t.needTruckN(i + 1));
      trucks.push(tr);
    }
    this.say('');
    if (!this.shipmentNo && !this.tempNo) this.tempNo = tempNumber();
    const rules = repo.loadRules();
    const base = {
      trucks: trucks.map((tr) => ({ length: tr.length, width: tr.width, height: tr.height })),
      lines: this.lines.map((l) => ({ sku: repo.toEngineSku(l.sku), qty: l.qty })),
    };
    this.cancel();
    this.results = {};
    this.progress = {};
    this.stale = false;
    this.upToTier = 0;
    this.truckIdx = 0;
    this.picked = null;
    this.runBtn.disabled = true;
    this.runBtn.textContent = t.running;
    this.renderShipmentHint();
    this.renderStageHead();
    this.renderTrucks();
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
          this.renderStageHead();
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
      const req: ShipmentRequest = { ...base, rules: rules[model] };
      worker.postMessage({ model, req } satisfies WorkerRequest);
    }
  }

  private finishRun() {
    this.workers = [];
    this.runBtn.disabled = false;
    this.runBtn.textContent = t.run;
    this.loading.hidden = true;
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
    this.loading.hidden = false;
    this.loading.replaceChildren(
      h(
        'section',
        { class: 'loading-card', role: 'dialog', 'aria-label': t.loadingTitle },
        h('h3', {}, t.loadingTitle),
        h('p', { class: 'muted' }, t.loadingSub(this.shipmentNo || this.tempNo, this.lines.length)),
        ...MODEL_ORDER.map((m) => {
          const r = this.results[m];
          const p = this.progress[m];
          const pct = r ? 100 : Math.round((p?.fraction ?? 0) * 100);
          return h(
            'div',
            { class: 'lp-row' },
            h('div', { class: 'lp-head' }, h('strong', {}, t.models[m]), h('span', { class: 'mono' }, r ? t.loadingDone(r.totalCartons, r.trucks.length) : `${t.truckN((p?.truck ?? 0) + 1)} · ${pct}%`)),
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

  private selectedResult(): ShipmentResult | null {
    return this.stale ? null : this.results[this.selected] ?? null;
  }

  private selectedPlan(): PlanResult | null {
    return this.selectedResult()?.trucks[this.truckIdx] ?? null;
  }

  private selectModel(m: ModelId) {
    this.selected = m;
    this.upToTier = 0;
    this.picked = null;
    this.showSelected();
  }

  private selectTruck(i: number) {
    this.truckIdx = i;
    this.upToTier = 0;
    this.picked = null;
    this.update3d(true);
    this.showSelected();
  }

  /** Adds truck cards for the trucks the chosen model needed beyond the ones entered. */
  private extendSlots() {
    const n = this.selectedResult()?.trucks.length ?? 0;
    while (this.slots.length < n) {
      const last = this.slots[this.slots.length - 1];
      this.slots.push({ typeId: last.typeId, dims: { ...last.dims }, plateNo: '', auto: true });
    }
    this.truckIdx = Math.max(0, Math.min(this.truckIdx, n - 1));
  }

  private showSelected() {
    this.extendSlots();
    this.update3d(true);
    this.renderStageHead();
    this.renderStageTools();
    this.renderTrucks();
    this.renderPicked();
    this.renderSummary();
    this.renderDetails();
    this.renderHelper();
  }

  // ---------- Stage: model selector, truck tabs, 3D ----------

  private stagePanel(): HTMLElement {
    return h(
      'section',
      { class: 'stage panel' },
      h('div', { class: 'shipment-bar' }, h('label', { for: 'shipment-no' }, t.shipmentNo), this.shipmentCombo.el, this.shipmentHint),
      this.stageHead,
      h('div', { class: 'canvas-wrap' }, this.canvasHost, this.helper, this.pickedBox),
      this.stageTools,
      h('p', { class: 'hint' }, t.viewHint),
    );
  }

  /** The model selector (with each model's trucks and cartons) and one tab per truck. */
  private renderStageHead() {
    const running = this.workers.length > 0;
    const select = h(
      'select',
      { id: 'model-select', 'aria-label': t.modelLabel },
      ...MODEL_ORDER.map((m) => {
        const r = this.results[m];
        const text = r && !this.stale ? t.modelOption(t.models[m], r.trucks.length, fmt.int(r.totalCartons)) : running && !r ? t.modelRunning(t.models[m]) : t.models[m];
        return h('option', { value: m, selected: m === this.selected }, text);
      }),
    );
    select.addEventListener('change', () => this.selectModel(select.value as ModelId));
    const result = this.selectedResult();
    const tabs = result
      ? h(
          'div',
          { class: 'truck-tabs', role: 'tablist', 'aria-label': t.trucksTitle },
          ...result.trucks.map((p, i) =>
            h(
              'button',
              { type: 'button', role: 'tab', class: i === this.truckIdx ? 'on' : '', 'aria-selected': String(i === this.truckIdx), onclick: () => this.selectTruck(i) },
              h('strong', {}, t.truckN(i + 1)),
              this.slots[i]?.plateNo ? h('span', { class: 'mono' }, this.slots[i].plateNo) : null,
              h('span', { class: 'muted' }, `${fmt.int(p.totalCartons)} ${t.cartonsShort}`),
              p.stability?.risky ? h('span', { class: 'tab-warn', title: t.stabilityRisk(p.stability.risky) }, '⚠') : null,
            ),
          ),
        )
      : null;
    this.stageHead.replaceChildren(
      ...[
        h('div', { class: 'model-pick' }, h('label', { for: 'model-select' }, t.modelLabel), select, h('span', { class: 'hint' }, t.modelTagline[this.selected])),
        this.stale ? h('p', { class: 'stale-note' }, t.staleNote) : null,
        tabs,
      ].filter((x) => x != null) as HTMLElement[],
    );
  }

  /** Mini helper on the empty 3D view: what is still missing before a plan can be calculated. */
  private renderHelper() {
    if (this.selectedPlan()) {
      this.helper.hidden = true;
      return;
    }
    const steps: [string, boolean][] = [
      [t.helperSteps[0], !!this.shipmentNo],
      [t.helperSteps[1], !!this.destination],
      [t.helperSteps[2], this.lines.length > 0],
      [t.helperSteps[3], this.slots.every((s) => hasDims(s.dims))],
      [t.helperSteps[4], false],
    ];
    this.helper.hidden = false;
    this.helper.replaceChildren(
      // Kept small (the shipment field above already explains an empty number), so the empty truck stays visible.
      h('strong', {}, this.shipmentNo ? t.helperReady(this.shipmentNo) : t.helperTitle),
      h('ol', {}, ...steps.map(([label, done]) => h('li', { class: done ? 'done' : '' }, done ? '✓ ' : '', label))),
    );
  }

  private renderStageTools() {
    const plan = this.selectedPlan();
    const labels = h(
      'button',
      { class: `btn ghost small${this.labels ? ' on' : ''}`, type: 'button', 'aria-pressed': String(this.labels), onclick: () => this.toggleLabels() },
      this.labels ? `☑ ${t.showLabels}` : `☐ ${t.showLabels}`,
    );
    if (!plan) {
      this.stageTools.replaceChildren(labels, h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.view?.frameCamera() }, t.resetView));
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
    const word = plan.segmentTiers ? t.segments : t.tierNo;
    this.stageTools.replaceChildren(
      mode,
      h(
        'div',
        { class: 'stepper' },
        h('button', { class: 'icon', type: 'button', 'aria-label': t.prevTier, title: t.prevTier, disabled: current <= 1, onclick: () => set(current - 1) }, '‹'),
        h('span', { class: 'mono step-label' }, this.upToTier ? t.upTo(word, this.upToTier, n) : t.allTiers(word, n)),
        h('button', { class: 'icon', type: 'button', 'aria-label': t.nextTier, title: t.nextTier, disabled: !this.upToTier, onclick: () => set(current + 1) }, '›'),
      ),
      h('button', { class: 'btn small', type: 'button', onclick: () => set(1) }, t.stepThrough),
      h('button', { class: 'btn small', type: 'button', disabled: !this.upToTier, onclick: () => set(n) }, t.all),
      labels,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.view?.frameCamera() }, t.resetView),
    );
  }

  private toggleLabels() {
    this.labels = !this.labels;
    try {
      localStorage.setItem(LABELS_KEY, this.labels ? 'on' : 'off');
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
    this.view?.setLabels(this.labels);
    this.renderStageTools();
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
    const pose = line ? poseOf(b, repo.plannedDims(line.sku)) : null;
    this.pickedBox.hidden = false;
    this.pickedBox.replaceChildren(
      h('strong', {}, t.picked),
      h('div', {}, line ? `${line.sku.code} · ${line.sku.name}` : String(b.skuId)),
      h('div', { class: 'muted' }, t.pickedWhere(b.tier, below + 1, plan.segmentTiers)),
      h('div', { class: 'muted mono' }, `${fmt.dims(b.dx, b.dy, b.dz)} cm`),
      ...[pose ? h('div', {}, `${t.pose} ${pose}: ${t.poses[pose]}`) : null, riskText(plan, b)].filter((x): x is HTMLDivElement => !!x),
    );
  }

  private update3d(truckChanged: boolean) {
    if (!this.view) return;
    const tr = this.slotTruck(this.truckIdx);
    // With no truck chosen yet, an empty truck of a common size stands in, without size labels.
    const stand = tr ? null : this.placeholderTruck();
    if (truckChanged) this.view.setTruck(tr ? { length: tr.length, width: tr.width, height: tr.height } : stand, true, !!tr);
    this.view.setPlan(this.selectedPlan(), this.colorMode, this.lines.map((l) => l.sku.id), this.upToTier, this.upToTier);
  }

  private placeholderTruck() {
    const type = this.trucks.find((x) => !x.is_template && /engkel/i.test(x.name) && hasDims(typeDims(x))) ?? this.trucks.find((x) => hasDims(typeDims(x)));
    const d = type ? typeDims(type) : { length: 420, width: 200, height: 200 };
    return { length: d.length, width: d.width, height: d.height };
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
    const tr = this.slotTruck(this.truckIdx);
    const d = this.destination;
    const result = this.selectedResult();
    const plan = this.selectedPlan();
    const skuOf = (id: number) => this.lines.find((l) => l.sku.id === id)?.sku;
    const skuIdx = (id: number) => this.lines.findIndex((l) => l.sku.id === id);
    const out: (HTMLElement | null)[] = [];

    if (result) {
      const unplaced = Object.entries(result.unplaced);
      out.push(
        h(
          'div',
          { class: 'shipment-kpis' },
          h('div', { class: 'kpi big' }, h('span', { class: 'kpi-label' }, `${t.shipmentNo} ${this.shipmentNo || this.tempNo}`), h('span', { class: 'kpi-value' }, fmt.int(result.totalCartons)), h('span', { class: 'kpi-sub' }, `${t.cartons} · ${t.models[result.model]}`)),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.trucksUsed), h('span', { class: 'kpi-value' }, fmt.int(result.trucks.length))),
        ),
        unplaced.length
          ? h(
              'div',
              { class: 'alert unplaced' },
              h('strong', {}, t.shipmentUnplaced),
              ...unplaced.map(([id, n]) => h('div', {}, `${skuOf(Number(id))?.code ?? id} · ${skuOf(Number(id))?.name ?? ''}: `, h('strong', {}, fmt.int(n)), ` ${t.cartons}`)),
            )
          : null,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => this.print() }, t.printShipment(result.trucks.length)),
          h('button', { class: 'btn', type: 'button', onclick: () => void this.save() }, t.savePlan),
        ),
      );
    }

    if (plan) {
      out.push(
        h('h3', { class: 'summary-sub' }, t.thisTruck(this.truckIdx + 1, result!.trucks.length), this.slots[this.truckIdx]?.plateNo ? h('span', { class: 'mono' }, ` · ${this.slots[this.truckIdx].plateNo}`) : null),
        h(
          'div',
          { class: 'kpis' },
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.totalCartons), h('span', { class: 'kpi-value' }, fmt.int(plan.totalCartons))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, plan.segmentTiers ? t.segmentCount : t.tierCount), h('span', { class: 'kpi-value' }, fmt.int(plan.tiers.length))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.utilization), h('span', { class: 'kpi-value' }, fmt.pct(plan.volumeUtilization))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.usedLength), h('span', { class: 'kpi-value' }, fmt.m(plan.usedLength))),
        ),
      );
      out.push(stabilityBlock(plan, this.colorMode === 'risk'));
    }

    if (tr)
      out.push(
        h(
          'dl',
          { class: 'facts' },
          h('dt', {}, t.truckInfo),
          h('dd', {}, h('strong', {}, tr.name)),
          h('dt', {}, t.plateNo),
          h('dd', {}, this.slots[this.truckIdx]?.plateNo || '–'),
          h('dt', {}, t.innerDims),
          h('dd', {}, `${fmt.dims(tr.length, tr.width, tr.height)} cm`, tr.type?.dims_estimated && sameDims(tr, typeDims(tr.type)) ? h('span', { class: 'tag warn' }, t.estimated) : null),
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

  /** The trucks of the chosen result with the truck and plate number each was planned for. */
  private plannedTrucks() {
    const result = this.selectedResult();
    if (!result) return [];
    return result.trucks.map((plan, i) => ({ plan, truck: this.slotTruck(i)!, plateNo: this.slots[i]?.plateNo || null, seq: i + 1 }));
  }

  /** Saving needs a shipment number (or a draft number) and asks before saving trucks without a plate number. */
  private async save() {
    const result = this.selectedResult();
    if (!result) return;
    let no = this.shipmentNo;
    let isTemp = false;
    if (!no) {
      const answer = await askShipmentNo(this.tempNo || tempNumber());
      if (!answer) return;
      if (answer.draft) {
        no = this.tempNo = answer.no;
        isTemp = true;
      } else {
        no = this.shipmentNo = answer.no;
        this.shipmentCombo.setText(no);
        this.renderShipmentHint();
      }
    }
    const trucks = this.plannedTrucks();
    const missing = trucks.filter((x) => !x.plateNo).map((x) => t.truckN(x.seq));
    if (missing.length && !(await confirmDialog(t.saveNoPlate(missing.join(', ')), t.saveAnyway, t.cancel, false))) return;
    const existing = repo.shipmentByNo(no);
    if (existing && existing.id !== this.shipmentId && !(await confirmDialog(t.replaceShipment(no), t.replace, t.cancel))) return;
    this.shipmentId = await repo.saveShipment({
      shipmentId: this.shipmentId,
      shipmentNo: no,
      isTemp,
      destinationId: this.destination?.id ?? null,
      note: this.note || null,
      lines: this.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
      trucks: trucks.map((x) => ({ truckTypeId: x.truck.id, plateNo: x.plateNo, truck: { name: x.truck.name, length: x.truck.length, width: x.truck.width, height: x.truck.height }, plan: x.plan })),
    });
    this.reloadTrucks();
    this.renderHelper();
    this.say(`${isTemp ? t.savedDraft(no) : t.savedShipment(no, trucks.length)} ✓`);
    this.onSaved();
  }

  private print() {
    const trucks = this.plannedTrucks();
    if (!trucks.length) return;
    printPlan({
      trucks,
      shipmentNo: this.shipmentNo || this.tempNo,
      draft: !this.shipmentNo,
      destination: this.destination,
      note: this.note,
      skus: this.lines.map((l) => l.sku),
      snapshot: this.view ? { seq: this.truckIdx + 1, url: this.view.snapshot() } : null,
    });
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
    const result = this.selectedResult();
    const plan = this.selectedPlan();
    const tr = this.slotTruck(this.truckIdx);
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

    // Per SKU: ordered, planned on each truck, and left over.
    const truckCount = result?.trucks.length ?? 0;
    const skuTable = lines.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ...[t.code, t.name, t.plannedDims, t.volume, t.safeLayers, t.requested].map((x, i) => h('th', { class: i >= 3 ? 'num' : '' }, x)),
                ...Array.from({ length: truckCount }, (_, i) => h('th', { class: 'num' }, t.truckN(i + 1))),
                h('th', { class: 'num' }, t.remaining),
              ),
            ),
            h(
              'tbody',
              {},
              ...lines.map((l, i) => {
                const per = (result?.trucks ?? []).map((p) => p.loaded[l.sku.id] ?? 0);
                const loaded = per.reduce((a, b) => a + b, 0);
                const rest = l.qty != null ? Math.max(0, l.qty - loaded) : null;
                return h(
                  'tr',
                  {},
                  h('td', {}, h('span', { class: 'chip' }, h('i', { style: `background:${skuColor(i)}` }), l.sku.code)),
                  h('td', {}, l.sku.name),
                  h('td', {}, fmt.dims(...repo.plannedDims(l.sku))),
                  h('td', { class: 'num' }, fmt.d3(l.sku.volume_m3)),
                  h('td', { class: 'num' }, fmt.int(l.sku.safe_stack_layers)),
                  h('td', { class: 'num' }, l.qty != null ? fmt.int(l.qty) : t.qtyMax),
                  ...per.map((n) => h('td', { class: 'num' }, fmt.int(n))),
                  h('td', { class: `num${rest ? ' bad' : ''}` }, result && rest != null ? fmt.int(rest) : '–'),
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
          h('dt', {}, t.plateNo),
          h('dd', {}, this.slots[this.truckIdx]?.plateNo || '–'),
          h('dt', {}, t.innerDims),
          h('dd', {}, `${fmt.dims(tr.length, tr.width, tr.height)} cm`, tr.type?.dims_estimated && sameDims(tr, typeDims(tr.type)) ? h('span', { class: 'tag warn' }, t.estimated) : null),
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
    this.renderShipmentHint();
    this.renderDestCard();
    this.renderTrucks();
    this.renderLines();
    this.renderStageHead();
    this.renderStageTools();
    this.renderSummary();
    this.renderDetails();
    this.renderHelper();
  }

  /**
   * A made-up shipment to try the app: three real SAP SKUs that need two CDD trucks, so the
   * multi-truck tabs, plate numbers and carton positions all show. Nothing is saved until the user saves it.
   */
  loadExample() {
    this.cancel();
    const dest = repo.searchDestinations('UNIRAMA', 1)[0] ?? repo.listDestinations()[0] ?? null;
    this.destination = dest;
    this.destCombo.setText(dest ? `${dest.customer} – ${dest.city}` : '');
    this.shipmentId = null;
    this.shipmentNo = t.exampleNo;
    this.tempNo = '';
    this.shipmentCombo.setText(this.shipmentNo);
    this.note = '';
    this.noteInput.value = '';
    const sku = (code: string) => repo.skuByCode(code);
    this.lines = (
      [
        ['69921603', 300], // Paseo Baby Puresoft Softpack, small carton
        ['69920852', 200], // Paseo Elegant Facial Travelpack
        ['69921667', 120], // Nice Softpack 320 helai, large carton
      ] as const
    )
      .map(([code, qty]) => ({ sku: sku(code)!, qty }))
      .filter((l) => l.sku);
    const cdd = this.trucks.find((x) => !x.is_template && /CDD/i.test(x.name) && /maks/i.test(x.variant ?? '')) ?? this.trucks.find((x) => hasDims(typeDims(x))) ?? null;
    this.slots = [{ ...this.newSlot(cdd?.id ?? null), plateNo: 'B 9514 KXT' }];
    this.results = {};
    this.stale = false;
    this.truckIdx = 0;
    this.renderAll();
    this.update3d(true);
    this.run();
  }

  /** Reopens a saved shipment: its order lines, every truck with its plate number, and the saved plans. */
  loadShipment(shipmentId: number, truckSeq = 1) {
    const plans = repo.shipmentPlans(shipmentId);
    if (!plans.length) return;
    this.cancel();
    const first = plans[0];
    this.shipmentId = shipmentId;
    this.shipmentNo = first.is_temp ? '' : first.shipment_no ?? '';
    this.tempNo = first.is_temp ? first.shipment_no ?? '' : '';
    this.shipmentCombo.setText(this.shipmentNo);
    this.note = first.reference ?? '';
    this.noteInput.value = this.note;
    this.destination = first.destination_id ? repo.listDestinations().find((d) => d.id === first.destination_id) ?? null : null;
    this.destCombo.setText(this.destination ? `${this.destination.customer} – ${this.destination.city}` : '');
    // The SKUs exactly as planned, so a reopened plan matches its saved result.
    this.lines = repo.shipmentLines(shipmentId);
    this.slots = plans.map((p) => {
      const truck = JSON.parse(p.truck_json) as repo.PlanTruck;
      const typeId = p.truck_type_id && this.typeOf(p.truck_type_id) ? p.truck_type_id : null;
      return { typeId, dims: { length: truck.length, width: truck.width, height: truck.height }, plateNo: p.plate_no ?? '', auto: false };
    });
    const results = plans.map((p) => repo.planResult(p.id)).filter((r): r is PlanResult => !!r);
    const unplaced: Record<number, number> = {};
    for (const l of this.lines) {
      const loaded = results.reduce((s, r) => s + (r.loaded[l.sku.id] ?? 0), 0);
      if (l.qty != null && l.qty > loaded) unplaced[l.sku.id] = l.qty - loaded;
    }
    this.selected = first.model;
    this.results =
      results.length === plans.length
        ? { [first.model]: { model: first.model, trucks: results, unplaced, totalCartons: results.reduce((s, r) => s + r.totalCartons, 0), plansEvaluated: 0, elapsedMs: 0 } }
        : {};
    this.stale = false;
    this.truckIdx = Math.max(0, Math.min(plans.length - 1, truckSeq - 1));
    this.upToTier = 0;
    this.picked = null;
    this.say('');
    this.renderAll();
    this.update3d(true);
  }
}

/** Asks for the shipment number before saving; or saves the plan as a draft under its temporary number. */
function askShipmentNo(tempNo: string): Promise<{ no: string; draft: boolean } | null> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'form-dialog narrow' });
    const input = h('input', { type: 'text', placeholder: t.shipmentNoExample, 'aria-label': t.shipmentNo });
    const error = h('p', { class: 'alert', hidden: true });
    let answer: { no: string; draft: boolean } | null = null;
    const done = (a: { no: string; draft: boolean } | null) => {
      answer = a;
      dialog.close();
    };
    const submit = () => {
      const no = input.value.trim();
      if (!no) {
        error.textContent = t.required(t.shipmentNo);
        error.hidden = false;
        return;
      }
      done({ no, draft: false });
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), submit()));
    dialog.append(
      h('h3', {}, t.saveNeedsNo),
      h('p', { class: 'hint' }, t.saveNeedsNoHint),
      h('label', { class: 'stack' }, t.shipmentNo, input),
      error,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, t.cancel),
        h('button', { class: 'btn', type: 'button', onclick: () => done({ no: tempNo, draft: true }) }, t.saveAsDraft(tempNo)),
        h('button', { class: 'btn primary', type: 'button', onclick: submit }, t.save),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

function personalTag(s: Sku) {
  if (!s.personal) return null;
  return h('span', { class: 'tag personal', title: t.personalNote }, s.personal === 'new' ? t.personalNew : t.personalEdited);
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

type ShipmentPick =
  | { kind: 'example' }
  | { kind: 'saved'; id: number; no: string; draft: boolean; trucks: number; model: ModelId; customer: string | null; city: string | null; plates: string; created: string };

/** Saved shipments matching the typed text (number, customer, city or plate), newest first, then the example plan. */
function searchShipments(text: string): ShipmentPick[] {
  const q = text.trim().toLowerCase();
  const byId = new Map<number, Extract<ShipmentPick, { kind: 'saved' }>>();
  for (const p of repo.listSavedPlans()) {
    const row = byId.get(p.shipment_id);
    if (row) {
      if (p.plate_no) row.plates = row.plates ? `${row.plates}, ${p.plate_no}` : p.plate_no;
      continue;
    }
    byId.set(p.shipment_id, {
      kind: 'saved',
      id: p.shipment_id,
      no: p.shipment_no ?? '',
      draft: !!p.is_temp,
      trucks: p.truck_count,
      model: p.model,
      customer: p.customer,
      city: p.city,
      plates: p.plate_no ?? '',
      created: p.created_at,
    });
  }
  const saved = [...byId.values()].filter((p) => !q || [p.no, p.customer, p.city, p.plates].some((x) => x?.toLowerCase().includes(q)));
  const example: ShipmentPick[] = !q || t.exampleShipment.toLowerCase().includes(q) || t.exampleNo.toLowerCase().includes(q) ? [{ kind: 'example' }] : [];
  return [...saved.slice(0, 8), ...example];
}
