import './styles.css';
import { openDatabase } from './db/database';
import { t } from './i18n/id';
import { h } from './ui/dom';
import { Planner } from './ui/planner';
import { MasterData } from './ui/master';

type Page = 'planner' | 'master';

async function boot() {
  const app = document.getElementById('app')!;
  app.replaceChildren(h('p', { class: 'boot' }, t.loadingDb));
  await openDatabase();

  const planner = new Planner();
  const master = new MasterData(() => planner.reloadTrucks());
  let page: Page = 'planner';

  const nav = h('nav', { class: 'seg main-nav' });
  const main = h('main', {});
  const show = (p: Page) => {
    page = p;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.page === p));
    if (p === 'master') master.render();
    main.replaceChildren(p === 'planner' ? planner.el : master.el);
    if (p === 'planner') planner.mount3d();
  };
  for (const [p, label] of [
    ['planner', t.navPlanner],
    ['master', t.navMaster],
  ] as [Page, string][]) {
    const b = h('button', { type: 'button', onclick: () => show(p) }, label);
    b.dataset.page = p;
    nav.append(b);
  }

  app.replaceChildren(
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, '▣'), h('div', {}, h('h1', {}, t.appTitle), h('p', {}, t.appSubtitle)), h('span', { class: 'tag soon' }, t.prototype)),
      nav,
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
