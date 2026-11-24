import { MODEL_ORDER, canMoveTiers, gridCapacity, moveTier, poseOf, withDefaults, type ModelId, type PlacedBox, type PlanResult, type SearchProgress, type ShipmentRequest, type ShipmentResult } from '../engine';
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
  /** Cartons asked for; null fills the space left (maks). For a percent line it is worked out from `pct`. */
  qty: number | null;
  /** Set when the amount is entered as a percentage of the load (the cartons that fit) instead of cartons. */
  pct?: number | null;
  /** The row shows the percent field (kept while the field is still empty). */
  pctMode?: boolean;
  /**
   * Order quantity the percentage is taken from. Empty: the percentage is a share of what fits on the
   * trucks entered and never spills. Filled: that many cartons are sent, on more trucks if needed.
   */
  orderQty?: number | null;
}

/** A percent line without an order quantity: a share of what fits, kept to the trucks entered. */
const isShare = (l: Line) => !!l.pctMode && l.pct != null && !l.orderQty;

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
const TIER_COUNTS_KEY = 'tlo-3d-tier-counts';
const BIG_VIEW_KEY = 'tlo-3d-big';
const GROUP_KEY = 'tlo-group-sku';
const TARGET_KEY = 'tlo-truck-target';
/** Steps kept for Urungkan (Ctrl+Z). */
const UNDO_LIMIT = 60;

/** Truck target for the search: none, the fewest possible, or a number of trucks. */
type TruckTarget = '' | 'min' | number;

/** Everything Urungkan (Ctrl+Z) puts back: the input and the results on screen. */
interface Snapshot {
  shipmentNo: string;
  tempNo: string;
  shipmentId: number | null;
  note: string;
  destination: Destination | null;
  zone: string | null;
  lines: Line[];
  slots: TruckSlot[];
  results: Partial<Record<ModelId, ShipmentResult>>;
  selected: ModelId;
  truckIdx: number;
  stale: boolean;
}

const typeDims = (tr: TruckType | null | undefined): Dims => ({ length: tr?.inner_length_cm ?? 0, width: tr?.inner_width_cm ?? 0, height: tr?.inner_height_cm ?? 0 });
const sameDims = (a: Dims, b: Dims) => a.length === b.length && a.width === b.width && a.height === b.height;
const hasDims = (d: Dims) => d.length > 0 && d.width > 0 && d.height > 0;
/** Temporary shipment number for drafts, until the real number is entered. */
const tempNumber = () => `TMP-${Date.now().toString(36).toUpperCase()}`;

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
}

const readLabels = () => readStore(LABELS_KEY) !== 'off';

