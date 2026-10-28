import * as repo from '../db/repo';
import { dbMode, exportDatabase, importDatabase, resetDatabase, query } from '../db/database';
import { DEFAULT_RULES, MODEL_ORDER, type ModelId, type ModelRules } from '../engine';
import { t } from '../i18n/id';
import { admin } from './admin';
import { confirmDialog, fmt, h } from './dom';
import { openSkuForm } from './sku-form';
import * as personal from '../db/personal';
import { discardAllPersonal, discardPersonal } from '../db/personal';
import { parseMaterialDescription, skuFromSap } from '../db/material';

type FieldType = 'text' | 'number' | 'bool' | 'select';
interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: [string, string][];
  hint?: string;
}

interface EntitySpec<T extends { id: number }> {
  title: string;
  note?: string;
  fields: Field[];
  columns: { label: string; value: (row: T) => string | Node; num?: boolean }[];
  list: () => T[];
  save: (row: Record<string, unknown>, original: T | null) => unknown;
  remove: (row: T) => unknown;
  extraForm?: (row: T | null) => { el: HTMLElement; value: () => unknown };
  searchText: (row: T) => string;
  toolbar?: () => Node[];
  defaults?: Record<string, unknown>;
  /** Overrides the admin-only rule (SKUs can always be changed in the personal layer). */
  editable?: boolean;
  /** Replaces the generic form. */
  openEditor?: (row: T | null) => void;
  /** Replaces the default edit/delete buttons of a row. */
  rowActions?: (row: T) => Node[];
}

type Tab = 'skus' | 'trucks' | 'vehicles' | 'destinations' | 'rules' | 'database';

const signed = (n: number) => (n > 0 ? `+${fmt.d1(n)}` : n < 0 ? `−${fmt.d1(-n)}` : '0');

export class MasterData {
  readonly el = h('div', { class: 'master' });
  private tab: Tab = 'skus';
  private filter = '';
  private flash = '';

  constructor(private onChange: () => void) {
    admin.onChange(() => this.render());
    this.render();
  }

  render() {
    const tabs: [Tab, string][] = [
      ['skus', t.masterSkus],
      ['trucks', t.masterTrucks],
      ['vehicles', t.masterVehicles],
      ['destinations', t.masterDestinations],
      ['rules', t.masterRules],
      ['database', t.masterDatabase],
    ];
    const nav = h(
      'div',
      { class: 'seg master-tabs', role: 'tablist' },
      ...tabs.map(([id, label]) =>
        h('button', { type: 'button', role: 'tab', class: this.tab === id ? 'on' : '', 'aria-selected': String(this.tab === id), onclick: () => ((this.tab = id), (this.filter = ''), (this.flash = ''), this.render()) }, label),
      ),
    );
    let body: HTMLElement;
    if (this.tab === 'skus') body = this.entity(this.skuSpec());
    else if (this.tab === 'trucks') body = this.entity(this.truckSpec());
    else if (this.tab === 'vehicles') body = this.entity(this.vehicleSpec());
    else if (this.tab === 'destinations') body = this.entity(this.destinationSpec());
    else if (this.tab === 'rules') body = this.rules();
    else body = this.database();
    this.el.replaceChildren(this.lockBanner(), nav, body);
  }

  private get canEdit() {
    return admin.unlocked;
  }

