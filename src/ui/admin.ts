import * as repo from '../db/repo';
import { t } from '../i18n/id';
import { h } from './dom';

// Edit lock for master data and model rules. Anyone can view and plan; editing needs the admin
// password. The hash lives in the database, so this guards against accidental edits in the
// prototype, not against a determined user (that needs the server step).

const SESSION_KEY = 'tlo-admin-unlocked';
const listeners = new Set<() => void>();
let unlocked = (() => {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
})();

async function hash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`truck-load-optimizer:${text}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setUnlocked(v: boolean) {
  unlocked = v;
  try {
    if (v) sessionStorage.setItem(SESSION_KEY, '1');
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage may be blocked; the lock then lasts for this page only.
  }
  listeners.forEach((fn) => fn());
}

export const admin = {
  get unlocked() {
    return unlocked;
  },
  onChange(fn: () => void) {
    listeners.add(fn);
  },
  lock: () => setUnlocked(false),
  /** Asks for the password (or to create one on first use) and unlocks on success. */
  unlock(): Promise<boolean> {
    const existing = repo.getMeta('admin_hash');
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
        if (!existing) {
          if (pw.value.length < 4) return fail(t.passwordTooShort);
          if (pw.value !== pw2.value) return fail(t.passwordMismatch);
          repo.setMeta('admin_hash', await hash(pw.value));
        } else if ((await hash(pw.value)) !== existing) return fail(t.wrongPassword);
        ok = true;
        setUnlocked(true);
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
