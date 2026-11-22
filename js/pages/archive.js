// Архив: свои дни как папки, по месяцам.
import { h } from '../core/dom.js';
import { rpc, signedUrls } from '../core/api.js';
import { spinner, emptyState, toast, fmtDate, reveal } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { contrast } from '../memory/color.js';
import { t, getLang } from '../i18n/index.js';
import { MOODS } from './parts.js';

const PAGE = 60;

export default async function page() {
  let mood = null, offset = 0, done = false, loading = false;
  const root = h('div');
  const host = h('div');
  const more = h('button', { class: 'btn ghost hidden', style: { margin: '28px auto 0', display: 'flex' }, onclick: () => load() }, t('archive.more'));
  const filter = h('div', { class: 'chips', role: 'group', 'aria-label': t('archive.filter') });
  let lastMonth = '', grid = null;

  const paintFilter = () => filter.replaceChildren(
    h('button', { class: 'chip', type: 'button', 'aria-pressed': String(!mood), onclick: () => setMood(null) }, t('archive.all')),
    ...MOODS.map((m) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(mood === m), onclick: () => setMood(m) }, t(`mood.${m}`))));

  function setMood(m) { mood = m; offset = 0; done = false; host.replaceChildren(); lastMonth = ''; grid = null; paintFilter(); load(); }

  function folder(p) {
    const pal = p.memory?.palette;
    const bg = pal?.accent || '#e07b39';
    const ink = contrast(bg, '#ffffff') >= contrast(bg, '#1a2332') ? '#ffffff' : '#1a2332';
    return h('a', { class: 'folder reveal', href: '/post/' + p.id, style: { '--folder': bg, '--folder-ink': ink }, 'aria-label': p.title || fmtDate(p.day_date) },
      h('div', { class: 'body' },
        h('div', { class: 'shot', 'data-cover': p.id }),
        h('div', { class: 'meta' }, h('b', null, p.title || t('post.untitled')),
          h('span', null, fmtDate(p.day_date, { day: 'numeric', month: 'long' }), p.visibility === 'private' ? ' · ' + t('post.private') : ''))));
  }

  async function load() {
    if (loading || done) return;
    loading = true;
    const sp = spinner(); host.append(sp); more.classList.add('hidden');
    try {
      const rows = await rpc('get_archive', { p_limit: PAGE, p_offset: offset, p_mood: mood });
      sp.remove();
      offset += rows.length;
      if (rows.length < PAGE) done = true;
      for (const p of rows) {
        const key = p.day_date.slice(0, 7);
        if (key !== lastMonth) {
          lastMonth = key;
          host.append(h('h2', { class: 'month' }, new Date(key + '-15').toLocaleDateString(getLang() === 'kk' ? 'kk-KZ' : 'ru-RU', { month: 'long', year: 'numeric' })));
          grid = h('div', { class: 'folders' });
          host.append(grid);
        }
        grid.append(folder(p));
      }
      reveal(host);
      const urls = await signedUrls('photos', rows.map((p) => p.cover_path));
      for (const p of rows) {
        const slot = host.querySelector(`[data-cover="${p.id}"]`);
        if (slot && urls[p.cover_path]) slot.append(h('img', { src: urls[p.cover_path], alt: '', loading: 'lazy' }));
      }
      if (!offset) host.append(emptyState(t('archive.empty'), mood ? t('archive.empty_filter') : t('archive.empty_text'), h('a', { class: 'btn', href: '/new' }, t('nav.new'))));
      more.classList.toggle('hidden', done);
    } catch { sp.remove(); toast(t('err.generic'), 'error'); }
    loading = false;
  }

  root.append(h('div', { class: 'page-head' }, h('h1', null, t('archive.title')), h('a', { class: 'btn small', href: '/new' }, icon('plus', 16), t('nav.new'))), filter, host, more);
  paintFilter();
  load();
  return { el: root, title: t('archive.title') };
}
