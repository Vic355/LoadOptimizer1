import * as repo from '../db/repo';
import type { Sku, SkuInput } from '../db/repo';
import { t } from '../i18n/id';
import { admin } from './admin';
import { h } from './dom';

type Kind = 'text' | 'number' | 'bool' | 'select';
const FIELDS: { key: keyof SkuInput; label: string; type: Kind; required?: boolean }[] = [
  { key: 'code', label: t.code, type: 'text', required: true },
  { key: 'name', label: t.name, type: 'text', required: true },
  { key: 'length_cm', label: t.lengthCm, type: 'number', required: true },
  { key: 'width_cm', label: t.widthCm, type: 'number', required: true },
  { key: 'height_cm', label: t.heightCm, type: 'number', required: true },
  { key: 'mod_length_cm', label: t.modLength, type: 'number' },
  { key: 'mod_width_cm', label: t.modWidth, type: 'number' },
  { key: 'mod_height_cm', label: t.modHeight, type: 'number' },
  { key: 'weight_kg', label: t.weightKg, type: 'number' },
  { key: 'safe_stack_layers', label: t.safeLayers, type: 'number', required: true },
  { key: 'max_top_load_kg', label: t.topLoad, type: 'number' },
  { key: 'product_group', label: t.productGroup, type: 'text' },
  { key: 'packaging', label: t.packaging, type: 'select' },
  { key: 'can_lie_down', label: t.canLieDown, type: 'bool' },
  { key: 'active', label: t.active, type: 'bool' },
];

const DEFAULTS: Partial<SkuInput> = { mod_length_cm: 0, mod_width_cm: 0, mod_height_cm: 0, safe_stack_layers: 5, packaging: 'carton', active: 1, can_lie_down: 0, is_dummy: 0 };

/**
 * Adds or changes a SKU. Everyone can save a personal version that only the calculator on this
 * device uses; the master role can also write it to the shared database.
 */
export function openSkuForm(sku: Sku | null, onSaved: (saved: Sku) => void) {
  const values = { ...DEFAULTS, ...(sku ?? {}) } as Record<string, unknown>;
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const fields = FIELDS.map((f) => {
    const v = values[f.key];
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === 'bool') input = h('input', { type: 'checkbox', checked: !!v });
    else if (f.type === 'select')
      input = h('select', {}, ...(['carton', 'bundle'] as const).map((p) => h('option', { value: p, selected: v === p }, t.packagings[p])));
    else input = h('input', { type: f.type, step: 'any', value: v == null ? '' : String(v), required: f.required });
    inputs.set(f.key, input);
    return h('label', { class: f.type === 'bool' ? 'check' : '' }, f.type === 'bool' ? [input, ` ${f.label}`] : [f.label, input]);
  });
  const error = h('p', { class: 'alert', hidden: true });
  const dialog = h('dialog', { class: 'form-dialog' });
  const master = admin.unlocked;

  const read = (): SkuInput | null => {
    const out: Record<string, unknown> = { ...values };
    for (const f of FIELDS) {
      const input = inputs.get(f.key)!;
      if (f.type === 'bool') out[f.key] = (input as HTMLInputElement).checked ? 1 : 0;
      else if (f.type === 'number') out[f.key] = input.value === '' ? (f.key.startsWith('mod_') ? 0 : null) : Number(input.value.replace(',', '.'));
      else out[f.key] = input.value.trim() === '' ? null : input.value.trim();
      if (f.required && (out[f.key] == null || out[f.key] === '' || Number.isNaN(out[f.key]))) {
        error.textContent = t.required(f.label);
        error.hidden = false;
        return null;
      }
    }
    delete out.volume_m3;
    delete out.personal;
    return out as unknown as SkuInput;
  };
  const finish = (id: number) => {
    dialog.close();
    const saved = repo.listSkus().find((s) => s.id === id);
    if (saved) onSaved(saved);
  };
  const savePersonal = () => {
    const v = read();
    if (v) finish(repo.savePersonalSku({ ...v, id: sku?.id }));
  };
  const saveMaster = async () => {
    const v = read();
    if (!v) return;
    const base: Sku = { ...(v as Sku), id: sku?.id ?? 0, personal: sku?.personal ?? (sku ? 'edited' : 'new'), volume_m3: 0 };
    finish(await repo.publishSku(base));
  };

  dialog.append(
    h(
      'form',
      { method: 'dialog', onsubmit: (e: Event) => (e.preventDefault(), savePersonal()) },
      h('h3', {}, sku ? `${t.edit} · ${sku.code}` : t.newSku),
      h('p', { class: 'hint' }, master ? t.skuFormMasterHint : t.skuFormHint),
      h('div', { class: 'form-grid' }, ...fields),
      h('p', { class: 'hint' }, t.modHint),
      error,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, t.cancel),
        h('button', { class: master ? 'btn' : 'btn primary', type: 'submit' }, t.saveForMe),
        master ? h('button', { class: 'btn primary', type: 'button', onclick: saveMaster }, t.saveToDb) : null,
      ),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  (inputs.get(sku ? 'length_cm' : 'code') as HTMLInputElement).focus();
}
