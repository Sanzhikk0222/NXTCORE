// Маршрутизатор на History API. Страница: async (ctx) => { el, destroy?, title? }
import { state, isAuthed } from './state.js';
import { clear } from './dom.js';
import { t } from '../i18n/index.js';
import { reveal } from './ui.js';

const routes = [];
let current = null;
let token = 0;
let shellApi = null;

export function route(pattern, load, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
  routes.push({ re, keys, load, opts });
}

export function setShell(api) { shellApi = api; }

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return render();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  return render();
}

export async function render() {
  const my = ++token;
  const url = new URL(location.href);
  const hit = match(url.pathname);
  const { route: r, params } = hit || {};

  if (!r) return mountNotFound();
  const { auth, guest } = r.opts;
  if (auth && !isAuthed()) return navigate('/login?next=' + encodeURIComponent(url.pathname + url.search), { replace: true });
  if (guest && isAuthed()) {
    const p = state.profile;
    return navigate(p?.needs_setup || !p?.privacy_accepted_at ? '/setup' : '/', { replace: true });
  }
  if (auth && isAuthed() && (state.profile.needs_setup || !state.profile.privacy_accepted_at) && url.pathname !== '/setup') {
    return navigate('/setup', { replace: true });
  }

  const view = shellApi.mount(r.opts.layout || 'app', url.pathname);
  current?.destroy?.();
  current = null;
  clear(view);
  view.className = r.opts.wide ? 'wide' : r.opts.layout === 'plain' && !r.opts.full ? 'plain-main' : '';
  const query = Object.fromEntries(url.searchParams);
  try {
    const mod = await r.load();
    const page = await mod.default({ params, query, navigate });
    if (my !== token) { page?.destroy?.(); return; }
    clear(view);
    view.append(page.el);
    current = page;
    document.title = (page.title ? page.title + ' · ' : '') + 'NXTCORE';
    reveal(view);
    window.scrollTo({ top: 0 });
    view.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    if (my !== token) return;
    const { h } = await import('./dom.js');
    clear(view);
    view.append(h('div', { class: 'empty' }, h('h2', null, t('err.page_title')), h('p', null, t('err.page_text')),
      h('button', { class: 'btn', onclick: () => render() }, t('common.retry'))));
  }
}

function match(path) {
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

async function mountNotFound() {
  const { h } = await import('./dom.js');
  const view = shellApi.mount(isAuthed() ? 'app' : 'plain', location.pathname);
  clear(view);
  view.className = '';
  view.append(h('div', { class: 'empty' }, h('h2', null, t('err.404_title')), h('p', null, t('err.404_text')),
    h('a', { class: 'btn', href: '/', 'data-link': '' }, t('nav.feed'))));
  document.title = '404 · NXTCORE';
}

export function startRouter() {
  addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//')) return;
    e.preventDefault();
    navigate(href);
  });
  return render();
}
