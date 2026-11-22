import { CONFIG, isConfigured } from './config.js';
import { sb } from './core/supabase.js';
import { state } from './core/state.js';
import { h } from './core/dom.js';
import { route, startRouter, navigate, render } from './core/router.js';
import { initShell, startRealtime } from './core/shell.js';
import { applyTheme, themePref, loadProfile, enforceBan, initLangFromEnv } from './core/auth.js';
import { initRipple } from './core/ui.js';
import { t } from './i18n/index.js';

function setupRoutes() {
  const page = (name) => () => import(`./pages/${name}.js`);
  route('/', page('feed'), { auth: true });
  route('/login', page('auth'), { guest: true, layout: 'plain', full: true });
  route('/signup', page('auth'), { guest: true, layout: 'plain', full: true });
  route('/setup', page('setup'), { auth: true, layout: 'plain' });
  route('/new', page('compose'), { auth: true, wide: true });
  route('/post/:id/edit', page('compose'), { auth: true, wide: true });
  route('/post/:id', page('post'), { auth: true, wide: true });
  route('/archive', page('archive'), { auth: true, wide: true });
  route('/u/:username', page('profile'), { auth: true });
  route('/settings', page('settings'), { auth: true });
  route('/search', page('search'), { auth: true });
  route('/notifications', page('notifications'), { auth: true });
  route('/privacy', page('privacy'), { layout: 'plain' });
  route('/banned', page('banned'), { layout: 'plain' });
}

function setupMissing() {
  return {
    default: async () => ({
      title: 'NXTCORE',
      el: h('div', { class: 'setup-missing' },
        h('h1', null, 'NXTCORE: нужно подключить Supabase'),
        h('p', null, 'Откройте файл ', h('code', null, 'js/config.js'), ' и впишите адрес проекта и публичный anon-ключ. Шаги подробно описаны в ', h('code', null, 'docs/SETUP.md'), '.'),
        h('p', { class: 'muted' }, 'Секретные ключи в этот файл класть не нужно.')),
    }),
  };
}

async function boot() {
  initRipple();
  initLangFromEnv();
  applyTheme(themePref());
  initShell();
  setupRoutes();

  if (!isConfigured()) {
    // без Supabase работает только политика конфиденциальности
    route('/(.*)', () => Promise.resolve(setupMissing()), { layout: 'plain' });
    return startRouter();
  }

  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (state.session) {
    const p = await loadProfile();
    if (await enforceBan(p)) history.replaceState({}, '', '/banned');
  }

  sb.auth.onAuthStateChange((event, session) => {
    state.session = session;
    // не вызываем методы supabase внутри колбэка: выносим в следующий такт
    setTimeout(async () => {
      if (event === 'SIGNED_IN' && session && !state.profile) {
        const p = await loadProfile();
        if (await enforceBan(p)) return navigate('/banned', { replace: true });
        startRealtime();
        if (['/login', '/signup'].includes(location.pathname)) render();
      }
      if (event === 'SIGNED_OUT') { state.profile = null; }
    }, 0);
  });

  await startRouter();
  startRealtime();
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = t('err.page_text');
});
export { CONFIG };
