import { h } from '../core/dom.js';
import { rpc } from '../core/api.js';
import { spinner, emptyState, toast, reveal } from '../core/ui.js';
import { t } from '../i18n/index.js';
import { postCard, fillCovers } from './parts.js';

const BATCH = 100;   // подборка пересобирается каждые 100 записей
const CHUNK = 8;     // в страницу добавляем по 8 карточек, чтобы не грузить сто картинок сразу

export default async function page({ navigate }) {
  const list = h('div', { class: 'feed' });
  const sentinel = h('div', { style: { height: '1px' } });
  const status = h('div', { class: 'muted small', style: { textAlign: 'center', padding: '24px 0' } });
  const root = h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, t('nav.feed')), h('a', { class: 'btn small', href: '/new' }, t('nav.new'))),
    list, sentinel, status);

  const seen = [];
  let queue = [], fetching = false, exhausted = false, shown = 0, lastBatch = 0;

  async function fetchBatch() {
    fetching = true;
    try {
      const rows = await rpc('get_feed', { p_exclude: seen.slice(-1000), p_limit: BATCH, p_salt: Math.floor(Math.random() * 1e6) });
      lastBatch = rows.length;
      for (const p of rows) seen.push(p.id);
      queue.push(...rows);
      if (!rows.length) exhausted = true;
    } catch {
      toast(t('feed.error'), 'error');
      exhausted = true;
    } finally { fetching = false; }
  }

  async function more() {
    if (fetching) return;
    if (!queue.length && !exhausted) { status.replaceChildren(spinner()); await fetchBatch(); status.replaceChildren(); }
    const chunk = queue.splice(0, CHUNK);
    if (chunk.length) {
      shown += chunk.length;
      for (const p of chunk) list.append(postCard(p));
      reveal(list);
      fillCovers(chunk, list);
    }
    if (!queue.length && exhausted) {
      io.disconnect();
      if (!shown) { root.replaceChildren(h('div', { class: 'page-head' }, h('h1', null, t('nav.feed'))), emptyState(t('feed.empty'), t('feed.empty_text'), h('a', { class: 'btn', href: '/new' }, t('feed.empty_btn')))); }
      else status.textContent = t('feed.end');
    }
  }

  const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) more(); }, { rootMargin: '600px 0px' });
  io.observe(sentinel);
  return { el: root, title: t('nav.feed'), destroy: () => io.disconnect() };
}
