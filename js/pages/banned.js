import { h } from '../core/dom.js';
import { CONFIG } from '../config.js';
import { BAN_KEY } from '../core/auth.js';
import { state } from '../core/state.js';
import { fmtDateTime } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { t } from '../i18n/index.js';

export default async function page() {
  let info = null;
  try { info = JSON.parse(sessionStorage.getItem(BAN_KEY) || 'null'); } catch { /* ничего */ }
  if (!info && state.profile?.is_banned) info = { reason: state.profile.ban_reason, until: state.profile.ban_until };
  const reason = info?.reason || t('banned.no_reason');
  const until = info?.until ? t('banned.until', { date: fmtDateTime(info.until) }) : t('banned.forever');

  return {
    title: t('banned.title'),
    el: h('div', { class: 'banned' },
      h('div', { style: { color: 'var(--danger)', marginBottom: '8px' } }, icon('lock', 44)),
      h('h1', null, t('banned.title')),
      h('p', { class: 'muted' }, t('banned.lead')),
      h('div', { class: 'panel reason' },
        h('p', { style: { margin: '0 0 6px' } }, h('b', null, t('banned.reason') + ': '), reason),
        h('p', { style: { margin: 0 } }, h('b', null, t('banned.term') + ': '), until)),
      h('p', null, t('banned.support') + ' ', h('a', { href: 'mailto:' + CONFIG.SUPPORT_EMAIL }, CONFIG.SUPPORT_EMAIL)),
      h('p', null, h('a', { class: 'btn ghost', href: '/login' }, t('banned.back')))),
  };
}