function readTarget(): TruckTarget {
  const v = readStore(TARGET_KEY);
  if (v === 'min') return 'min';
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : '';
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
  private showPerTier = true;
  private detailsOpen = false;
  private picked: PlacedBox | null = null;
  private labels = readLabels();
  private tierCounts = readStore(TIER_COUNTS_KEY) !== 'off';
  /** Group cartons by SKU in all three models (packers load one SKU after another). */
  private groupBySku = readStore(GROUP_KEY) !== 'off';
  private truckTarget: TruckTarget = readTarget();
  private zone: string | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** Set while one user action makes several changes, so they are undone together. */
  private batching = false;
  private trucks: TruckType[] = [];
  private vehicles: Vehicle[] = [];
  private view: TruckView | null = null;
  private workers: Worker[] = [];

  // Mount points that re-render independently.
  private shipmentHint = h('div', { class: 'shipment-hint' });
  /** Everything under "Input Pengiriman"; locked until a shipment number is entered. */
  private inputFields = h('fieldset', { class: 'input-fields' });
  private lockNote = h('p', { class: 'lock-note' }, `🔒 ${t.inputLocked}`);
  private noteInput = h('input', { type: 'text', id: 'note', placeholder: t.notePlaceholder });
  private destCard = h('div', { class: 'dest-card' });
  private linesBox = h('div', { class: 'lines' });
  private pctTotal = h('p', { class: 'pct-total' });
  private trucksBox = h('div', { class: 'truck-slots' });
  private plateList = h('datalist', { id: 'plate-list' });
  private runBtn = h('button', { class: 'btn primary run', type: 'button' }, t.run);
  /** Second run button beside the 3D view, kept in step with the one under the inputs. */
  private runBtn2 = h('button', { class: 'btn primary small run-near', type: 'button' }, `▶ ${t.run}`);
  private bigBtn = h('button', { class: 'view-btn', type: 'button', title: t.biggerView, 'aria-label': t.biggerView, 'aria-pressed': 'false' }, '⤢');
  private fullBtn = h('button', { class: 'view-btn', type: 'button', title: t.fullscreen, 'aria-label': t.fullscreen }, '⛶');
  private stageEl!: HTMLElement;
  private zoneSelect = h('select', { id: 'zone-select' });
  private destNote = h('p', { class: 'hint', hidden: true });
  private undoBtn = h('button', { class: 'btn ghost small', type: 'button', title: t.undoHint, 'aria-label': t.undoHint, disabled: true }, `↶ ${t.undo}`);
  private redoBtn = h('button', { class: 'btn ghost small', type: 'button', title: t.redoHint, 'aria-label': t.redoHint, disabled: true }, '↷');
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

  constructor(
    private onSaved: () => void,
    private onEditRules: () => void,
  ) {
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
      // With a zone picked first, the list shows that zone's destinations as soon as the field is clicked.
      search: (q) => repo.searchDestinations(q, this.zone ? 80 : 12, this.zone),
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
    this.runBtn2.addEventListener('click', () => this.run());
    this.bigBtn.addEventListener('click', () => this.toggleBigView());
    this.fullBtn.addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.syncFullscreen());
    if (readStore(BIG_VIEW_KEY) === 'on') this.toggleBigView(true);
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.renderAll();
  }

  // ---------- Undo (Ctrl+Z) ----------

  private snapshot(): Snapshot {
    return {
      shipmentNo: this.shipmentNo,
      tempNo: this.tempNo,
      shipmentId: this.shipmentId,
      note: this.note,
      destination: this.destination,
      zone: this.zone,
      lines: this.lines.map((l) => ({ ...l })),
      slots: this.slots.map((s) => ({ ...s, dims: { ...s.dims } })),
      results: { ...this.results },
      selected: this.selected,
      truckIdx: this.truckIdx,
      stale: this.stale,
    };
  }

  /** Call before every change the user may want to take back. */
  private remember(state = this.snapshot()) {
    if (this.batching) return;
    this.undoStack.push(state);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.renderUndo();
  }

  private undo() {
    const prev = this.undoStack.pop();
    if (!prev) return this.say(t.nothingToUndo);
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    this.say(t.undone);
  }

  private redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.say(t.redone);
  }

  private restore(s: Snapshot) {
    this.cancel();
    Object.assign(this, { ...s, lines: s.lines.map((l) => ({ ...l })), slots: s.slots.map((x) => ({ ...x, dims: { ...x.dims } })), results: { ...s.results } });
    this.progress = {};
    this.truckIdx = Math.max(0, Math.min(this.truckIdx, this.slots.length - 1));
    this.upToTier = 0;
    this.picked = null;
    this.shipmentCombo.setText(this.shipmentNo);
    this.noteInput.value = this.note;
    this.destCombo.setText(this.destination ? `${this.destination.customer} – ${this.destination.city}` : '');
    this.renderZones();
    this.renderAll();
    this.update3d(true);
  }

  private renderUndo() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  /** Ctrl+Z / Ctrl+Y (Cmd on a Mac) on the planner; inside a text field the browser's own undo runs. */
  private onKey(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !this.el.isConnected) return;
    if (document.querySelector('dialog[open], #print-root')) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, [contenteditable="true"]')) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      e.preventDefault();
      this.redo();
    }
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
    this.view.setTierCounts(this.tierCounts);
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
      this.renderLock();
      this.renderHelper();
    });
    // A shipment number saved before brings its destination; Enter moves on to the zone and destination.
    this.shipmentCombo.input.addEventListener('change', () => this.shipmentEntered());
    this.shipmentCombo.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.shipmentNo && !this.destination) setTimeout(() => this.zoneSelect.focus(), 0);
    });
    this.zoneSelect.addEventListener('change', () => {
      this.zone = this.zoneSelect.value || null;
      // Straight on to the destinations of that zone.
      if (this.zone) this.destCombo.input.focus();
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

    this.renderZones();
    this.inputFields.append(
      h('div', { class: 'dest-row' }, h('label', { for: 'zone-select' }, h('span', {}, t.zoneLabel, ' ', info(t.zoneHint)), this.zoneSelect), h('label', { for: 'dest-search', class: 'grow' }, t.destination, this.destCombo.el)),
      this.destNote,
      this.destCard,
      h(
        'div',
        { class: 'label-row' },
        h('label', { for: 'sku-search' }, t.productsTitle, ' ', info(t.qtyHint)),
        h(
          'span',
          { class: 'label-actions' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => openSkuForm(null, (s) => this.addLine(s, null)) }, `+ ${t.newSku}`),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.pasteDialog() }, t.pasteExcel),
        ),
      ),
      sku.el,
      this.linesBox,
      h('div', { class: 'label-row' }, h('span', { class: 'label' }, t.trucksTitle, ' ', info(t.trucksHint))),
      this.trucksBox,
      this.plateList,
      h('label', { for: 'note' }, t.noteLabel),
      this.noteInput,
      this.optionsBox(),
      this.runBtn,
      this.message,
      ai,
    );
    return h('section', { class: 'input panel' }, h('h2', {}, t.inputTitle), this.lockNote, this.inputFields);
  }

  /** Zone filter for the destination search; the destination's own zone is picked when it has none yet. */
  private renderZones() {
    const zones = repo.listZones();
    this.zoneSelect.replaceChildren(h('option', { value: '' }, t.zoneAll), ...zones.map((z) => h('option', { value: z.zone, selected: z.zone === this.zone }, `${z.zone} (${z.n})`)));
  }

  /** A shipment number that was saved before fills in its destination (the plan itself opens from the list). */
  private shipmentEntered() {
    const no = this.shipmentCombo.input.value.trim();
    this.destNote.hidden = true;
    if (!no || this.destination) return;
    const known = repo.shipmentByNo(no);
    const dest = known?.destination_id ? repo.listDestinations().find((d) => d.id === known.destination_id) : null;
    if (!dest) return;
    this.setDestination(dest);
    this.destCombo.setText(`${dest.customer} – ${dest.city}`);
    this.destNote.textContent = t.shipmentKnown(`${dest.customer} – ${dest.city}`);
    this.destNote.hidden = false;
  }

  /** Options that apply to all three models: grouping by SKU and how many trucks to aim for. */
  private optionsBox(): HTMLElement {
    const group = h('input', { type: 'checkbox', checked: this.groupBySku });
    group.addEventListener('change', () => {
      this.groupBySku = group.checked;
      writeStore(GROUP_KEY, group.checked ? 'on' : 'off');
      this.markStale();
    });
    const target = h(
      'select',
      { id: 'truck-target' },
      h('option', { value: '', selected: this.truckTarget === '' }, t.targetNone),
      h('option', { value: 'min', selected: this.truckTarget === 'min' }, t.targetMin),
      ...[1, 2, 3, 4, 5].map((n) => h('option', { value: n, selected: this.truckTarget === n }, t.targetN(n))),
    );
    target.addEventListener('change', () => {
      this.truckTarget = target.value === 'min' ? 'min' : Number(target.value) || '';
      writeStore(TARGET_KEY, String(this.truckTarget));
      this.markStale();
    });
    return h(
      'fieldset',
      { class: 'run-options' },
      h('legend', {}, t.optionsTitle),
      h('div', { class: 'check-row' }, h('label', { class: 'check' }, group, ` ${t.groupBySku}`), info(t.groupBySkuHint)),
      h('label', { for: 'truck-target' }, h('span', {}, t.truckTarget, ' ', info(t.targetHint)), target),
    );
  }

  /** The shipment number comes first: the input panel opens once there is one (or a reopened draft's number). */
  private renderLock() {
    const locked = !this.shipmentNo && !this.tempNo;
    this.inputFields.disabled = locked;
    this.lockNote.hidden = !locked;
  }

  /** Empties the planner for a new shipment. Saved plans in Riwayat Rencana stay as they are. */
  private async reset() {
    const dirty = this.shipmentNo || this.tempNo || this.lines.length || this.destination || Object.keys(this.results).length;
    if (dirty && !(await confirmDialog(t.resetConfirm, t.resetPlan, t.cancel))) return;
    this.remember();
    this.cancel();
    this.zone = null;
    this.zoneSelect.value = '';
    this.destNote.hidden = true;
    this.shipmentNo = '';
    this.tempNo = '';
    this.shipmentId = null;
    this.shipmentCombo.setText('');
    this.note = '';
    this.noteInput.value = '';
    this.destination = null;
    this.destCombo.setText('');
    this.lines = [];
    this.slots = [this.newSlot(null)];
    this.results = {};
    this.progress = {};
    this.stale = false;
    this.truckIdx = 0;
    this.upToTier = 0;
    this.picked = null;
    this.say('');
    this.renderAll();
    this.update3d(true);
    this.view?.frameCamera();
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
        this.remember();
        slot.typeId = Number(select.value) || null;
        slot.auto = false;
        const d = typeDims(this.typeOf(slot.typeId));
        if (hasDims(d) || slot.typeId != null) slot.dims = d;
        this.truckChanged();
      });
      const dim = (key: keyof Dims, label: string) => {
        const input = h('input', { type: 'number', min: 1, step: 'any', inputmode: 'decimal', value: slot.dims[key] || '', 'aria-label': `${label} ${t.truckN(i + 1)}` });
        input.addEventListener('change', () => {
          this.remember();
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
        h('div', { class: 'dims-head' }, h('span', {}, t.innerSize), edited ? h('button', { class: 'link-btn', type: 'button', onclick: () => (this.remember(), (slot.dims = typeDims(type)), this.truckChanged()) }, t.sizeReset) : null),
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
    this.remember();
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
    this.remember();
    const last = this.slots[this.slots.length - 1];
    this.slots.push({ ...this.newSlot(last?.typeId ?? null), dims: last ? { ...last.dims } : { length: 0, width: 0, height: 0 } });
    this.truckChanged();
  }

  private removeSlot(i: number) {
    this.remember();
    this.slots.splice(i, 1);
    this.truckIdx = Math.min(this.truckIdx, this.slots.length - 1);
    this.truckChanged();
  }

  private truckChanged() {
    this.markStale();
    this.renderTrucks();
    if (this.lines.some((l) => l.pctMode)) this.renderLines();
    this.update3d(true);
    this.renderSummary();
    this.renderDetails();
  }

  private setDestination(d: Destination) {
    this.remember();
    this.destination = d;
    this.destNote.hidden = true;
    const max = repo.maxTruckFor(d.id);
    // Trucks not tied to a plate number or a typed size follow the destination's maximum truck.
    if (max) for (const s of this.slots) if (!s.plateNo && (s.typeId == null || sameDims(s.dims, typeDims(this.typeOf(s.typeId))))) Object.assign(s, { typeId: max.id, dims: typeDims(max) });
    this.markStale();
    this.renderAll();
    this.update3d(true);
  }

  private addLine(s: Sku, qty: number | null, pct: number | null = null) {
    this.remember();
    const existing = this.lines.find((l) => l.sku.id === s.id);
    if (pct != null) {
      if (existing) Object.assign(existing, { pctMode: true, pct });
      else this.lines.push({ sku: s, qty: null, pctMode: true, pct });
    } else if (existing) {
      if (qty != null) Object.assign(existing, { qty, pctMode: false, pct: null });
    } else this.lines.push({ sku: s, qty });
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
      this.remember();
      this.batching = true;
      for (const raw of area.value.split(/\r?\n/)) {
        const [code, qtyText] = raw.split(/\t|;|,/).map((x) => x.trim());
        if (!code) continue;
        const s = repo.skuByCode(code);
        if (!s) {
          if (!/^(no|kode|sap|material|sku)/i.test(code)) missing.push(code);
          continue;
        }
        // "40%" is a share of the trucks' space; a plain number is cartons.
        const pctMatch = /^([\d.,]+)\s*%$/.exec(qtyText ?? '');
        const p = pctMatch ? parseFloat(pctMatch[1].replace(',', '.')) : NaN;
        const q = parseInt((qtyText ?? '').replace(/\./g, ''), 10);
        if (pctMatch && p > 0) this.addLine(s, null, Math.min(100, p));
        else this.addLine(s, Number.isFinite(q) && q > 0 ? q : null);
        added++;
      }
      this.batching = false;
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

  /**
   * Cartons of a SKU that make up `pct` percent of the load: the share of what fits if the trucks
   * entered held only this SKU (plain grid, Standar rules for turning and stacking). So 60% of A and
   * 40% of B fill the trucks in a 60/40 split without spilling onto an extra truck.
   */
  private cartonsForPct(sku: Sku, pct: number): number | null {
    const trucks = this.slots.filter((s, i) => (i === 0 || !s.auto) && hasDims(s.dims));
    if (!trucks.length) return null;
    const rules = repo.loadRules().standard;
    const engineSku = repo.toEngineSku(sku);
    const fits = trucks.reduce((sum, s) => sum + gridCapacity(engineSku, s.dims, rules), 0);
    if (!fits) return null;
    return Math.max(1, Math.floor((pct / 100) * fits));
  }

  /** Cartons of a percent line: a share of its order quantity, or (no order quantity) of what fits. */
  private pctQty(l: Line): number | null {
    if (l.pct == null) return null;
    if (l.orderQty) return Math.max(1, Math.floor((l.pct / 100) * l.orderQty));
    return this.cartonsForPct(l.sku, l.pct);
  }

  /** Percent lines follow the trucks: their carton count is worked out again from the current truck sizes. */
  private syncPctLines() {
    for (const l of this.lines) if (l.pctMode) l.qty = this.pctQty(l);
  }

  private renderLines() {
    this.syncPctLines();
    if (!this.lines.length) {
      this.linesBox.replaceChildren(h('p', { class: 'empty' }, t.noLines));
      return;
    }
    let dragFrom = -1;
    this.linesBox.replaceChildren(
      ...this.lines.map((line, i) => {
        const isPct = !!line.pctMode;
        const input = h('input', {
          class: 'qty-main',
          type: 'number',
          min: isPct ? 0.1 : 1,
          max: isPct ? 100 : undefined,
          step: isPct ? 'any' : 1,
          inputmode: isPct ? 'decimal' : 'numeric',
          placeholder: t.qtyMax,
          value: (isPct ? line.pct : line.qty) ?? '',
          'aria-label': `${isPct ? t.qtyPct : t.qty} ${line.sku.name}`,
        });
        const note = h('span', { class: 'qty-note' });
        const showNote = () => {
          note.textContent = !line.pctMode || line.pct == null ? '' : line.qty == null ? t.pctNeedTruck : line.orderQty ? t.pctOfOrder(fmt.int(line.qty)) : t.pctCartons(fmt.int(line.qty));
          note.classList.toggle('bad', !!line.pctMode && line.pct != null && line.qty == null);
        };
        showNote();
        input.addEventListener('change', () => {
          this.remember();
          if (line.pctMode) {
            const v = parseFloat(input.value.replace(',', '.'));
            line.pct = Number.isFinite(v) && v > 0 ? Math.min(100, v) : null;
            if (line.pct != null && String(line.pct) !== input.value) input.value = String(line.pct);
            line.qty = this.pctQty(line);
          } else {
            const v = parseInt(input.value, 10);
            line.qty = Number.isFinite(v) && v > 0 ? v : null;
          }
          showNote();
          this.renderPctTotal();
          this.markStale();
        });
        const unit = h(
          'button',
          { class: `unit-toggle${isPct ? ' on' : ''}`, type: 'button', title: isPct ? t.unitToCartons : t.unitToPct, 'aria-label': isPct ? t.unitToCartons : t.unitToPct },
          isPct ? '%' : t.unitCartons,
        );
        unit.addEventListener('click', () => {
          this.remember();
          line.pctMode = !line.pctMode;
          line.pct = null;
          line.orderQty = null;
          line.qty = null;
          this.markStale();
          this.renderLines();
          this.linesBox.querySelectorAll<HTMLInputElement>('.qty-main')[i]?.focus();
        });
        // In percent mode: an optional order quantity the percentage is taken from.
        let order: HTMLInputElement | null = null;
        if (isPct) {
          order = h('input', { class: 'qty-order', type: 'number', min: 1, step: 1, inputmode: 'numeric', placeholder: t.orderQtyPlaceholder, title: t.orderQtyHint, value: line.orderQty ?? '', 'aria-label': `${t.orderQty} ${line.sku.name}` });
          order.addEventListener('change', () => {
            this.remember();
            const v = parseInt(order!.value.replace(/\./g, ''), 10);
            line.orderQty = Number.isFinite(v) && v > 0 ? v : null;
            line.qty = this.pctQty(line);
            showNote();
            this.renderPctTotal();
            this.markStale();
          });
        }
        const qty = h('div', { class: 'qty-box' }, h('div', { class: 'qty-field' }, input, unit), order, note);
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
      this.pctTotal,
    );
    this.renderPctTotal();
  }

  /** Under the SKU rows: the percentages entered so far, with a warning above 100%. */
  private renderPctTotal() {
    const pcts = this.lines.filter(isShare).map((l) => l.pct as number);
    const total = pcts.reduce((a, b) => a + b, 0);
    this.pctTotal.hidden = !pcts.length;
    this.pctTotal.classList.toggle('bad', total > 100.0001);
    this.pctTotal.textContent = pcts.length ? t.pctTotal(fmt.d1(total), total > 100.0001) : '';
  }

  private moveLine(from: number, to: number) {
    this.remember();
    const [line] = this.lines.splice(from, 1);
    this.lines.splice(to, 0, line);
    this.markStale();
    this.renderLines();
  }

  private removeLine(i: number) {
    this.remember();
    this.lines.splice(i, 1);
    this.markStale();
    this.renderLines();
    this.renderHelper();
  }

  // ---------- Optimisation ----------

  private run() {
    if (!this.lines.length) return this.say(t.needLines);
    const before = this.snapshot();
    // Trucks the last calculation added (and nobody changed) are worked out again.
    this.slots = this.slots.filter((s, i) => i === 0 || !s.auto);
    const trucks: PlanningTruck[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const tr = this.slotTruck(i);
      if (!tr) return this.say(t.needTruckN(i + 1));
      trucks.push(tr);
    }
    this.say('');
    this.remember(before);
    if (!this.shipmentNo && !this.tempNo) this.tempNo = tempNumber();
    const rules = repo.loadRules();
    this.syncPctLines();
    const pctMissing = this.lines.find((l) => l.pctMode && l.pct != null && l.qty == null);
    if (pctMissing) return this.say(t.pctNeedTruck);
    const base = {
      trucks: trucks.map((tr) => ({ length: tr.length, width: tr.width, height: tr.height })),
      lines: this.lines.map((l) => ({ sku: repo.toEngineSku(l.sku), qty: l.qty, fitShare: isShare(l) || undefined })),
    };
    this.cancel();
    this.results = {};
    this.progress = {};
    this.stale = false;
    this.upToTier = 0;
    this.truckIdx = 0;
    this.picked = null;
    this.setRunBtn(true, t.running);
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
      // Grouping by SKU is chosen once for all three models.
      const req: ShipmentRequest = { ...base, rules: { ...rules[model], groupBySku: this.groupBySku }, truckTarget: this.truckTarget || undefined };
      worker.postMessage({ model, req } satisfies WorkerRequest);
    }
  }

  private finishRun() {
    this.workers = [];
    this.setRunBtn(false, t.run);
    this.loading.hidden = true;
    this.showSelected();
  }

  private cancel() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.setRunBtn(false, t.run);
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

  private setRunBtn(disabled: boolean, text: string) {
    this.runBtn.disabled = disabled;
    this.runBtn.textContent = text;
    this.runBtn2.disabled = disabled;
    this.runBtn2.textContent = disabled ? text : `▶ ${text}`;
  }

  /** A taller (and on wide screens wider) 3D view, remembered on this device. */
  private toggleBigView(on = !this.el.classList.contains('big-view')) {
    this.el.classList.toggle('big-view', on);
    this.bigBtn.setAttribute('aria-pressed', String(on));
    this.bigBtn.title = on ? t.smallerView : t.biggerView;
    this.bigBtn.setAttribute('aria-label', this.bigBtn.title);
    this.bigBtn.textContent = on ? '⤡' : '⤢';
    writeStore(BIG_VIEW_KEY, on ? 'on' : 'off');
  }

  /** Full screen for the whole stage (3D view and its tools); Esc leaves it. */
  private toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.stageEl.requestFullscreen?.().catch(() => this.say(t.fullscreenFailed));
  }

  private syncFullscreen() {
    const on = document.fullscreenElement === this.stageEl;
    this.fullBtn.title = on ? t.exitFullscreen : t.fullscreen;
    this.fullBtn.setAttribute('aria-label', this.fullBtn.title);
    this.fullBtn.classList.toggle('on', on);
  }

  // ---------- Stage: model selector, truck tabs, 3D ----------

  private stagePanel(): HTMLElement {
    this.stageEl = h(
      'section',
      { class: 'stage panel' },
      h(
        'div',
        { class: 'shipment-bar' },
        h('label', { for: 'shipment-no' }, t.shipmentNo),
        this.shipmentCombo.el,
        h('span', { class: 'undo-btns' }, this.undoBtn, this.redoBtn),
        h('button', { class: 'btn ghost small reset-btn', type: 'button', title: t.resetHint, onclick: () => this.reset() }, `↺ ${t.resetPlan}`),
        this.shipmentHint,
      ),
      this.stageHead,
      h(
        'div',
        { class: 'canvas-wrap' },
        this.canvasHost,
        this.helper,
        this.pickedBox,
        h('div', { class: 'view-btns' }, info(t.viewHint), this.bigBtn, this.fullBtn),
      ),
      this.stageTools,
    );
    return this.stageEl;
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
        h('div', { class: 'model-pick' }, h('label', { for: 'model-select' }, t.modelLabel), select, info(t.modelTagline[this.selected]), this.runBtn2),
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
    const counts = h(
      'button',
      { class: `btn ghost small${this.tierCounts ? ' on' : ''}`, type: 'button', 'aria-pressed': String(this.tierCounts), onclick: () => this.toggleTierCounts() },
      this.tierCounts ? `☑ ${t.tierCountLabels}` : `☐ ${t.tierCountLabels}`,
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
      counts,
      labels,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.view?.frameCamera() }, t.resetView),
    );
  }

  private toggleLabels() {
    this.labels = !this.labels;
    writeStore(LABELS_KEY, this.labels ? 'on' : 'off');
    this.view?.setLabels(this.labels);
    this.renderStageTools();
  }

  /** The number of cartons above each tier in the 3D view. */
  private toggleTierCounts() {
    this.tierCounts = !this.tierCounts;
    writeStore(TIER_COUNTS_KEY, this.tierCounts ? 'on' : 'off');
    this.view?.setTierCounts(this.tierCounts);
    this.renderStageTools();
  }

  /** Moves a tier of the truck on screen to another place in the loading order (Urungkan takes it back). */
  private moveTier(from: number, to: number) {
    const result = this.selectedResult();
    const plan = this.selectedPlan();
    const truck = this.slotTruck(this.truckIdx);
    if (!result || !plan || !truck || from === to) return;
    this.remember();
    const moved = moveTier(plan, from, to, truck);
    // The picked carton stays picked: moving keeps the order of a tier's cartons.
    const pickedAt = this.picked && this.picked.tier === from ? plan.boxes.filter((b) => b.tier === from).indexOf(this.picked) : -1;
    const trucks = result.trucks.map((p, i) => (i === this.truckIdx ? moved : p));
    this.results = { ...this.results, [this.selected]: { ...result, trucks } };
    this.upToTier = to;
    this.picked = pickedAt >= 0 ? moved.boxes.filter((b) => b.tier === to)[pickedAt] ?? null : null;
    this.say(t.tierMoved(from, to));
    this.update3d(false);
    this.view?.setPicked(this.picked);
    this.renderPicked();
    this.renderStageTools();
    this.renderStageHead();
    this.renderSummary();
    this.renderDetails();
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
    const tier = plan.tiers.find((x) => x.index === b.tier);
    const inTier = tier?.total ?? plan.boxes.filter((o) => o.tier === b.tier).length;
    const sameSku = tier?.counts[b.skuId] ?? plan.boxes.filter((o) => o.tier === b.tier && o.skuId === b.skuId).length;
    this.pickedBox.hidden = false;
    this.pickedBox.replaceChildren(
      h(
        'div',
        { class: 'picked-head' },
        h('strong', {}, t.picked),
        h('button', { class: 'icon picked-close', type: 'button', title: t.close, 'aria-label': t.close, onclick: () => this.clearPick() }, '×'),
      ),
      h('div', {}, line ? `${line.sku.code} · ${line.sku.name}` : String(b.skuId)),
      h('div', {}, t.pickedTier(b.tier, inTier, plan.segmentTiers)),
      // Only worth a line when the tier mixes SKUs.
      tier && Object.keys(tier.counts).length > 1 ? h('div', { class: 'muted' }, t.pickedTierSku(line?.sku.code ?? String(b.skuId), sameSku)) : '',
      h('div', { class: 'muted' }, t.pickedLayer(below + 1)),
      h('div', { class: 'muted mono' }, `${fmt.dims(b.dx, b.dy, b.dz)} cm`),
      ...[pose ? h('div', {}, `${t.pose} ${pose}: ${t.poses[pose]}`) : null, riskText(plan, b)].filter((x): x is HTMLDivElement => !!x),
      ...(canMoveTiers(plan) ? [this.tierMover(plan, b.tier)] : []),
    );
  }

  private clearPick() {
    this.picked = null;
    this.view?.setPicked(null);
    this.renderPicked();
  }

  /** Moving the picked carton's tier, right in the 3D view: ‹ towards the cab, › towards the door, or a position. */
  private tierMover(plan: PlanResult, i: number): HTMLElement {
    const n = plan.tiers.length;
    const pos = h(
      'select',
      { class: 'tl-pos', 'aria-label': t.moveToLabel(i), title: t.moveToLabel(i) },
      ...Array.from({ length: n }, (_, k) => h('option', { value: k + 1, selected: k + 1 === i }, String(k + 1))),
    );
    pos.addEventListener('change', () => this.moveTier(i, Number(pos.value)));
    return h(
      'div',
      { class: 'tier-mover' },
      h('span', { class: 'muted' }, t.moveTierTo),
      h('button', { class: 'icon', type: 'button', title: t.moveEarlier, 'aria-label': t.moveEarlier, disabled: i === 1, onclick: () => this.moveTier(i, i - 1) }, '‹'),
      pos,
      h('button', { class: 'icon', type: 'button', title: t.moveLater, 'aria-label': t.moveLater, disabled: i === n, onclick: () => this.moveTier(i, i + 1) }, '›'),
      info(t.moveTierHint),
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
        this.fillBlock(result.trucks),
        result.target ? this.targetNote(result) : null,
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
          h('button', { class: 'btn ghost small', type: 'button', title: t.editRulesHint, onclick: () => this.onEditRules() }, `⚙ ${t.editRules}`),
        ),
      );
    }

    if (plan) {
      out.push(
        h('h3', { class: 'summary-sub' }, t.thisTruck(this.truckIdx + 1, result!.trucks.length), this.slots[this.truckIdx]?.plateNo ? h('span', { class: 'mono' }, ` · ${this.slots[this.truckIdx].plateNo}`) : null),
        plan.edited ? h('p', {}, h('span', { class: 'tag warn', title: t.editedHint }, t.editedTag)) : null,
        h(
          'div',
          { class: 'kpis' },
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.totalCartons), h('span', { class: 'kpi-value' }, fmt.int(plan.totalCartons))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, plan.segmentTiers ? t.segmentCount : t.tierCount), h('span', { class: 'kpi-value' }, fmt.int(plan.tiers.length))),
          h('div', { class: 'kpi' }, h('span', { class: 'kpi-label' }, t.usedLength), h('span', { class: 'kpi-value' }, fmt.m(plan.usedLength))),
        ),
      );
      out.push(stabilityBlock(plan, this.colorMode === 'risk'));
      // Cartons per tier, open by default: loaders count and photograph tier by tier.
      out.push(
        h(
          'div',
          { class: 'per-tier' },
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => ((this.showPerTier = !this.showPerTier), this.renderSummary()) }, this.showPerTier ? t.hidePerTier : t.showPerTier),
          this.showPerTier ? this.tierList(plan) : null,
        ),
      );
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


    this.summaryBox.replaceChildren(...(out.filter(Boolean) as HTMLElement[]));
    if (!this.summaryBox.childElementCount) this.summaryBox.append(h('p', { class: 'muted' }, t.emptyState));
  }

  /** Cartons per tier, each row clickable to show that tier in 3D (tiers are moved from a picked carton in 3D). */
  private tierList(plan: PlanResult): HTMLElement {
    const skuOf = (id: number) => this.lines.find((l) => l.sku.id === id)?.sku;
    const skuIdx = (id: number) => this.lines.findIndex((l) => l.sku.id === id);
    return h(
      'ol',
      { class: 'tier-list' },
      ...plan.tiers.map((tier) => {
        const i = tier.index;
        return h(
          'li',
          { class: tier.index === this.upToTier ? 'on' : '' },
          h(
            'button',
            { type: 'button', class: 'tl-main', onclick: () => this.focusTier(i) },
            h('span', { class: 'tl-no' }, `${plan.segmentTiers ? t.segments : t.tierNo} ${i}`),
            h('span', { class: 'tl-chips' }, ...Object.entries(tier.counts).map(([id, c]) => h('span', { class: 'chip', title: skuOf(Number(id))?.name ?? '' }, h('i', { style: `background:${skuColor(skuIdx(Number(id)))}` }), `${skuOf(Number(id))?.code ?? id} ${fmt.int(c)}`))),
            h('span', { class: 'tl-total' }, fmt.int(tier.total)),
          ),
        );
      }),
    );
  }

  /** Whether the truck target was met, and why not when it was not. */
  private targetNote(result: ShipmentResult): HTMLElement {
    const x = result.target!;
    const text = x.reached ? t.targetReached(x.goal) : x.goal < x.lowerBound ? t.targetImpossible(x.goal, x.lowerBound) : t.targetMissed(x.goal, result.trucks.length, x.rounds);
    return h('p', { class: x.reached ? 'target-note ok' : 'target-note bad' }, text);
  }

  /**
   * How full each truck is: carton volume loaded by the model against the truck's inner volume,
   * plus the whole shipment. Clicking a truck's bar opens that truck.
   */
  private fillBlock(plans: PlanResult[]): HTMLElement {
    let loaded = 0;
    let space = 0;
    const rows = plans.map((p, i) => {
      const tr = this.slotTruck(i);
      const cap = tr ? tr.length * tr.width * tr.height : 0;
      loaded += p.loadedVolume;
      space += cap;
      const ratio = cap > 0 ? p.loadedVolume / cap : p.volumeUtilization;
      return h(
        'button',
        { type: 'button', class: `fill-row${i === this.truckIdx ? ' on' : ''}`, onclick: () => this.selectTruck(i) },
        h('span', { class: 'fill-name' }, t.truckN(i + 1), this.slots[i]?.plateNo ? h('span', { class: 'mono muted' }, ` ${this.slots[i].plateNo}`) : null),
        fillBar(ratio),
        h('span', { class: 'fill-pct' }, fmt.pct(ratio)),
        h('span', { class: 'fill-sub' }, t.fillDetail(fmt.d1(p.loadedVolume / 1e6), fmt.d1(cap / 1e6), fmt.d1(Math.max(0, cap - p.loadedVolume) / 1e6))),
      );
    });
    const total = space > 0 ? loaded / space : 0;
    return h(
      'div',
      { class: 'fill-block' },
      h('div', { class: 'fill-head' }, h('span', { class: 'kpi-label' }, t.fillTitle, ' ', info(t.fillHint)), plans.length > 1 ? h('span', { class: 'fill-total' }, `${t.fillShipment}: `, h('strong', {}, fmt.pct(total))) : null),
      ...rows,

    );
  }

  /** The trucks of the chosen result with the truck and plate number each was planned for. */
  private plannedTrucks() {
    const result = this.selectedResult();
    if (!result) return [];
    return result.trucks.map((plan, i) => ({ plan, truck: this.slotTruck(i)!, plateNo: this.slots[i]?.plateNo || null, seq: i + 1 }));
  }

  /** Saving needs a shipment number (or a draft number) and at least one plate number, and asks before saving the other trucks without one. */
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
    // A shipment needs at least one plate number; a draft may still be saved without one.
    if (!isTemp && !trucks.some((x) => x.plateNo)) {
      if (await confirmDialog(t.saveNeedsPlate(no), t.fillPlate, t.cancel, false)) this.el.querySelector<HTMLInputElement>('input[list="plate-list"]')?.focus();
      return;
    }
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
      // Percent lines are saved as the cartons the chosen model planned for them.
      lines: this.lines.map((l) => ({ sku: l.sku, qty: (isShare(l) ? this.results[this.selected]?.requested?.[l.sku.id] : null) ?? l.qty })),
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
                const asked = (isShare(l) ? result?.requested?.[l.sku.id] : null) ?? l.qty;
                const rest = asked != null ? Math.max(0, asked - loaded) : null;
                return h(
                  'tr',
                  {},
                  h('td', {}, h('span', { class: 'chip' }, h('i', { style: `background:${skuColor(i)}` }), l.sku.code)),
                  h('td', {}, l.sku.name),
                  h('td', {}, fmt.dims(...repo.plannedDims(l.sku))),
                  h('td', { class: 'num' }, fmt.d3(l.sku.volume_m3)),
                  h('td', { class: 'num' }, fmt.int(l.sku.safe_stack_layers)),
                  h('td', { class: 'num' }, asked != null ? fmt.int(asked) : t.qtyMax, l.pctMode && l.pct != null ? h('span', { class: 'muted' }, ` (${fmt.d1(l.pct)}%${l.orderQty ? ` × ${fmt.int(l.orderQty)}` : ''})`) : null),
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
      h('h4', {}, t.fixedRulesTitle),
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
    this.renderLock();
    this.renderDestCard();
    this.renderTrucks();
    this.renderLines();
    this.renderStageHead();
    this.renderStageTools();
    this.renderSummary();
    this.renderDetails();
    this.renderHelper();
    this.renderUndo();
  }

  /**
   * A made-up shipment to try the app: three real SAP SKUs that need two CDD trucks, so the
   * multi-truck tabs, plate numbers and carton positions all show. Nothing is saved until the user saves it.
   */
  loadExample() {
    this.remember();
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
    this.remember();
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

/** A small ⓘ that shows an explanation on hover or tap, instead of a paragraph of hint text. */
function info(text: string): HTMLElement {
  const el = h('span', { class: 'info', tabindex: '0', role: 'note', title: text, 'aria-label': text }, 'ⓘ');
  // Touch screens have no hover: a tap shows the text in place.
  el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.toggle('open');
  });
  el.append(h('span', { class: 'info-pop' }, text));
  return el;
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
    h('span', { class: 'kpi-label' }, t.stability, ' ', info(t.stabilityHint(...physicsNumbers(plan)))),
    h('strong', {}, s.risky ? `⚠ ${t.stabilityRisk(s.risky)}` : `✓ ${t.stabilityOk}`),
    s.risky ? h('div', { class: 'small' }, t.stabilityParts(s.tip, s.slide, s.overhang)) : null,
    s.endFace ? h('div', { class: 'small' }, t.doorNote) : null,
    legend ? h('div', { class: 'risk-legend' }, item(1, t.riskTip), item(2, t.riskSlide), item(4, t.riskOverhang), item(0, t.riskNone)) : null,
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

/** Horizontal fill bar; colour shows how much room is left. */
function fillBar(ratio: number): HTMLElement {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  const level = ratio >= 0.85 ? 'full' : ratio >= 0.6 ? 'mid' : 'low';
  return h('span', { class: `fill-bar ${level}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, h('i', { style: `width:${pct.toFixed(1)}%` }));
}
