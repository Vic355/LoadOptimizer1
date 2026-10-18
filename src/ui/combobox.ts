import { debounce, h } from './dom';
import { t } from '../i18n/id';

export interface ComboboxOptions<T> {
  placeholder: string;
  search: (text: string) => T[];
  render: (item: T) => Node;
  onPick: (item: T) => void;
  /** Keep the typed text after picking (false clears the input, e.g. for adding SKU lines). */
  keepText?: (item: T) => string | null;
  id?: string;
}

/** Search-as-you-type input with a keyboard-navigable result list. */
export function combobox<T>(opts: ComboboxOptions<T>) {
  const input = h('input', { type: 'search', placeholder: opts.placeholder, autocomplete: 'off', id: opts.id, role: 'combobox', 'aria-expanded': 'false' });
  const list = h('ul', { class: 'combo-list', role: 'listbox', hidden: true });
  const wrap = h('div', { class: 'combo' }, input, list);
  let items: T[] = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const pick = (i: number) => {
    const item = items[i];
    if (!item) return;
    opts.onPick(item);
    input.value = opts.keepText?.(item) ?? '';
    close();
  };
  const paint = () => {
    list.replaceChildren(
      ...(items.length
        ? items.map((item, i) =>
            h(
              'li',
              { role: 'option', class: i === active ? 'active' : '', onmousedown: (e: Event) => (e.preventDefault(), pick(i)) },
              opts.render(item),
            ),
          )
        : [h('li', { class: 'empty' }, t.noResults)]),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const refresh = debounce(() => {
    items = opts.search(input.value);
    active = items.length ? 0 : -1;
    paint();
  }, 80);

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') active = Math.min(items.length - 1, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
      return;
    } else if (e.key === 'Escape') return close();
    else return;
    e.preventDefault();
    paint();
  });

  return { el: wrap, input, setText: (s: string) => (input.value = s) };
}
