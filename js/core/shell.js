// Каркас: шапка, боковая панель, нижние вкладки. Для страниц входа, политики и блокировки каркас упрощён.
import { h, clear, debounce } from './dom.js';
import { icon } from './icons.js';
import { state, on, isAuthed } from './state.js';
import { t, getLang, setLang, LANGS } from '../i18n/index.js';
import { navigate, setShell } from './router.js';
import { applyTheme, themePref, signOut } from './auth.js';
import { avatar, popMenu } from './ui.js';
import { sb } from './supabase.js';
import { rpc } from './api.js';

let mode = null;
let viewEl = null;
let navEls = [];
let badgeEls = [];
let unsubRealtime = null;
let pollTimer = null;

const logoMark = () => h('span', { class: 'logo-mark' }, icon('logo', 16, ''));
const logo = (href = '/') => h('a', { class: 'logo', href, 'aria-label': 'NXTCORE' }, logoMark(), h('span', { class: 'word' }, 'NXTCORE'));

function themeButton() {
  const b = h('button', { class: 'iconbtn', 'aria-label': t('nav.theme'), title: t('nav.theme') });
  const paint = () => { b.replaceChildren(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')); };
  b.addEventListener('click', () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); paint(); });
  paint();
  return b;
}

function langSwitch() {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': t('settings.language') },
    ...LANGS.map(([code, label]) => h('button', { type: 'button', 'aria-pressed': String(getLang() === code), onclick: () => { setLang(code); location.reload(); } }, code.toUpperCase())));
  return seg;
}

function buildPlain() {
  clear(app());
  const header = h('header', { class: 'plain-header' }, logo('/'), h('div', { class: 'row' }, langSwitch(), themeButton()));
  viewEl = h('main', { id: 'view', tabindex: '-1', class: 'plain-main' });
  app().append(header, viewEl);
  navEls = []; badgeEls = [];
}

function buildApp() {
  clear(app());
  const me = state.profile;
  const search = h('input', { type: 'search', placeholder: t('search.placeholder'), 'aria-label': t('search.placeholder'), autocomplete: 'off', maxlength: '60' });
  const go = debounce(() => { const q = search.value.trim(); if (q.length >= 2) navigate('/search?q=' + encodeURIComponent(q), { replace: location.pathname === '/search' }); }, 350);
  search.addEventListener('input', go);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { go.cancel(); const q = search.value.trim(); if (q) navigate('/search?q=' + encodeURIComponent(q)); } });

  const bell = h('a', { class: 'iconbtn', href: '/notifications', 'aria-label': t('nav.notifications') }, icon('bell'));
  const badge = h('span', { class: 'badge hidden', 'aria-hidden': 'true' }, '0');
  bell.append(badge);

  const profileWrap = h('div', { class: 'rel' });
  const pbtn = h('button', { class: 'iconbtn', style: { width: '44px' }, 'aria-label': t('nav.profile_menu'), 'aria-haspopup': 'menu' }, avatar(me, 's'));
  pbtn.addEventListener('click', () => popMenu(profileWrap, [
    { label: t('nav.profile'), icon: 'user', onClick: () => navigate('/u/' + me.username) },
    { label: t('nav.settings'), icon: 'settings', onClick: () => navigate('/settings') },
    '-',
    { label: t('nav.logout'), icon: 'logout', onClick: async () => { await signOut(); navigate('/login', { replace: true }); } },
  ]));
  profileWrap.append(pbtn);

  const header = h('header', { class: 'header' },
    logo('/'),
    h('div', { class: 'header-search' }, icon('search', 18), search),
    h('div', { class: 'header-actions' }, bell, themeButton(), profileWrap));

  const link = (href, ic, label, extra = {}) => h('a', { class: 'nav-link', href, 'data-nav': href, ...extra }, icon(ic), h('span', { class: 't' }, label));
  const sidebar = h('nav', { class: 'sidebar', 'aria-label': t('nav.main') },
    h('a', { class: 'btn', href: '/new' }, icon('plus', 20), h('span', { class: 't' }, t('nav.new'))),
    link('/', 'home', t('nav.feed')),
    link('/archive', 'folder', t('nav.archive')),
    link('/u/' + me.username, 'user', t('nav.profile')),
    link('/settings', 'settings', t('nav.settings')),
    h('div', { class: 'sidebar-foot' }, h('a', { href: '/privacy' }, t('nav.privacy'))));

  const tab = (href, ic, label, cls = '') => h('a', { class: `tab ${cls}`, href, 'data-nav': href }, cls ? h('span', { class: 'plus' }, icon(ic, 24)) : icon(ic), cls ? h('span', { class: 'sr' }, label) : label);
  const tabs = h('nav', { class: 'tabs', 'aria-label': t('nav.main') },
    tab('/', 'home', t('nav.feed')), tab('/archive', 'folder', t('nav.archive')), tab('/new', 'plus', t('nav.new'), 'tab-new'),
    tab('/search', 'search', t('nav.search')), tab('/u/' + me.username, 'user', t('nav.profile')));

  viewEl = h('main', { id: 'view', tabindex: '-1' });
  app().append(header, h('div', { class: 'shell' }, sidebar, viewEl), tabs);
  navEls = [...app().querySelectorAll('[data-nav]')];
  badgeEls = [badge];
  paintBadge();
}

const app = () => document.getElementById('app');

function paintNav(path) {
  for (const a of navEls) {
    const href = a.dataset.nav;
    const on = href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function paintBadge() {
  const n = state.unread;
  for (const b of badgeEls) { b.textContent = n > 99 ? '99+' : String(n); b.classList.toggle('hidden', !n); }
}

export async function refreshUnread() {
  if (!isAuthed()) return;
  try { state.unread = Number(await rpc('unread_count')) || 0; paintBadge(); } catch { /* сеть */ }
}

function startRealtime() {
  stopRealtime();
  if (!isAuthed()) return;
  refreshUnread();
  try {
    const ch = sb.channel('nx-notes-' + state.profile.id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${state.profile.id}` }, () => refreshUnread())
      .subscribe();
    unsubRealtime = () => sb.removeChannel(ch);
  } catch { /* realtime необязателен */ }
  pollTimer = setInterval(refreshUnread, 90_000);
}
function stopRealtime() { unsubRealtime?.(); unsubRealtime = null; clearInterval(pollTimer); }

export function initShell() {
  setShell({
    mount(layout, path) {
      const want = layout === 'app' && isAuthed() ? 'app' : 'plain';
      if (mode !== want || !viewEl?.isConnected) {
        mode = want;
        if (want === 'app') buildApp(); else buildPlain();
      }
      paintNav(path);
      return viewEl;
    },
  });
  on('profile', () => { mode = null; startRealtime(); });
  on('unread', paintBadge);
}
export { startRealtime, paintBadge };
