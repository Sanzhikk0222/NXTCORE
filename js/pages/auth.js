import { h, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { sb } from '../core/supabase.js';
import { state } from '../core/state.js';
import { rpc } from '../core/api.js';
import { loadProfile, enforceBan } from '../core/auth.js';
import { toast, field, setHint } from '../core/ui.js';
import { t } from '../i18n/index.js';
import { checkUsername } from '../moderation/text.js';
import { startDemo } from './demo.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const googleMark = () => {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('aria-hidden', 'true');
  for (const [d, f] of [
    ['M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z', '#4285F4'],
    ['M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.2 1-3.8 1-2.9 0-5.4-2-6.3-4.6H2.1v2.8A11 11 0 0 0 12 23z', '#34A853'],
    ['M5.7 14c-.2-.7-.4-1.3-.4-2s.1-1.4.4-2V7.2H2.1a11 11 0 0 0 0 9.6z', '#FBBC05'],
    ['M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 0 0 2.1 7.2L5.7 10c.9-2.6 3.4-4.6 6.3-4.6z', '#EA4335'],
  ]) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', f); s.append(p); }
  return s;
};

export default async function page({ navigate, query }) {
  const signup = location.pathname === '/signup';
  const next = query.next && query.next.startsWith('/') && !query.next.startsWith('//') ? query.next : '/';

  const email = field({ label: t('auth.email'), id: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: '120' });
  const pass = field({ label: t('auth.password'), id: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, maxlength: '72', hint: signup ? t('auth.password_hint') : '' });
  const user = field({ label: t('auth.username'), id: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: '20', hint: t('auth.username_hint') });
  const agree = h('input', { type: 'checkbox', id: 'agree', required: true });
  const submit = h('button', { class: 'btn block', type: 'submit' }, signup ? t('auth.signup_btn') : t('auth.login_btn'));
  const note = h('div', { class: 'notice hidden', role: 'status' });
  if (signup) submit.disabled = true;

  // ---- ник: сначала быстрая проверка в браузере, потом спрашиваем базу
  let nameOk = false, seq = 0;
  const askDb = debounce(async (name, my) => {
    try {
      const r = await rpc('username_status', { p_username: name });
      if (my !== seq) return;
      if (r.available) { nameOk = true; setHint(user.hintEl, t('auth.username_free'), 'ok'); user.el.removeAttribute('aria-invalid'); }
      else { nameOk = false; setHint(user.hintEl, r.code === 'taken' ? t('auth.username_taken') : t('err.username_bad'), 'bad'); user.el.setAttribute('aria-invalid', 'true'); }
    } catch { if (my === seq) setHint(user.hintEl, t('auth.username_hint')); }
    refresh();
  }, 380);
  user.el.addEventListener('input', () => {
    const name = user.el.value.trim().toLowerCase();
    const my = ++seq;
    nameOk = false;
    if (!name) { setHint(user.hintEl, t('auth.username_hint')); return refresh(); }
    const local = checkUsername(name);
    if (!local.ok) {
      setHint(user.hintEl, local.code === 'format' ? t('auth.username_format') : t('err.username_bad'), 'bad');
      user.el.setAttribute('aria-invalid', 'true');
      return refresh();
    }
    setHint(user.hintEl, t('auth.username_checking'));
    askDb(name, my);
    refresh();
  });
  agree.addEventListener('change', refresh);
  function refresh() { if (signup) submit.disabled = !(agree.checked && nameOk); }

  async function onSubmit(e) {
    e.preventDefault();
    note.classList.add('hidden');
    if (!EMAIL.test(email.el.value.trim())) return setHint(email.hintEl, t('auth.email_bad'), 'bad');
    setHint(email.hintEl, '');
    if (pass.el.value.length < (signup ? 8 : 1)) return setHint(pass.hintEl, t('auth.password_hint'), 'bad');
    submit.disabled = true;
    submit.append(h('span', { class: 'spinner', style: { width: '16px', height: '16px', borderWidth: '2px' } }));
    try {
      if (signup) {
        const { data, error } = await sb.auth.signUp({
          email: email.el.value.trim(), password: pass.el.value,
          options: { data: { username: user.el.value.trim().toLowerCase(), display_name: user.el.value.trim(), privacy_accepted: true }, emailRedirectTo: location.origin + '/' },
        });
        if (error) throw error;
        if (data.session) { state.session = data.session; await loadProfile(); return navigate('/', { replace: true }); }
        note.textContent = t('auth.check_mail');
        note.classList.remove('hidden');
        form.reset(); refresh();
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email: email.el.value.trim(), password: pass.el.value });
        if (error) throw error;
        state.session = data.session;
        const p = await loadProfile();
        if (p?.is_banned) {
          const reason = p.ban_reason;
          await enforceBan(p);
          toast(t('auth.banned', { reason: reason || '' }), 'error');
          return navigate('/banned', { replace: true });
        }
        navigate(next, { replace: true });
      }
    } catch (err) {
      toast(mapAuthError(err), 'error');
    } finally {
      submit.querySelector('.spinner')?.remove();
      submit.disabled = signup ? !(agree.checked && nameOk) : false;
    }
  }

  const google = h('button', { class: 'btn ghost block', type: 'button', onclick: async () => {
    if (signup && !agree.checked) return toast(t('auth.need_privacy'), 'error');
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/' } });
    if (error) toast(t('err.generic'), 'error');
  } }, googleMark(), t('auth.google'));

  const form = h('form', { onsubmit: onSubmit, novalidate: true },
    email.wrap, signup ? user.wrap : null, pass.wrap,
    signup ? h('label', { class: 'check', for: 'agree', style: { marginBottom: '16px' } }, agree,
      h('span', null, t('auth.privacy_1') + ' ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, t('auth.privacy_link')), ' ' + t('auth.privacy_2'))) : null,
    submit);

  const canvas = h('canvas', { 'aria-label': t('auth.demo_alt'), role: 'img' });
  const el = h('div', { class: 'auth' },
    h('div', { class: 'auth-demo reveal' }, canvas, h('p', null, t('auth.demo_note'))),
    h('div', { class: 'reveal' },
      h('h1', null, t('auth.title')),
      h('p', { class: 'auth-lead' }, t('auth.lead')),
      h('div', { class: 'card auth-card' },
        h('div', { class: 'seg auth-tabs', role: 'tablist' },
          h('button', { type: 'button', 'aria-pressed': String(!signup), onclick: () => navigate('/login' + (query.next ? '?next=' + encodeURIComponent(query.next) : '')) }, t('auth.tab_login')),
          h('button', { type: 'button', 'aria-pressed': String(signup), onclick: () => navigate('/signup') }, t('auth.tab_signup'))),
        form, note,
        h('div', { class: 'divider-text' }, t('auth.or')), google)));

  const stop = startDemo(canvas, document.documentElement.dataset.reduce === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches);
  return { el, title: signup ? t('auth.tab_signup') : t('auth.tab_login'), destroy: stop };
}

function mapAuthError(err) {
  const m = String(err?.message || '').toLowerCase();
  if (m.includes('invalid login')) return t('auth.err_login');
  if (m.includes('already registered') || m.includes('already been registered')) return t('auth.err_exists');
  if (m.includes('email not confirmed')) return t('auth.err_confirm');
  if (m.includes('rate limit') || err?.status === 429) return t('auth.err_rate');
  if (m.includes('password')) return t('auth.password_hint');
  if (m.includes('database error') || m.includes('username')) return t('err.username_bad');
  return t('err.generic');
}
