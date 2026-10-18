import * as repo from '../db/repo';
import type { PlanStatus, SavedPlan } from '../db/repo';
import { t } from '../i18n/id';
import { confirmDialog, fmt, h } from './dom';
import { printPlan } from './print';

const STATUSES: PlanStatus[] = ['draft', 'final', 'loaded'];

/** Saved plans: find a plan, record its status and the actual counts written on the paper sheet. */
export class History {
  readonly el = h('div', { class: 'history' });
  private text = '';
  private from = '';
  private to = '';
  private status: PlanStatus | '' = '';
  private selectedId: number | null = null;
  private listBox = h('div', { class: 'table-wrap tall' });
  private detailBox = h('aside', { class: 'panel history-detail' });

  constructor(private open: (plan: SavedPlan) => void) {
    const search = h('input', { type: 'search', id: 'h-search', placeholder: t.historySearchPlaceholder });
    search.addEventListener('input', () => ((this.text = search.value), this.renderList()));
    const from = h('input', { type: 'date', id: 'h-from' });
    from.addEventListener('change', () => ((this.from = from.value), this.renderList()));
    const to = h('input', { type: 'date', id: 'h-to' });
    to.addEventListener('change', () => ((this.to = to.value), this.renderList()));
    const status = h('select', { id: 'h-status' }, h('option', { value: '' }, t.statusAll), ...STATUSES.map((s) => h('option', { value: s }, t.statuses[s])));
    status.addEventListener('change', () => ((this.status = status.value as PlanStatus | ''), this.renderList()));
    this.el.append(
      h(
        'section',
        { class: 'panel history-list' },
        h(
          'div',
          { class: 'filters' },
          h('label', { for: 'h-search', class: 'grow' }, t.historySearch, search),
          h('label', { for: 'h-from' }, t.from, from),
          h('label', { for: 'h-to' }, t.to, to),
          h('label', { for: 'h-status' }, t.status, status),
        ),
        this.listBox,
      ),
      this.detailBox,
    );
  }

  render() {
    this.renderList();
  }

  private plans(): SavedPlan[] {
    const q = this.text.trim().toLowerCase();
    return repo.listSavedPlans().filter((p) => {
      const day = p.created_at.slice(0, 10);
      if (this.from && day < this.from) return false;
      if (this.to && day > this.to) return false;
      if (this.status && p.status !== this.status) return false;
      return !q || `${p.customer ?? ''} ${p.city ?? ''} ${p.zone ?? ''} ${p.reference ?? ''}`.toLowerCase().includes(q);
    });
  }

  private truckName(p: SavedPlan) {
    return p.truck_name ?? (JSON.parse(p.truck_json) as repo.PlanTruck).name;
  }

  private renderList() {
    const rows = this.plans();
    if (this.selectedId != null && !rows.some((r) => r.id === this.selectedId)) this.selectedId = null;
    if (!rows.length) {
      this.listBox.replaceChildren(h('p', { class: 'muted' }, t.noPlans));
      this.renderDetail(null);
      return;
    }
    this.listBox.replaceChildren(
      h(
        'table',
        { class: 'pick-table' },
        h('thead', {}, h('tr', {}, h('th', {}, t.date), h('th', {}, t.destination), h('th', {}, t.truck), h('th', {}, t.model), h('th', { class: 'num' }, t.cartons), h('th', {}, t.status))),
        h(
          'tbody',
          {},
          ...rows.map((p) =>
            h(
              'tr',
              { class: p.id === this.selectedId ? 'on' : '', tabindex: '0', onclick: () => this.select(p.id), onkeydown: (e: Event) => (e as KeyboardEvent).key === 'Enter' && this.select(p.id) },
              h('td', { class: 'nowrap' }, fmtDate(p.created_at)),
              h('td', {}, p.customer ? `${p.customer} · ${p.city}` : '–', p.reference ? h('div', { class: 'muted small' }, p.reference) : null),
              h('td', {}, this.truckName(p)),
              h('td', {}, t.models[p.model]),
              h('td', { class: 'num' }, fmt.int(p.total_cartons)),
              h('td', {}, h('span', { class: `status-pill ${p.status}` }, t.statuses[p.status])),
            ),
          ),
        ),
      ),
    );
    this.renderDetail(rows.find((r) => r.id === this.selectedId) ?? null);
  }

  private select(id: number) {
    this.selectedId = id;
    this.renderList();
  }

