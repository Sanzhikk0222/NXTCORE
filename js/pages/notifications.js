import { h } from '../core/dom.js';
import { rpc } from '../core/api.js';
import { state } from '../core/state.js';
import { avatar, spinner, emptyState, timeAgo, toast } from '../core/ui.js';
import { paintBadge } from '../core/shell.js';
import { t } from '../i18n/index.js';

export default async function page() {
  const host = h('div', { class: 'list' }, spinner());
  const more = h('button', { class: 'btn ghost hidden', style: { margin: '22px auto 0', display: 'flex' }, onclick: () => load() }, t('archive.more'));
  let before = null, first = true;

  function row(n) {
    const who = n.actor.display_name || n.actor.username;
    const href = n.type === 'follow' ? '/u/' + n.actor.username : '/post/' + n.post_id + (n.type === 'comment' ? '#comments' : '');
    const what = t(`notif.${n.type}`);
    const sub = n.type === 'follow' ? '' : (n.post_title || n.post_excerpt || '');
    return h('a', { class: `list-item${n.read ? '' : ' unread'}`, href },
      avatar(n.actor),
      h('div', { class: 'grow' }, h('div', null, h('b', null, who), ' ' + what), sub ? h('div', { class: 'ex' }, sub) : null),
      h('time', { class: 'small muted', datetime: n.created_at }, timeAgo(n.created_at)));
  }

  async function load() {
    try {
      const rows = await rpc('get_notifications', { p_limit: 40, p_before: before });
      if (first) host.replaceChildren();
      if (first && !rows.length) host.replaceChildren(emptyState(t('notif.empty'), t('notif.empty_text')));
      host.append(...rows.map(row));
      if (rows.length) before = rows[rows.length - 1].created_at;
      more.classList.toggle('hidden', rows.length < 40);
      if (first && rows.some((r) => !r.read)) {
        // открыли список: считаем прочитанным (отметка видна на строках, пока страница открыта)
        await rpc('mark_notifications_read', { p_ids: null });
        state.unread = 0; paintBadge();
      }
      first = false;
    } catch { host.replaceChildren(); toast(t('err.generic'), 'error'); }
  }
  load();
  return { el: h('div', null, h('div', { class: 'page-head' }, h('h1', null, t('nav.notifications'))), host, more), title: t('nav.notifications') };
}
