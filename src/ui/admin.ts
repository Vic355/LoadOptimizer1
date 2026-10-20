import { checkAdminKey, hasAdminPassword, setAdminKey } from '../db/database';
import * as repo from '../db/repo';
import { t } from '../i18n/id';
import { h } from './dom';

// Edit lock for master data and model rules. Anyone can view and plan; editing needs the admin
// password. With the shared database the server checks the password hash on every master change;
// without a server the hash lives in the browser's database and only guards against accidents.

const SESSION_KEY = 'tlo-admin-unlocked';
const listeners = new Set<() => void>();
/** The password hash for this tab's session, sent with master changes. */
let key = (() => {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
})();
// Sessions from before the shared database stored '1' instead of the hash.
if (key === '1') key = null;
setAdminKey(key);

async function hash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`truck-load-optimizer:${text}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setKey(v: string | null) {
  key = v;
  setAdminKey(v);
  try {
    if (v) sessionStorage.setItem(SESSION_KEY, v);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage may be blocked; the lock then lasts for this page only.
  }
  listeners.forEach((fn) => fn());
}

export const admin = {
  get unlocked() {
    return key != null;
  },
  onChange(fn: () => void) {
    listeners.add(fn);
  },
  lock: () => setKey(null),
  /** Asks for the password (or to create one on first use) and unlocks on success. */
  unlock(): Promise<boolean> {
    const existing = hasAdminPassword();
    return new Promise((resolve) => {
      const pw = h('input', { type: 'password', autocomplete: existing ? 'current-password' : 'new-password', required: true, id: 'admin-pw' });
      const pw2 = h('input', { type: 'password', autocomplete: 'new-password', id: 'admin-pw2' });
      const error = h('p', { class: 'alert', hidden: true });
      const dialog = h('dialog', { class: 'form-dialog narrow' });
      let ok = false;
      const form = h(
        'form',
        { method: 'dialog' },
        h('h3', {}, existing ? t.unlock : t.setPassword),
        existing ? null : h('p', { class: 'hint' }, t.setPasswordHint),
        h('div', { class: 'form-grid one' }, h('label', { for: 'admin-pw' }, t.adminPassword, pw), existing ? null : h('label', { for: 'admin-pw2' }, t.confirmPassword, pw2)),
        h('p', { class: 'hint' }, t.lockNote),
        error,
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, t.cancel), h('button', { class: 'btn primary', type: 'submit' }, t.unlock)),
      );
      const fail = (msg: string) => {
        error.textContent = msg;
        error.hidden = false;
      };
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const hashed = await hash(pw.value);
        if (!existing) {
          if (pw.value.length < 4) return fail(t.passwordTooShort);
          if (pw.value !== pw2.value) return fail(t.passwordMismatch);
          await repo.setMeta('admin_hash', hashed);
        } else if (!(await checkAdminKey(hashed))) return fail(t.wrongPassword);
        ok = true;
        setKey(hashed);
        dialog.close();
      });
      dialog.append(form);
      dialog.addEventListener('close', () => {
        dialog.remove();
        resolve(ok);
      });
      document.body.append(dialog);
      dialog.showModal();
      pw.focus();
    });
  },
};
