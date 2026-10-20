import { t } from '../i18n/id';
import { h } from './dom';

// "Tanya AI" side panel: questions go to /api/ask (src/server/assistant.ts), which answers from
// public/app-guide.md. The panel sends only the question, the recent conversation and the page
// name; it never sends the user's data.

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

const CLIENT_KEY = 'tlo-ai-client';

/** A random id per browser, so colleagues behind one office IP each get their own daily questions. */
function clientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) localStorage.setItem(CLIENT_KEY, (id = crypto.randomUUID()));
    return id;
  } catch {
    return '';
  }
}

/** The model writes light Markdown; show it as plain text. */
const plain = (text: string) =>
  text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/`([^`]+)`/g, '$1');

export function assistantButton(currentPage: () => string): HTMLButtonElement {
  const history: Turn[] = [];
  const log = h('div', { class: 'ask-log', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 2, maxlength: 800, placeholder: t.askPlaceholder, 'aria-label': t.askPlaceholder });
  const send = h('button', { class: 'btn primary', type: 'submit' }, t.askSend);
  const status = h('p', { class: 'hint' }, t.askNote);
  const panel = h(
    'aside',
    { class: 'ask-panel', hidden: true, 'aria-label': t.askTitle },
    h('div', { class: 'ask-head' }, h('h3', {}, '✦ ', t.askTitle), h('button', { class: 'icon', type: 'button', title: t.close, 'aria-label': t.close, onclick: () => toggle(false) }, '✕')),
    log,
    h('form', { class: 'ask-form', onsubmit: (e: Event) => (e.preventDefault(), void submit(input.value)) }, input, send),
    status,
    h('a', { class: 'hint', href: './app-guide.md', target: '_blank', rel: 'noopener' }, t.askGuide),
  );

  const bubble = (role: Turn['role'] | 'error', text: string) => {
    const el = h('div', { class: `ask-msg ${role}` }, text);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };
  log.append(
    h('p', { class: 'hint' }, t.askIntro),
    h('div', { class: 'ask-examples' }, ...t.askExamples.map((q) => h('button', { class: 'btn small', type: 'button', onclick: () => void submit(q) }, q))),
  );

  let busy = false;
  async function submit(raw: string) {
    const question = raw.trim();
    if (!question || busy) return;
    busy = true;
    send.disabled = true;
    input.value = '';
    log.querySelector('.ask-examples')?.remove();
    bubble('user', question);
    const pending = bubble('assistant', t.askThinking);
    pending.classList.add('pending');
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': clientId() },
        body: JSON.stringify({ question, history: history.slice(-6), page: currentPage() }),
      });
      if (!res.ok) throw new Error(res.status === 429 ? t.askLimit : res.status === 404 || res.status === 405 || res.status === 503 ? t.askOffline : t.askFailed);
      const { answer, remaining } = (await res.json()) as { answer: string; remaining: number };
      pending.textContent = plain(answer);
      pending.classList.remove('pending');
      history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      status.textContent = `${t.askNote} ${t.askRemaining(remaining)}.`;
    } catch (err) {
      pending.remove();
      // A page without the Worker (local dev, static host) has no /api and answers with HTML or a network error.
      const message = err instanceof Error ? err.message : '';
      bubble('error', [t.askLimit, t.askFailed].includes(message) ? message : t.askOffline);
    } finally {
      busy = false;
      send.disabled = false;
      input.focus();
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit(input.value);
    }
  });

  const button = h('button', { class: 'icon-btn', type: 'button', title: t.askTitle, 'aria-expanded': 'false' }, `✦ ${t.askAi}`);
  const toggle = (open = panel.hidden) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  };
  button.addEventListener('click', () => toggle());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) toggle(false);
  });
  document.body.append(panel);
  return button;
}
