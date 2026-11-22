import { h, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { rpc } from '../core/api.js';
import { avatar, spinner, emptyState, reveal } from '../core/ui.js';
import { t } from '../i18n/index.js';
import { postCard, fillCovers } from './parts.js';

export default async function page({ query, navigate }) {
  const input = h('input', { class: 'input', type: 'search', value: query.q || '', placeholder: t('search.placeholder'), 'aria-label': t('search.placeholder'), maxlength: '60' });
  const out = h('div');
  let seq = 0;

  async function run(q) {
    const my = ++seq;
    q = q.trim();
    if (q.length < 2) return out.replaceChildren(h('p', { class: 'muted' }, t('search.hint')));
    out.replaceChildren(spinner());
    try {
      const [users, posts] = await Promise.all([rpc('search_users', { p_q: q }), rpc('search_posts', { p_q: q })]);
      if (my !== seq) return;
      if (!users.length && !posts.length) return out.replaceChildren(emptyState(t('search.none'), t('search.none_text', { q })));
      const feed = h('div', { class: 'feed', style: { marginTop: '12px' } }, ...posts.map((p) => postCard(p)));
      out.replaceChildren(
        users.length ? h('section', null, h('h2', null, t('search.people')), h('div', { class: 'list' }, ...users.map((u) => h('a', { class: 'list-item', href: '/u/' + u.username },
          avatar(u), h('div', { class: 'grow' }, h('b', null, u.display_name || u.username), h('div', { class: 'ex' }, '@' + u.username + (u.bio ? ' · ' + u.bio : ''))))))) : null,
        posts.length ? h('section', { style: { marginTop: '28px' } }, h('h2', null, t('search.posts')), feed) : null);
      reveal(out); fillCovers(posts, out);
    } catch { if (my === seq) out.replaceChildren(h('p', { class: 'muted' }, t('err.generic'))); }
  }
  const go = debounce(() => { history.replaceState({}, '', '/search?q=' + encodeURIComponent(input.value.trim())); run(input.value); }, 350);
  input.addEventListener('input', go);
  run(input.value);
  return { el: h('div', null, h('div', { class: 'page-head' }, h('h1', null, t('nav.search'))), h('div', { class: 'searchbar' }, input), out), title: t('nav.search') };
}
