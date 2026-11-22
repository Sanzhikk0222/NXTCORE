// Общие куски для страниц с записями: карточка, лайк, жалоба, обложки.
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { sb } from '../core/supabase.js';
import { state } from '../core/state.js';
import { signedUrls } from '../core/api.js';
import { avatar, fmtDate, modal, toast, popMenu, setHint } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { t } from '../i18n/index.js';

export const MOODS = ['warm', 'cold', 'energetic'];
export const moodPill = (m) => (m ? h('span', { class: `pill ${m}` }, t(`mood.${m}`)) : null);

export function coverFallback(post) {
  const pal = post.memory?.palette;
  return h('div', { class: 'cover-fallback', style: { background: pal?.bg || 'var(--surface-2)', color: pal?.ink || 'var(--ink)' } }, post.title || '');
}

// Подставляет подписанные ссылки на обложки в уже созданные карточки
export async function fillCovers(posts, root) {
  const urls = await signedUrls('photos', posts.map((p) => p.cover_path));
  for (const p of posts) {
    const host = root.querySelector(`[data-cover="${p.id}"]`);
    const url = urls[p.cover_path];
    if (!host || !url) continue;
    const img = h('img', { src: url, alt: p.title || '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.remove(), { once: true });
    host.append(img);
  }
}

export function likeButton(post) {
  const me = state.profile.id;
  let busy = false;
  const count = h('span', { class: 'counter' }, String(post.likes_count || 0));
  const btn = h('button', { class: 'like', type: 'button', 'aria-pressed': String(!!post.liked_by_me), 'aria-label': t('post.like') }, icon('heart', 22), count);
  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const was = !!post.liked_by_me;
    // сначала меняем интерфейс, потом отправляем; при ошибке откатываем
    const apply = (liked) => {
      post.liked_by_me = liked;
      post.likes_count = Math.max(0, (post.likes_count || 0) + (liked ? 1 : -1));
      btn.setAttribute('aria-pressed', String(liked));
      count.textContent = String(post.likes_count);
    };
    apply(!was);
    if (!was) { btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse'); }
    const { error } = was
      ? await sb.from('likes').delete().eq('post_id', post.id).eq('user_id', me)
      : await sb.from('likes').insert({ post_id: post.id, user_id: me });
    if (error && error.code !== '23505') { apply(was); toast(t('err.generic'), 'error'); }
    busy = false;
  });
  return btn;
}

export function reportModal(targetType, targetId) {
  let reason = 'spam';
  const chips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': t('report.reason') });
  for (const r of ['spam', 'insult', 'nsfw', 'other']) {
    const c = h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(r === reason) }, t(`report.${r}`));
    c.addEventListener('click', () => { reason = r; chips.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-checked', String(x === c))); });
    chips.append(c);
  }
  const text = h('textarea', { class: 'textarea', maxlength: '500', style: { minHeight: '90px' }, placeholder: t('report.details'), 'aria-label': t('report.details') });
  const hint = h('div', { class: 'hint' });
  modal({
    title: t(targetType === 'post' ? 'report.title_post' : 'report.title_user'),
    body: h('div', { class: 'stack' }, chips, text, hint),
    actions: [
      { label: t('common.cancel'), class: 'ghost', value: false },
      { label: t('report.send'), onClick: async (close) => {
        const { error } = await sb.from('reports').insert({ reporter_id: state.profile.id, target_type: targetType, target_id: targetId, reason, details: text.value.trim() || null });
        if (!error) { toast(t('report.sent'), 'ok'); close(true); return; }
        if (error.code === '23505') { toast(t('report.dup'), 'info'); close(false); return; }
        setHint(hint, t('err.generic'), 'bad');
        return false;
      } },
    ],
  });
}

export function postCard(post, { onDeleted } = {}) {
  const me = state.profile;
  const own = post.user_id === me.id;
  const a = post.author || {};
  const open = () => navigate('/post/' + post.id);
  const menuWrap = h('div', { class: 'rel' });
  const more = h('button', { class: 'iconbtn', type: 'button', 'aria-label': t('common.more'), 'aria-haspopup': 'menu' }, icon('more'));
  more.addEventListener('click', () => popMenu(menuWrap, [
    { label: t('post.open'), icon: 'image', onClick: open },
    own ? { label: t('post.edit'), icon: 'edit', onClick: () => navigate('/post/' + post.id + '/edit') } : { label: t('report.btn'), icon: 'flag', onClick: () => reportModal('post', post.id) },
  ]));
  menuWrap.append(more);

  const cover = h('a', { class: 'cover', href: '/post/' + post.id, 'aria-label': post.title || t('post.open'), 'data-cover': post.id }, coverFallback(post));
  const excerpt = (post.text || '').trim();

  return h('article', { class: 'card lift post-card reveal' },
    h('div', { class: 'head' },
      h('a', { href: '/u/' + a.username, 'aria-label': a.display_name || a.username }, avatar(a)),
      h('div', { class: 'who' },
        h('a', { href: '/u/' + a.username }, a.display_name || a.username),
        h('div', { class: 'small muted' }, '@' + a.username + ' · ' + fmtDate(post.day_date))),
      post.visibility === 'private' ? h('span', { class: 'pill', title: t('post.private') }, icon('lock', 14), t('post.private')) : null,
      menuWrap),
    cover,
    post.title ? h('h3', { style: { padding: '14px 18px 0', margin: 0 } }, h('a', { href: '/post/' + post.id, style: { color: 'inherit', textDecoration: 'none' } }, post.title)) : null,
    excerpt ? h('p', { class: 'excerpt' }, excerpt.length > 160 ? excerpt.slice(0, 160).trimEnd() + '…' : excerpt) : null,
    h('div', { class: 'foot' },
      likeButton(post),
      h('a', { class: 'like', href: '/post/' + post.id + '#comments', 'aria-label': t('post.comments') }, icon('comment', 22), h('span', { class: 'counter' }, String(post.comments_count || 0))),
      h('span', { class: 'grow' }),
      moodPill(post.mood),
      post.edited_at ? h('span', { class: 'small muted', style: { marginLeft: '8px' } }, t('post.edited')) : null));
}
