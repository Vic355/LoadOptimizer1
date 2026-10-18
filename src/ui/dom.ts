type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | number | null | undefined | false;

/** Tiny element builder: h('div', { class: 'x', onclick: fn }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: (Node | string)[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

const nf = new Intl.NumberFormat('id-ID');
const nf1 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });

export const fmt = {
  int: (n: number) => nf.format(Math.round(n)),
  d1: (n: number) => nf1.format(n),
  d2: (n: number) => nf2.format(n),
  d3: (n: number) => nf3.format(n),
  pct: (r: number) => `${nf1.format(r * 100)}%`,
  m: (cm: number) => `${nf2.format(cm / 100)} m`,
  dims: (l?: number | null, w?: number | null, hh?: number | null) => (l && w && hh ? `${nf.format(l)} × ${nf.format(w)} × ${nf.format(hh)}` : '–'),
};

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** In-page confirmation (native confirm() is blocked in some embedded viewers). */
export function confirmDialog(message: string, okLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'form-dialog confirm' });
    const done = (v: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(v);
    };
    dialog.append(
      h('p', {}, message),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, cancelLabel), h('button', { class: 'btn primary danger-fill', type: 'button', onclick: () => done(true) }, okLabel)),
    );
    dialog.addEventListener('cancel', () => done(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}