  private renderDetail(p: SavedPlan | null) {
    if (!p) {
      this.detailBox.replaceChildren(h('p', { class: 'muted' }, t.pickPlan));
      return;
    }
    const result = repo.planResult(p.id);
    const truck = JSON.parse(p.truck_json) as repo.PlanTruck;
    let status = p.status;
    const actual: Record<number, number | null> = p.actual_json ? JSON.parse(p.actual_json) : {};
    const tierWord = result?.segmentTiers ? t.segments : t.tierNo;

    const seg = h('div', { class: 'seg status-seg', role: 'radiogroup', 'aria-label': t.status });
    const renderSeg = () =>
      seg.replaceChildren(
        ...STATUSES.map((s) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(s === status), class: s === status ? 'on' : '', onclick: () => ((status = s), renderSeg()) }, t.statuses[s])),
      );
    renderSeg();
    const note = h('textarea', { id: 'h-note', rows: 3 }, p.planner_note ?? '');

    const diffCell = (plan: number, v: number | null) => {
      const d = v == null ? null : v - plan;
      return h('td', { class: `num ${d ? 'bad' : ''}` }, d == null ? '–' : d > 0 ? `+${d}` : String(d));
    };
    const tierRows = (result?.tiers ?? []).map((tier) => {
      const input = h('input', { type: 'number', min: 0, step: 1, class: 'num actual-input', value: actual[tier.index] ?? '', 'aria-label': `${t.actual} ${tierWord} ${tier.index}` });
      const row = h('tr', {}, h('td', {}, `${tierWord} ${tier.index}`), h('td', { class: 'num' }, fmt.int(tier.total)), h('td', { class: 'num' }, input), diffCell(tier.total, actual[tier.index] ?? null));
      input.addEventListener('input', () => {
        actual[tier.index] = input.value === '' ? null : Math.max(0, Math.round(Number(input.value)));
        row.lastElementChild!.replaceWith(diffCell(tier.total, actual[tier.index]));
        renderTotal();
      });
      return row;
    });
    const totalRow = h('tr', { class: 'total-row' });
    const renderTotal = () => {
      const entered = Object.values(actual).filter((v): v is number => v != null);
      const sum = entered.reduce((a, b) => a + b, 0);
      totalRow.replaceChildren(h('th', {}, t.total), h('th', { class: 'num' }, fmt.int(p.total_cartons)), h('th', { class: 'num' }, entered.length ? fmt.int(sum) : '–'), entered.length ? diffCell(p.total_cartons, sum) : h('td', {}, ''));
    };
    renderTotal();

    const message = h('span', { class: 'muted', role: 'status' });
    const save = () => {
      repo.updatePlanTracking(p.id, status, note.value.trim() || null, actual);
      this.renderList();
      const shown = this.detailBox.querySelector('[role=status]');
      if (shown) shown.textContent = `${t.savedShort} ✓`;
    };
    const reprint = () => {
      if (!result) return;
      const destination = p.destination_id ? repo.listDestinations().find((d) => d.id === p.destination_id) ?? null : null;
      const skus = repo.shipmentLines(p.shipment_id).map((l) => l.sku);
      printPlan({ plan: result, truck, destination, reference: p.reference ?? '', skus, snapshot: null });
    };
    const remove = async () => {
      if (!(await confirmDialog(t.confirmDelete, t.delete, t.cancel))) return;
      repo.deleteShipment(p.shipment_id);
      this.selectedId = null;
      this.renderList();
    };

    this.detailBox.replaceChildren(
      h('div', {}, h('h2', {}, `${fmtDate(p.created_at)} · ${p.customer ?? '–'}`), h('p', { class: 'muted' }, `${this.truckName(p)} · ${t.models[p.model]} · ${fmt.int(p.total_cartons)} ${t.cartons} ${t.plan.toLowerCase()}`)),
      h('div', {}, h('span', { class: 'label' }, t.status), seg),
      h('label', { for: 'h-note' }, t.plannerNote, note),
      h(
        'div',
        {},
        h('span', { class: 'label' }, t.actualPerTier),
        h(
          'div',
          { class: 'table-wrap' },
          h('table', { class: 'actual-table' }, h('thead', {}, h('tr', {}, h('th', {}, tierWord), h('th', { class: 'num' }, t.plan), h('th', { class: 'num' }, t.actual), h('th', { class: 'num' }, t.diff))), h('tbody', {}, ...tierRows), h('tfoot', {}, totalRow)),
        ),
        h('p', { class: 'hint' }, t.actualHint),
      ),
      h(
        'div',
        { class: 'actions wrap' },
        h('button', { class: 'btn', type: 'button', onclick: () => this.open(p) }, t.openInPlanner),
        h('button', { class: 'btn', type: 'button', onclick: reprint, disabled: !result }, t.reprint),
        h('button', { class: 'btn ghost danger', type: 'button', onclick: remove }, t.delete),
        h('span', { class: 'spacer' }),
        message,
        h('button', { class: 'btn primary', type: 'button', onclick: save }, t.save),
      ),
    );
  }
}

function fmtDate(sqlTime: string) {
  const [d, time] = sqlTime.split(' ');
  const [y, m, day] = d.split('-');
  return `${day}-${m}-${y}${time ? ` ${time.slice(0, 5)}` : ''}`;
}
