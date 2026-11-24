import { currentLang, setLang, t, LANGS, type Lang } from '../i18n/id';
import { h } from './dom';
import { currentTheme, toggleTheme } from './theme';

/**
 * Settings dialog: language and appearance, remembered in this browser. Changing the language
 * reloads the page, since every screen is built with the chosen language's text.
 */
export function openSettings() {
  const dialog = h('dialog', { class: 'form-dialog narrow settings' });
  const lang = h('select', { id: 'set-lang' }, ...(Object.keys(LANGS) as Lang[]).map((l) => h('option', { value: l, selected: l === currentLang() }, t.languageNames[l])));
  lang.addEventListener('change', () => {
    setLang(lang.value as Lang);
    location.reload();
  });
  const theme = h(
    'select',
    { id: 'set-theme' },
    h('option', { value: 'light', selected: currentTheme() === 'light' }, t.themeLightOption),
    h('option', { value: 'dark', selected: currentTheme() === 'dark' }, t.themeDarkOption),
  );
  theme.addEventListener('change', () => {
    if (theme.value !== currentTheme()) toggleTheme();
  });
  dialog.append(
    h('h3', {}, t.settings),
    h('div', { class: 'form-grid one' }, h('label', { for: 'set-lang' }, t.language, lang), h('p', { class: 'hint' }, t.languageHint), h('label', { for: 'set-theme' }, t.themeLabel, theme)),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => dialog.close() }, t.close)),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  lang.focus();
}
