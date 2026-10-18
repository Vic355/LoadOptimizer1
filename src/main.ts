import './styles.css';
import { openDatabase } from './db/database';
import { t } from './i18n/id';
import { h } from './ui/dom';
import { Planner } from './ui/planner';
import { MasterData } from './ui/master';
import { History } from './ui/history';
import { admin } from './ui/admin';
import { applyTheme, currentTheme, onThemeChange, toggleTheme } from './ui/theme';

type Page = 'planner' | 'history' | 'master';

async function boot() {
  applyTheme();
  const app = document.getElementById('app')!;
  app.replaceChildren(h('p', { class: 'boot' }, t.loadingDb));
  await openDatabase();

  const planner = new Planner(() => history.render());
  const history = new History((saved) => {
    show('planner');
    planner.loadSaved(saved);
  });
  const master = new MasterData(() => planner.reloadTrucks());
  let page: Page = 'planner';

  const nav = h('nav', { class: 'main-nav', 'aria-label': t.appTitle });
  const main = h('main', {});
  const show = (p: Page) => {
    page = p;
    nav.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.page === p);
      b.setAttribute('aria-current', b.dataset.page === p ? 'page' : 'false');
    });
    if (p === 'master') master.render();
    if (p === 'history') history.render();
    main.replaceChildren(p === 'planner' ? planner.el : p === 'history' ? history.el : master.el);
    if (p === 'planner') planner.mount3d();
  };
  for (const [p, label] of [
    ['planner', t.navPlanner],
    ['history', t.navHistory],
    ['master', t.navMaster],
  ] as [Page, string][]) {
    const b = h('button', { type: 'button', onclick: () => show(p) }, label);
    b.dataset.page = p;
    nav.append(b);
  }

  const themeBtn = h('button', { class: 'icon-btn', type: 'button' });
  const renderThemeBtn = () => {
    const dark = currentTheme() === 'dark';
    themeBtn.textContent = dark ? '☀' : '☾';
    themeBtn.title = dark ? t.themeLight : t.themeDark;
    themeBtn.setAttribute('aria-label', themeBtn.title);
  };
  themeBtn.addEventListener('click', () => toggleTheme());
  onThemeChange(() => {
    renderThemeBtn();
    planner.refreshTheme();
  });
  renderThemeBtn();

  const lockBtn = h('button', { class: 'icon-btn lock', type: 'button' });
  const renderLock = () => {
    lockBtn.textContent = admin.unlocked ? `🔓 ${t.editMode}` : `🔒 ${t.viewMode}`;
    lockBtn.title = admin.unlocked ? t.lock : t.unlock;
  };
  lockBtn.addEventListener('click', () => (admin.unlocked ? admin.lock() : void admin.unlock()));
  admin.onChange(renderLock);
  renderLock();

  app.replaceChildren(
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, '▣'), h('div', {}, h('h1', {}, t.appTitle), h('p', {}, t.appSubtitle)), h('span', { class: 'tag soon' }, t.prototype)),
      nav,
      h('div', { class: 'top-actions' }, lockBtn, themeBtn),
    ),
    main,
  );
  show(page);
  // First visit: show a worked example so the 3D view is not empty.
  planner.loadExample();
}

boot().catch((err) => {
  document.getElementById('app')!.replaceChildren(h('pre', { class: 'alert' }, String(err?.stack ?? err)));
});
