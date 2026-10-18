import * as repo from '../db/repo';
import { exportDatabase, importDatabase, resetDatabase, query } from '../db/database';
import { t } from '../i18n/id';
import { confirmDialog, fmt, h } from './dom';

type FieldType = 'text' | 'number' | 'bool' | 'packaging';
interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
}

interface EntitySpec<T extends { id: number }> {
  title: string;
  note?: string;
  fields: Field[];
  columns: { label: string; value: (row: T) => string | Node; num?: boolean }[];
  list: () => T[];
  save: (row: Record<string, unknown>, original: T | null) => void;
  remove: (row: T) => void;
  extraForm?: (row: T | null) => { el: HTMLElement; value: () => unknown };
  searchText: (row: T) => string;
}

type Tab = 'skus' | 'trucks' | 'destinations' | 'history' | 'database';

export class MasterData {
  readonly el = h('div', { class: 'master' });
  private tab: Tab = 'skus';
  private filter = '';

  constructor(private onChange: () => void) {
    this.render();
  }

  render() {
    const tabs: [Tab, string][] = [
      ['skus', t.masterSkus],
      ['trucks', t.masterTrucks],
      ['destinations', t.masterDestinations],
      ['history', t.masterHistory],
      ['database', t.masterDatabase],
    ];
    const nav = h('div', { class: 'seg master-tabs', role: 'tablist' }, ...tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: this.tab === id ? 'on' : '', 'aria-selected': String(this.tab === id), onclick: () => ((this.tab = id), (this.filter = ''), this.render()) }, label)));
    let body: HTMLElement;
    if (this.tab === 'skus') body = this.entity(this.skuSpec());
    else if (this.tab === 'trucks') body = this.entity(this.truckSpec());
    else if (this.tab === 'destinations') body = this.entity(this.destinationSpec());
    else if (this.tab === 'history') body = this.history();
    else body = this.database();
    this.el.replaceChildren(nav, body);
  }

  private entity<T extends { id: number }>(spec: EntitySpec<T>): HTMLElement {
    const all = spec.list();
    const f = this.filter.toLowerCase();
    const rows = f ? all.filter((r) => spec.searchText(r).toLowerCase().includes(f)) : all;
    const search = h('input', { type: 'search', placeholder: t.search, value: this.filter, 'aria-label': t.search });
    search.addEventListener('input', () => {
      this.filter = search.value;
      const pos = search.selectionStart;
      this.render();
      const next = this.el.querySelector<HTMLInputElement>('.master-toolbar input[type=search]');
      next?.focus();
      if (pos != null) next?.setSelectionRange(pos, pos);
    });
    const table = h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...spec.columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)), h('th', {}, ''))),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {},
            ...spec.columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.value(r))),
            h(
              'td',
              { class: 'row-actions' },
              h('button', { class: 'btn ghost small', type: 'button', onclick: () => this.openForm(spec, r) }, t.edit),
              h('button', { class: 'btn ghost small danger', type: 'button', onclick: async () => (await confirmDialog(t.confirmDelete, t.delete, t.cancel)) && (spec.remove(r), this.onChange(), this.render()) }, t.delete),
            ),
          ),
        ),
      ),
    );
    return h(
      'section',
      { class: 'panel' },
      h('div', { class: 'master-toolbar' }, h('h2', {}, spec.title), search, h('span', { class: 'muted' }, t.rows(rows.length)), h('button', { class: 'btn primary', type: 'button', onclick: () => this.openForm(spec, null) }, t.add)),
      spec.note ? h('p', { class: 'hint' }, spec.note) : null,
      h('div', { class: 'table-wrap tall' }, table),
    );
  }

  private openForm<T extends { id: number }>(spec: EntitySpec<T>, row: T | null) {
    const values = (row ?? {}) as Record<string, unknown>;
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const fields = spec.fields.map((f) => {
      let input: HTMLInputElement | HTMLSelectElement;
      const v = values[f.key];
      if (f.type === 'bool') input = h('input', { type: 'checkbox', checked: !!v });
      else if (f.type === 'packaging')
        input = h('select', {}, h('option', { value: 'carton', selected: v !== 'bale' }, t.carton), h('option', { value: 'bale', selected: v === 'bale' }, t.bale));
      else input = h('input', { type: f.type === 'number' ? 'number' : 'text', step: 'any', value: v == null ? '' : String(v), required: f.required });
      inputs.set(f.key, input);
      return h('label', { class: f.type === 'bool' ? 'check' : '' }, f.type === 'bool' ? [input, ` ${f.label}`] : [f.label, input]);
    });
    const extra = spec.extraForm?.(row);
    const error = h('p', { class: 'alert', hidden: true });
    const dialog = h('dialog', { class: 'form-dialog' });
    const form = h(
      'form',
      { method: 'dialog' },
      h('h3', {}, `${row ? t.edit : t.add} · ${spec.title}`),
      h('div', { class: 'form-grid' }, ...fields),
      extra?.el,
      error,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, t.cancel), h('button', { class: 'btn primary', type: 'submit' }, t.save)),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out: Record<string, unknown> = { id: row?.id };
      for (const f of spec.fields) {
        const input = inputs.get(f.key)!;
        if (f.type === 'bool') out[f.key] = (input as HTMLInputElement).checked ? 1 : 0;
        else if (f.type === 'number') out[f.key] = input.value === '' ? null : Number(input.value);
        else out[f.key] = input.value.trim() === '' ? null : input.value.trim();
        if (f.required && (out[f.key] == null || out[f.key] === '')) {
          error.textContent = `${f.label} wajib diisi.`;
          error.hidden = false;
          return;
        }
      }
      if (extra) out.__extra = extra.value();
      try {
        spec.save(out, row);
      } catch (err) {
        error.textContent = String(err);
        error.hidden = false;
        return;
      }
      dialog.close();
      this.onChange();
      this.render();
    });
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  private skuSpec(): EntitySpec<repo.Sku> {
    return {
      title: t.masterSkus,
      note: t.dummyNote,
      fields: [
        { key: 'code', label: t.code, type: 'text', required: true },
        { key: 'name', label: t.name, type: 'text', required: true },
        { key: 'length_cm', label: t.lengthCm, type: 'number', required: true },
        { key: 'width_cm', label: t.widthCm, type: 'number', required: true },
        { key: 'height_cm', label: t.heightCm, type: 'number', required: true },
        { key: 'weight_kg', label: t.weightKg, type: 'number' },
        { key: 'safe_stack_height_cm', label: t.safeStackCm, type: 'number', required: true },
        { key: 'packaging', label: t.packaging, type: 'packaging' },
        { key: 'can_lie_down', label: t.canLieDown, type: 'bool' },
        { key: 'is_dummy', label: t.isDummy, type: 'bool' },
      ],
      columns: [
        { label: t.code, value: (r) => h('span', {}, r.code, r.is_dummy ? h('span', { class: 'tag' }, t.dummy) : null) },
        { label: t.name, value: (r) => r.name },
        { label: t.dims, value: (r) => fmt.dims(r.length_cm, r.width_cm, r.height_cm) },
        { label: t.volume, value: (r) => fmt.d3(r.volume_m3), num: true },
        { label: t.safeStackCm, value: (r) => fmt.int(r.safe_stack_height_cm), num: true },
        { label: t.weightKg, value: (r) => (r.weight_kg != null ? fmt.d1(r.weight_kg) : '–'), num: true },
        { label: t.packaging, value: (r) => (r.packaging === 'bale' ? t.bale : t.carton) },
        { label: t.canLieDown, value: (r) => (r.can_lie_down ? t.yes : t.no) },
      ],
      list: repo.listSkus,
      save: (v) => repo.saveSku(v as unknown as repo.Sku),
      remove: (r) => repo.deleteSku(r.id),
      searchText: (r) => `${r.code} ${r.name}`,
    };
  }

  private truckSpec(): EntitySpec<repo.TruckType> {
    return {
      title: t.masterTrucks,
      note: t.truckEstimateNote,
      fields: [
        { key: 'code', label: t.code, type: 'text', required: true },
        { key: 'name', label: t.name, type: 'text', required: true },
        { key: 'est_volume_min', label: t.estMin, type: 'number' },
        { key: 'est_volume_max', label: t.estMax, type: 'number' },
        { key: 'inner_length_cm', label: t.lengthCm, type: 'number' },
        { key: 'inner_width_cm', label: t.widthCm, type: 'number' },
        { key: 'inner_height_cm', label: t.heightCm, type: 'number' },
        { key: 'max_payload_kg', label: t.payloadKg, type: 'number' },
        { key: 'notes', label: t.notes, type: 'text' },
        { key: 'dims_estimated', label: t.dimsEstimated, type: 'bool' },
      ],
      columns: [
        { label: t.code, value: (r) => r.code },
        { label: t.name, value: (r) => r.name },
        { label: t.estVolume, value: (r) => (r.est_volume_max ? `${fmt.d1(r.est_volume_min ?? r.est_volume_max)}–${fmt.d1(r.est_volume_max)}` : '–'), num: true },
        { label: t.innerDims, value: (r) => h('span', {}, fmt.dims(r.inner_length_cm, r.inner_width_cm, r.inner_height_cm), r.dims_estimated ? h('span', { class: 'tag warn' }, t.estimated) : null) },
        { label: t.calcVolume, value: (r) => (repo.truckVolume(r) ? fmt.d1(repo.truckVolume(r)!) : '–'), num: true },
        { label: t.notes, value: (r) => r.notes ?? '' },
      ],
      list: repo.listTrucks,
      save: (v) => repo.saveTruck(v as unknown as repo.TruckType),
      remove: (r) => repo.deleteTruck(r.id),
      searchText: (r) => `${r.code} ${r.name}`,
    };
  }

  private destinationSpec(): EntitySpec<repo.Destination> {
    const trucks = repo.listTrucks();
    const links = new Map<number, number[]>();
    for (const row of query<{ destination_id: number; truck_type_id: number }>('SELECT * FROM destination_trucks')) {
      const list = links.get(row.destination_id) ?? [];
      list.push(row.truck_type_id);
      links.set(row.destination_id, list);
    }
    const truckName = new Map(trucks.map((x) => [x.id, x.name]));
    return {
      title: t.masterDestinations,
      fields: [
        { key: 'ship_to_no', label: t.shipTo, type: 'text' },
        { key: 'customer', label: t.customer, type: 'text', required: true },
        { key: 'city', label: t.city, type: 'text', required: true },
        { key: 'zone', label: t.zone, type: 'text' },
        { key: 'vehicle_type_raw', label: t.vehicleRaw, type: 'text' },
      ],
      columns: [
        { label: t.shipTo, value: (r) => r.ship_to_no ?? '–' },
        { label: t.customer, value: (r) => r.customer },
        { label: t.city, value: (r) => r.city },
        { label: t.zone, value: (r) => r.zone ?? '' },
        { label: t.allowedTrucks, value: (r) => (links.get(r.id) ?? []).map((id) => truckName.get(id)).join(', ') || h('span', { class: 'tag warn' }, '–') },
      ],
      list: repo.listDestinations,
      save: (v) => repo.saveDestination(v as unknown as repo.Destination, (v.__extra as number[]) ?? []),
      remove: (r) => repo.deleteDestination(r.id),
      extraForm: (row) => {
        const selected = new Set(row ? links.get(row.id) ?? [] : []);
        const boxes = trucks.map((tr) => {
          const cb = h('input', { type: 'checkbox', value: tr.id, checked: selected.has(tr.id) });
          return { cb, el: h('label', { class: 'check' }, cb, ` ${tr.name}`) };
        });
        return {
          el: h('fieldset', { class: 'truck-checks' }, h('legend', {}, t.allowedTrucks), ...boxes.map((b) => b.el)),
          value: () => boxes.filter((b) => b.cb.checked).map((b) => Number(b.cb.value)),
        };
      },
      searchText: (r) => `${r.ship_to_no ?? ''} ${r.customer} ${r.city} ${r.zone ?? ''}`,
    };
  }

  private history(): HTMLElement {
    const rows = repo.listSavedPlans();
    return h(
      'section',
      { class: 'panel' },
      h('div', { class: 'master-toolbar' }, h('h2', {}, t.masterHistory), h('span', { class: 'muted' }, t.rows(rows.length))),
      h(
        'div',
        { class: 'table-wrap tall' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, ...[t.date, t.soNumber, t.destination, t.truck, t.model, t.totalCartons, t.tierCount, t.utilization, ''].map((x, i) => h('th', { class: i >= 5 && i < 8 ? 'num' : '' }, x)))),
          h(
            'tbody',
            {},
            ...rows.map((r) =>
              h(
                'tr',
                {},
                h('td', {}, r.created_at),
                h('td', {}, r.so_number ?? '–'),
                h('td', {}, r.customer ? `${r.customer}, ${r.city}` : '–'),
                h('td', {}, r.truck_name ?? '–'),
                h('td', {}, t.models[r.model as keyof typeof t.models] ?? r.model),
                h('td', { class: 'num' }, fmt.int(r.total_cartons)),
                h('td', { class: 'num' }, fmt.int(r.tier_count)),
                h('td', { class: 'num' }, fmt.pct(r.volume_utilization)),
                h('td', { class: 'row-actions' }, h('button', { class: 'btn ghost small danger', type: 'button', onclick: async () => (await confirmDialog(t.confirmDelete, t.delete, t.cancel)) && (repo.deleteShipment(r.shipment_id), this.render()) }, t.delete)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  private database(): HTMLElement {
    const file = h('input', { type: 'file', accept: '.sqlite,.db,application/x-sqlite3', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        await importDatabase(new Uint8Array(await f.arrayBuffer()));
        this.onChange();
        this.render();
      } catch (err) {
        console.error(err);
      }
    });
    const download = () => {
      const blob = new Blob([exportDatabase() as BlobPart], { type: 'application/x-sqlite3' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `truck-load-optimizer-${new Date().toISOString().slice(0, 10)}.sqlite` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const counts = query<{ n: string; c: number }>(
      `SELECT 'SKU' AS n, count(*) AS c FROM skus UNION ALL SELECT 'Truk', count(*) FROM truck_types
       UNION ALL SELECT 'Tujuan', count(*) FROM destinations UNION ALL SELECT 'Rencana', count(*) FROM load_plans`,
    );
    return h(
      'section',
      { class: 'panel db-panel' },
      h('h2', {}, t.masterDatabase),
      h('p', {}, t.dbInfo),
      h('ul', { class: 'db-counts' }, ...counts.map((c) => h('li', {}, h('strong', {}, fmt.int(c.c)), ` ${c.n}`))),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: download }, t.exportDb),
        h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, t.importDb),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => (await confirmDialog(t.confirmReset, t.resetDb, t.cancel)) && (await resetDatabase(), this.onChange(), this.render()) }, t.resetDb),
        file,
      ),
    );
  }
}