  private lockBanner(): HTMLElement {
    if (this.canEdit)
      return h(
        'section',
        { class: 'lock-banner open' },
        h('span', { class: 'lock-icon', 'aria-hidden': 'true' }, '🔓'),
        h('div', {}, h('strong', {}, `${t.editMode}.`), ` ${t.masterModeNote} ${t.lockNote}`),
        h('button', { class: 'btn', type: 'button', onclick: () => admin.lock() }, t.lock),
      );
    return h(
      'section',
      { class: 'lock-banner' },
      h('span', { class: 'lock-icon', 'aria-hidden': 'true' }, '🔒'),
      h('div', {}, h('strong', {}, `${t.viewMode}.`), ` ${t.viewModeNote}`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => void admin.unlock() }, t.unlock),
    );
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
    const edit = spec.editable ?? this.canEdit;
    const openEditor = (r: T | null) => (spec.openEditor ? spec.openEditor(r) : this.openForm(spec, r));
    const table = h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...spec.columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)), edit ? h('th', {}, '') : null)),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {},
            ...spec.columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.value(r))),
            edit
              ? h(
                  'td',
                  { class: 'row-actions' },
                  ...(spec.rowActions
                    ? spec.rowActions(r)
                    : [
                        h('button', { class: 'btn ghost small', type: 'button', onclick: () => openEditor(r) }, t.edit),
                        h('button', { class: 'btn ghost small danger', type: 'button', onclick: async () => (await confirmDialog(t.confirmDelete, t.delete, t.cancel)) && (await spec.remove(r), this.onChange(), this.render()) }, t.delete),
                      ]),
                )
              : null,
          ),
        ),
      ),
    );
    return h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'master-toolbar' },
        h('h2', {}, spec.title),
        search,
        h('span', { class: 'muted' }, t.rows(rows.length)),
        ...(edit && spec.toolbar ? spec.toolbar() : []),
        h('button', { class: 'btn primary', type: 'button', disabled: !edit, onclick: () => openEditor(null) }, t.add),
      ),
      this.flash ? h('p', { class: 'message', role: 'status' }, this.flash) : null,
      spec.note ? h('p', { class: 'hint' }, spec.note) : null,
      h('div', { class: 'table-wrap tall' }, table),
    );
  }

  private openForm<T extends { id: number }>(spec: EntitySpec<T>, row: T | null) {
    const values = (row ?? spec.defaults ?? {}) as Record<string, unknown>;
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    const fields = spec.fields.map((f) => {
      let input: HTMLInputElement | HTMLSelectElement;
      const v = values[f.key];
      if (f.type === 'bool') input = h('input', { type: 'checkbox', checked: !!v });
      else if (f.type === 'select') input = h('select', {}, ...(f.options ?? []).map(([value, label]) => h('option', { value, selected: String(v ?? '') === value }, label)));
      else input = h('input', { type: f.type === 'number' ? 'number' : 'text', step: 'any', value: v == null ? '' : String(v), required: f.required });
      inputs.set(f.key, input);
      return h('label', { class: f.type === 'bool' ? 'check' : '', title: f.hint }, f.type === 'bool' ? [input, ` ${f.label}`] : [f.label, input]);
    });
    const extra = spec.extraForm?.(row);
    const error = h('p', { class: 'alert', hidden: true });
    const dialog = h('dialog', { class: 'form-dialog' });
    const form = h(
      'form',
      { method: 'dialog' },
      h('h3', {}, `${row ? t.edit : t.add} · ${spec.title}`),
      h('div', { class: 'form-grid' }, ...fields),
      spec.fields.some((f) => f.key.startsWith('mod_')) ? h('p', { class: 'hint' }, t.modHint) : null,
      extra?.el,
      error,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, t.cancel), h('button', { class: 'btn primary', type: 'submit' }, t.save)),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out: Record<string, unknown> = { ...(row ?? spec.defaults ?? {}), id: row?.id };
      for (const f of spec.fields) {
        const input = inputs.get(f.key)!;
        if (f.type === 'bool') out[f.key] = (input as HTMLInputElement).checked ? 1 : 0;
        else if (f.type === 'number') out[f.key] = input.value === '' ? null : Number(input.value);
        else out[f.key] = input.value.trim() === '' ? null : input.value.trim();
        if (f.required && (out[f.key] == null || out[f.key] === '')) {
          error.textContent = t.required(f.label);
          error.hidden = false;
          return;
        }
      }
      if (extra) out.__extra = extra.value();
      try {
        await spec.save(out, row);
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

  // ---------- SKUs ----------

  private skuSpec(): EntitySpec<repo.Sku> {
    const master = this.canEdit;
    const done = () => (this.onChange(), this.render());
    const hasPersonal = repo.listSkus().some((s) => s.personal);
    return {
      title: t.masterSkus,
      note: `${t.personalNote} ${t.dummyNote}`,
      editable: true,
      fields: [],
      openEditor: (row) => openSkuForm(row, done),
      columns: [
        {
          label: t.code,
          value: (r) =>
            h(
              'span',
              { class: 'mono' },
              r.code,
              r.is_dummy ? h('span', { class: 'tag' }, t.dummy) : null,
              r.personal ? h('span', { class: 'tag personal' }, r.personal === 'new' ? t.personalNew : t.personalEdited) : null,
            ),
        },
        { label: t.name, value: (r) => r.name },
        { label: t.cbox, value: (r) => h('span', { class: 'mono' }, r.cbox_code ?? '–') },
        { label: t.packaging, value: (r) => t.packagings[r.packaging] ?? r.packaging },
        { label: t.dims, value: (r) => fmt.dims(r.length_cm, r.width_cm, r.height_cm) },
        {
          label: t.boardGrade,
          value: (r) => {
            const issues = r.material_desc ? parseMaterialDescription(r.material_desc)?.issues.filter((i) => i !== 'white-kraft') ?? [] : [];
            return h('span', { title: r.material_desc ?? '' }, r.board_grade ?? '–', issues.length ? h('span', { class: 'tag warn' }, t.materialIssue) : null);
          },
        },
        { label: t.modColumn, value: (r) => (r.mod_length_cm || r.mod_width_cm || r.mod_height_cm ? `${signed(r.mod_length_cm)} / ${signed(r.mod_width_cm)} / ${signed(r.mod_height_cm)}` : '–') },
        { label: t.volume, value: (r) => fmt.d3(r.volume_m3), num: true },
        { label: t.weightKg, value: (r) => (r.weight_kg != null ? fmt.d1(r.weight_kg) : '–'), num: true },
        { label: t.safeLayers, value: (r) => fmt.int(r.safe_stack_layers), num: true },
        { label: t.topLoad, value: (r) => (r.max_top_load_kg != null ? fmt.int(r.max_top_load_kg) : '–'), num: true },
        { label: t.productGroup, value: (r) => r.product_group ?? '–' },
        { label: t.canLieDown, value: (r) => (r.can_lie_down ? t.yes : t.no) },
        { label: t.active, value: (r) => (r.active ? t.yes : h('span', { class: 'tag warn' }, t.no)) },
      ],
      list: repo.listSkus,
      save: () => undefined,
      remove: (r) => repo.deleteSku(r.id),
      rowActions: (r) => [
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => openSkuForm(r, done) }, t.edit),
        r.personal && master ? h('button', { class: 'btn ghost small', type: 'button', onclick: async () => (await repo.publishSku(r), done()) }, t.publish) : null,
        r.personal
          ? h('button', { class: 'btn ghost small danger', type: 'button', onclick: () => (discardPersonal(r.id), done()) }, r.personal === 'new' ? t.delete : t.discardPersonal)
          : master
            ? h('button', { class: 'btn ghost small danger', type: 'button', onclick: async () => (await confirmDialog(t.confirmDelete, t.delete, t.cancel)) && (await repo.deleteSku(r.id), done()) }, t.delete)
            : null,
      ].filter((x): x is HTMLButtonElement => !!x),
      searchText: (r) => `${r.code} ${r.name} ${r.product_group ?? ''} ${r.cbox_code ?? ''}`,
      toolbar: () => [
        h('button', { class: 'btn', type: 'button', onclick: () => this.importSkus() }, t.importSkus),
        hasPersonal
          ? h('button', { class: 'btn ghost danger', type: 'button', onclick: async () => (await confirmDialog(t.confirmDiscardAll, t.discardAll, t.cancel)) && (discardAllPersonal(), done()) }, t.discardAll)
          : null,
      ].filter((x): x is HTMLButtonElement => !!x),
    };
  }

  /** Paste rows copied from Excel (tab separated); SKUs with an existing SAP number are updated. */
  private importSkus() {
    const area = h('textarea', { rows: 10, class: 'paste-area mono', 'aria-label': t.importTitle, placeholder: 'DUM-101\tTisu Wajah 250 lbr\t49\t49\t40\t6,2\t5\tFacial\tkarton\ttidak\t0\t0\t1' });
    const error = h('p', { class: 'alert', hidden: true });
    const dialog = h('dialog', { class: 'form-dialog' });
    const num = (s: string | undefined) => {
      if (s == null || s.trim() === '') return null;
      // Indonesian Excel uses a decimal comma (and dots for thousands).
      const v = s.trim();
      const n = Number(v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v);
      return Number.isFinite(n) ? n : NaN;
    };
    const yes = (s: string | undefined) => /^(y|ya|yes|1|true|boleh)$/i.test((s ?? '').trim());
    const run = async () => {
      const rows: repo.SkuInput[] = [];
      let skipped = 0;
      let flagged = 0;
      const lines = area.value.split(/\r?\n/).filter((x) => x.trim());
      for (const [i, raw] of lines.entries()) {
        // SAP export: SKU, Desc, Cbox, Material Description (the size is inside the description, in mm).
        const sap = raw.includes('\t') ? raw.split('\t').map((x) => x.trim()) : [];
        if (sap.length === 4 && parseMaterialDescription(sap[3])) {
          const { issues, ...fields } = skuFromSap(sap[0], sap[1], sap[2], sap[3])!;
          const existing = repo.listMasterSkus().find((s) => s.code === fields.code) ?? null;
          if (issues.some((x) => x !== 'white-kraft')) flagged++;
          rows.push({
            ...fields,
            // Fields SAP does not have keep the values already in the database.
            weight_kg: existing?.weight_kg ?? null,
            safe_stack_layers: existing?.safe_stack_layers ?? fields.safe_stack_layers,
            max_top_load_kg: existing?.max_top_load_kg ?? null,
            can_lie_down: existing?.can_lie_down ?? 0,
            packaging: existing?.packaging ?? 'carton',
            product_group: existing?.product_group ?? fields.product_group,
            mod_length_cm: existing?.mod_length_cm ?? 0,
            mod_width_cm: existing?.mod_width_cm ?? 0,
            mod_height_cm: existing?.mod_height_cm ?? 0,
            active: existing?.active ?? 1,
          });
          continue;
        }
        const c = raw.split(raw.includes('\t') ? '\t' : ';').map((x) => x.trim());
        const [code, name, l, w, hh, kg, safe, group, pack, lie, ml, mw, mh] = c;
        const dims = [num(l), num(w), num(hh)];
        if (!code || !name || dims.some((d) => d == null || !(d > 0))) {
          // A first row without numbers is the column header copied from Excel.
          if (i > 0 || dims.some((d) => d != null && !Number.isNaN(d))) skipped++;
          continue;
        }
        const existing = repo.listMasterSkus().find((s) => s.code === code) ?? null;
        rows.push({
          ...(existing ?? {}),
          code,
          name,
          length_cm: dims[0]!,
          width_cm: dims[1]!,
          height_cm: dims[2]!,
          weight_kg: num(kg) ?? existing?.weight_kg ?? null,
          safe_stack_layers: Math.max(1, Math.round(num(safe) ?? existing?.safe_stack_layers ?? 5)),
          max_top_load_kg: existing?.max_top_load_kg ?? null,
          product_group: group || existing?.product_group || null,
          packaging: /bal|bundle/i.test(pack ?? '') ? 'bundle' : pack ? 'carton' : existing?.packaging ?? 'carton',
          can_lie_down: lie != null && lie !== '' ? (yes(lie) ? 1 : 0) : existing?.can_lie_down ?? 0,
          mod_length_cm: num(ml) ?? existing?.mod_length_cm ?? 0,
          mod_width_cm: num(mw) ?? existing?.mod_width_cm ?? 0,
          mod_height_cm: num(mh) ?? existing?.mod_height_cm ?? 0,
          active: existing?.active ?? 1,
          is_dummy: 0,
        });
      }
      if (!rows.length) {
        error.textContent = t.importResult(0, 0, skipped);
        error.hidden = false;
        return;
      }
      let added = 0;
      let updated = 0;
      if (this.canEdit) ({ added, updated } = await repo.upsertSkus(rows));
      else
        for (const r of rows) {
          // Users import into their personal layer: matching codes become personal changes.
          const mine = repo.skuByCode(r.code);
          repo.savePersonalSku({ ...r, id: mine?.id ?? (r as repo.Sku).id });
          if (mine) updated++;
          else added++;
        }
      this.flash = `${t.importResult(added, updated, skipped)}${flagged ? ` ${t.importFlagged(flagged)}` : ''}`;
      dialog.close();
      this.onChange();
      this.render();
    };
    dialog.append(
      h('h3', {}, t.importTitle),
      h('p', { class: 'hint' }, t.importHint),
      area,
      error,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, t.cancel), h('button', { class: 'btn primary', type: 'button', onclick: run }, t.importRun)),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    area.focus();
  }

  // ---------- Trucks ----------

  private truckSpec(): EntitySpec<repo.TruckType> {
    const bodyOptions = (Object.keys(t.bodyTypes) as repo.BodyType[]).map((k) => [k, t.bodyTypes[k]] as [string, string]);
    return {
      title: t.masterTrucks,
      note: t.truckEstimateNote,
      defaults: { body_type: 'box', dims_estimated: 0, is_template: 0 },
      fields: [
        { key: 'code', label: t.code, type: 'text', required: true },
        { key: 'name', label: t.name, type: 'text', required: true },
        { key: 'variant', label: t.variant, type: 'text' },
        { key: 'body_type', label: t.bodyType, type: 'select', options: bodyOptions },
        { key: 'est_volume_max', label: t.estVolumeM3, type: 'number' },
        { key: 'inner_length_cm', label: t.lengthCm, type: 'number' },
        { key: 'inner_width_cm', label: t.widthCm, type: 'number' },
        { key: 'inner_height_cm', label: t.heightCm, type: 'number' },
        { key: 'notes', label: t.notes, type: 'text' },
        { key: 'dims_estimated', label: t.dimsEstimated, type: 'bool' },
        { key: 'is_template', label: t.isTemplate, type: 'bool' },
      ],
      columns: [
        { label: t.code, value: (r) => h('span', { class: 'mono' }, r.code) },
        { label: t.name, value: (r) => h('span', {}, repo.truckLabel(r), r.is_template ? h('span', { class: 'tag' }, t.isTemplate) : null, r.dims_estimated ? h('span', { class: 'tag warn' }, t.estimated) : null) },
        { label: t.bodyType, value: (r) => t.bodyTypes[r.body_type] ?? r.body_type },
        { label: t.estVolume, value: (r) => (r.est_volume_max ? fmt.d1(r.est_volume_max) : '–'), num: true },
        { label: t.lengthCm, value: (r) => (r.inner_length_cm ? fmt.d1(r.inner_length_cm) : '–'), num: true },
        { label: t.widthCm, value: (r) => (r.inner_width_cm ? fmt.d1(r.inner_width_cm) : '–'), num: true },
        { label: t.heightCm, value: (r) => (r.inner_height_cm ? fmt.d1(r.inner_height_cm) : '–'), num: true },
        { label: t.calcVolume, value: (r) => (repo.truckVolume(r) ? fmt.d1(repo.truckVolume(r)!) : '–'), num: true },
        { label: t.notes, value: (r) => r.notes ?? '' },
      ],
      list: repo.listTrucks,
      save: (v) => repo.saveTruck(v as unknown as repo.TruckType),
      remove: (r) => repo.deleteTruck(r.id),
      searchText: (r) => `${r.code} ${r.name} ${r.variant ?? ''}`,
    };
  }

  // ---------- Vehicles (plate numbers) ----------

  private vehicleSpec(): EntitySpec<repo.Vehicle> {
    const types = repo.listTrucks();
    const typeName = new Map(types.map((x) => [x.id, repo.truckLabel(x)]));
    const used = new Map<string, number>();
    for (const r of query<{ plate_no: string; n: number }>('SELECT plate_no, COUNT(*) AS n FROM load_plans WHERE plate_no IS NOT NULL GROUP BY plate_no')) used.set(r.plate_no, r.n);
    return {
      title: t.masterVehicles,
      note: t.vehiclesNote,
      fields: [
        { key: 'plate_no', label: t.plateNo, type: 'text', required: true },
        { key: 'truck_type_id', label: t.truckType, type: 'select', options: [['', '–'], ...types.map((x) => [String(x.id), repo.truckLabel(x)] as [string, string])] },
        { key: 'inner_length_cm', label: t.lengthCm, type: 'number' },
        { key: 'inner_width_cm', label: t.widthCm, type: 'number' },
        { key: 'inner_height_cm', label: t.heightCm, type: 'number' },
        { key: 'notes', label: t.notes, type: 'text' },
      ],
      columns: [
        { label: t.plateNo, value: (r) => h('strong', { class: 'mono' }, r.plate_no) },
        { label: t.truckType, value: (r) => (r.truck_type_id != null ? typeName.get(r.truck_type_id) ?? '–' : '–') },
        { label: t.lengthCm, value: (r) => (r.inner_length_cm ? fmt.d1(r.inner_length_cm) : '–'), num: true },
        { label: t.widthCm, value: (r) => (r.inner_width_cm ? fmt.d1(r.inner_width_cm) : '–'), num: true },
        { label: t.heightCm, value: (r) => (r.inner_height_cm ? fmt.d1(r.inner_height_cm) : '–'), num: true },
        { label: t.plansCount, value: (r) => fmt.int(used.get(r.plate_no) ?? 0), num: true },
        { label: t.updated, value: (r) => (r.updated_at ?? r.created_at).slice(0, 16) },
        { label: t.notes, value: (r) => r.notes ?? '' },
      ],
      list: repo.listVehicles,
      save: (v) => repo.saveVehicle({ ...v, truck_type_id: v.truck_type_id ? Number(v.truck_type_id) : null } as Partial<repo.Vehicle>),
      remove: (r) => repo.deleteVehicle(r.id),
      searchText: (r) => `${r.plate_no} ${r.truck_type_id != null ? typeName.get(r.truck_type_id) ?? '' : ''} ${r.notes ?? ''}`,
    };
  }

  // ---------- Destinations ----------

  private destinationSpec(): EntitySpec<repo.Destination> {
    const trucks = repo.listTrucks().filter((x) => !x.is_template);
    const links = new Map<number, number[]>();
    for (const row of query<{ destination_id: number; truck_type_id: number }>('SELECT * FROM destination_trucks')) {
      const list = links.get(row.destination_id) ?? [];
      list.push(row.truck_type_id);
      links.set(row.destination_id, list);
    }
    const truckName = new Map(trucks.map((x) => [x.id, repo.truckLabel(x)]));
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
        { label: t.maxTruck, value: (r) => (repo.maxTruckFor(r.id) ? repo.truckLabel(repo.maxTruckFor(r.id)!) : h('span', { class: 'tag warn' }, '–')) },
        { label: t.listedTrucks, value: (r) => (links.get(r.id) ?? []).map((id) => truckName.get(id)).filter(Boolean).join(', ') || '–' },
      ],
      list: repo.listDestinations,
      save: (v) => repo.saveDestination(v as unknown as repo.Destination, (v.__extra as number[]) ?? []),
      remove: (r) => repo.deleteDestination(r.id),
      extraForm: (row) => {
        const selected = new Set(row ? links.get(row.id) ?? [] : []);
        const boxes = trucks.map((tr) => {
          const cb = h('input', { type: 'checkbox', value: tr.id, checked: selected.has(tr.id) });
          return { cb, el: h('label', { class: 'check' }, cb, ` ${repo.truckLabel(tr)}`) };
        });
        return {
          el: h('fieldset', { class: 'truck-checks' }, h('legend', {}, t.listedTrucks), ...boxes.map((b) => b.el)),
          value: () => boxes.filter((b) => b.cb.checked).map((b) => Number(b.cb.value)),
        };
      },
      searchText: (r) => `${r.ship_to_no ?? ''} ${r.customer} ${r.city} ${r.zone ?? ''}`,
    };
  }

  // ---------- Model rules ----------

  private rules(): HTMLElement {
    // Everyone can try rules for themselves; only the master can change the shared ones.
    const all = repo.loadRules();
    const master = this.canEdit;
    const edit = true;
    const card = (model: ModelId) => {
      const r: ModelRules = { ...all[model] };
      const check = (key: 'tiers' | 'lineOrder' | 'interlock' | 'respectSafeStack' | 'heavyBottom' | 'safetyFirst') => {
        const cb = h('input', { type: 'checkbox', checked: r[key], disabled: !edit });
        cb.addEventListener('change', () => (r[key] = cb.checked));
        return h('label', { class: 'check' }, cb, ` ${t.rule[key]}`);
      };
      const select = <K extends 'mixing' | 'rotation' | 'fillFrom'>(key: K, options: Record<ModelRules[K], string>) => {
        const sel = h('select', { disabled: !edit }, ...Object.entries(options).map(([v, label]) => h('option', { value: v, selected: r[key] === v }, label as string)));
        sel.addEventListener('change', () => (r[key] = sel.value as ModelRules[K]));
        return h('label', {}, t.rule[key], sel);
      };
      const number = (key: 'interlockMinSupport' | 'searchSeconds' | 'maxGapCm', scale: number, min: number, max: number, step: number) => {
        const input = h('input', { type: 'number', min, max, step, value: String(Math.round(r[key] * scale * 100) / 100), disabled: !edit });
        input.addEventListener('change', () => {
          const v = Math.min(max, Math.max(min, Number(input.value) || min));
          input.value = String(v);
          r[key] = v / scale;
        });
        return h('label', {}, t.rule[key], input);
      };
      const physics = (key: keyof ModelRules['physics'], min: number, max: number, step: number) => {
        const input = h('input', { type: 'number', min, max, step, value: String(r.physics[key]), disabled: !edit });
        input.addEventListener('change', () => {
          const v = Math.min(max, Math.max(min, Number(input.value.replace(',', '.')) || 0));
          input.value = String(v);
          r.physics = { ...r.physics, [key]: v };
        });
        return h('label', {}, t.physics[key], input);
      };
      const status = h('span', { class: 'muted', role: 'status' });
      return h(
        'article',
        { class: 'rule-card' },
        h('h3', {}, t.models[model], h('span', { class: 'muted' }, ` · ${t.modelTagline[model]}`), repo.hasPersonalRules(model) ? h('span', { class: 'tag personal' }, t.personalNew) : null),
        h(
          'div',
          { class: 'form-grid one' },
          check('tiers'),
          check('lineOrder'),
          check('interlock'),
          number('interlockMinSupport', 100, 30, 100, 5),
          select('mixing', t.mixingOptions),
          select('rotation', t.rotationOptions),
          check('respectSafeStack'),
          check('heavyBottom'),
          number('maxGapCm', 1, 0, 100, 1),
          check('safetyFirst'),
          select('fillFrom', t.fillFromOptions),
          number('searchSeconds', 1, 1, 30, 1),
        ),
        h(
          'details',
          { class: 'physics' },
          h('summary', {}, t.physicsTitle),
          h('p', { class: 'hint' }, t.physicsHint),
          h(
            'div',
            { class: 'form-grid' },
            physics('brakeG', 0, 2, 0.05),
            physics('accelG', 0, 2, 0.05),
            physics('sideG', 0, 2, 0.05),
            physics('bumpG', 0, 0.9, 0.05),
            physics('friction', 0, 1.5, 0.05),
            physics('slideGapCm', 0, 50, 1),
          ),
        ),
        h(
          'div',
          { class: 'actions' },
          status,
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onclick: async () => {
                personal.discardPersonalRules(model);
                if (master) await repo.saveRules(model, { ...DEFAULT_RULES[model] });
                this.flash = `${t.models[model]}: ${t.rulesSaved}`;
                this.render();
              },
            },
            t.rulesReset,
          ),
          h('button', { class: master ? 'btn' : 'btn primary', type: 'button', onclick: () => (personal.savePersonalRules(model, r), (status.textContent = `${t.savedForMe} ✓`)) }, t.saveForMe),
          master
            ? h(
                'button',
                {
                  class: 'btn primary',
                  type: 'button',
                  onclick: async () => (await repo.saveRules(model, r), personal.discardPersonalRules(model), (status.textContent = `${t.rulesSaved} ✓`)),
                },
                t.saveToDb,
              )
            : null,
        ),
      );
    };
    return h(
      'section',
      { class: 'panel' },
      h('div', { class: 'master-toolbar' }, h('h2', {}, t.rulesTitle)),
      h('p', { class: 'hint' }, t.rulesIntro),
      this.flash ? h('p', { class: 'message', role: 'status' }, this.flash) : null,
      h('div', { class: 'rule-grid' }, ...MODEL_ORDER.map(card)),
      h('details', { class: 'fixed-rules' }, h('summary', {}, t.fixedRulesTitle), h('ul', {}, ...t.fixedRules.map((x) => h('li', {}, x)))),
    );
  }

  // ---------- Database and settings ----------

  private database(): HTMLElement {
    const edit = this.canEdit;
    const message = h('p', { class: 'message', role: 'status' }, this.flash);
    const file = h('input', { type: 'file', accept: '.sqlite,.db,application/x-sqlite3', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        await importDatabase(new Uint8Array(await f.arrayBuffer()));
        this.flash = t.savedShort;
        this.onChange();
        this.render();
      } catch (err) {
        message.textContent = err instanceof Error && err.message === 'schema' ? t.importDbOld : String(err);
        message.classList.add('alert');
      }
    });
    const download = () => {
      const blob = new Blob([exportDatabase() as BlobPart], { type: 'application/x-sqlite3' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `truck-load-optimizer-${new Date().toISOString().slice(0, 10)}.sqlite` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const counts = query<{ n: string; c: number }>(
      `SELECT 'SKU' AS n, count(*) AS c FROM skus UNION ALL SELECT 'Tipe truk', count(*) FROM truck_types UNION ALL SELECT 'Nomor polisi', count(*) FROM trucks
       UNION ALL SELECT 'Shipment', count(*) FROM shipments
       UNION ALL SELECT 'Tujuan', count(*) FROM destinations UNION ALL SELECT 'Rencana', count(*) FROM load_plans`,
    );
    const company = h('input', { type: 'text', id: 'company-name', value: repo.getMeta('company_name') ?? '', placeholder: t.companyPlaceholder, disabled: !edit });
    return h(
      'section',
      { class: 'panel db-panel' },
      h('h2', {}, t.masterDatabase),
      h(
        'div',
        { class: 'form-grid narrow' },
        h('label', { for: 'company-name' }, t.companyName, company),
        edit ? h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: async () => (await repo.setMeta('company_name', company.value.trim()), (message.textContent = `${t.savedShort} ✓`)) }, t.save)) : null,
      ),
      h('p', {}, dbMode() === 'shared' ? t.dbInfoShared : t.dbInfo),
      h('ul', { class: 'db-counts' }, ...counts.map((c) => h('li', {}, h('strong', {}, fmt.int(c.c)), ` ${c.n}`))),
      message,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: download }, t.exportDb),
        h('button', { class: 'btn', type: 'button', disabled: !edit, onclick: () => file.click() }, t.importDb),
        h(
          'button',
          { class: 'btn danger', type: 'button', disabled: !edit, onclick: async () => (await confirmDialog(t.confirmReset, t.resetDb, t.cancel)) && (await resetDatabase(), admin.lock(), this.onChange(), this.render()) },
          t.resetDb,
        ),
        file,
      ),
    );
  }
}
