// Первый вход через Google: выбрать ник и принять политику.
import { h, debounce } from '../core/dom.js';
import { rpc, handleFail } from '../core/api.js';
import { loadProfile, signOut } from '../core/auth.js';
import { field, setHint, toast } from '../core/ui.js';
import { state } from '../core/state.js';
import { t } from '../i18n/index.js';
import { checkUsername } from '../moderation/text.js';

export default async function page({ navigate }) {
  const needName = !!state.profile.needs_setup;
  const user = field({ label: t('auth.username'), id: 'su', type: 'text', maxlength: '20', autocapitalize: 'none', spellcheck: 'false', hint: t('auth.username_hint') });
  const agree = h('input', { type: 'checkbox', id: 'sa' });
  const go = h('button', { class: 'btn block', type: 'submit', disabled: true }, t('setup.go'));
  let ok = !needName, seq = 0;
  const refresh = () => { go.disabled = !(agree.checked && ok); };

  const ask = debounce(async (name, my) => {
    try {
      const r = await rpc('username_status', { p_username: name });
      if (my !== seq) return;
      ok = !!r.available;
      setHint(user.hintEl, ok ? t('auth.username_free') : r.code === 'taken' ? t('auth.username_taken') : t('err.username_bad'), ok ? 'ok' : 'bad');
    } catch { /* сеть */ }
    refresh();
  }, 380);
  user.el.addEventListener('input', () => {
    const name = user.el.value.trim().toLowerCase(); const my = ++seq; ok = false;
    const local = checkUsername(name);
    if (!name) setHint(user.hintEl, t('auth.username_hint'));
    else if (!local.ok) setHint(user.hintEl, local.code === 'format' ? t('auth.username_format') : t('err.username_bad'), 'bad');
    else { setHint(user.hintEl, t('auth.username_checking')); ask(name, my); }
    refresh();
  });
  agree.addEventListener('change', refresh);

  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    go.disabled = true;
    try {
      const res = await rpc('accept_privacy', { p_username: needName ? user.el.value.trim().toLowerCase() : null });
      if (await handleFail(res, { navigate })) return;
      await loadProfile();
      toast(t('setup.done'), 'ok');
      navigate('/', { replace: true });
    } catch { toast(t('err.generic'), 'error'); } finally { refresh(); }
  } },
    needName ? user.wrap : null,
    h('label', { class: 'check', for: 'sa', style: { marginBottom: '16px' } }, agree,
      h('span', null, t('auth.privacy_1') + ' ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, t('auth.privacy_link')), ' ' + t('auth.privacy_2'))),
    go);

  return {
    title: t('setup.title'),
    el: h('div', { class: 'stack' },
      h('h1', null, t('setup.title')), h('p', { class: 'muted' }, t(needName ? 'setup.lead_name' : 'setup.lead')),
      h('div', { class: 'panel' }, form),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await signOut(); navigate('/login', { replace: true }); } }, t('nav.logout'))),
  };
}
