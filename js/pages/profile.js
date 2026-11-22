import { h, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { sb } from '../core/supabase.js';
import { state } from '../core/state.js';
import { rpc, callAi, handleFail } from '../core/api.js';
import { loadProfile } from '../core/auth.js';
import { avatar, toast, modal, spinner, emptyState, field, setHint, popMenu, reveal, fmtDate } from '../core/ui.js';
import { prepareImage, toUploadItem } from '../core/media.js';
import { t } from '../i18n/index.js';
import { checkUsername } from '../moderation/text.js';
import { postCard, fillCovers, reportModal } from './parts.js';

export default async function page({ params, navigate }) {
  const data = await rpc('get_profile', { p_username: params.username });
  if (!data) return { title: '404', el: emptyState(t('profile.not_found'), t('profile.not_found_text'), h('a', { class: 'btn', href: '/' }, t('nav.feed'))) };
  const { profile: p, stats, is_me: isMe } = data;
  let following = !!data.is_following;
  const followers = h('b', null, String(stats.followers));

  // ---------- шапка
  const headRight = h('div', { class: 'row wrap' });
  const followBtn = h('button', { class: 'btn', type: 'button' });
  const paintFollow = () => { followBtn.textContent = following ? t('profile.unfollow') : t('profile.follow'); followBtn.classList.toggle('ghost', following); };
  followBtn.addEventListener('click', async () => {
    followBtn.disabled = true;
    const { error } = following
      ? await sb.from('follows').delete().eq('follower_id', state.profile.id).eq('followee_id', p.id)
      : await sb.from('follows').insert({ follower_id: state.profile.id, followee_id: p.id });
    if (!error || error.code === '23505') {
      following = !following;
      followers.textContent = String(Number(followers.textContent) + (following ? 1 : -1));
      paintFollow();
    } else toast(t('err.generic'), 'error');
    followBtn.disabled = false;
  });
  paintFollow();

  if (isMe) {
    headRight.append(
      h('button', { class: 'btn dark', type: 'button', onclick: () => editModal() }, icon('edit', 16), t('profile.edit')),
      h('a', { class: 'btn ghost', href: '/settings' }, icon('settings', 16), t('nav.settings')));
  } else {
    const wrap = h('div', { class: 'rel' });
    const more = h('button', { class: 'iconbtn', type: 'button', 'aria-label': t('common.more'), 'aria-haspopup': 'menu' }, icon('more'));
    more.addEventListener('click', () => popMenu(wrap, [{ label: t('report.btn'), icon: 'flag', onClick: () => reportModal('user', p.id) }]));
    wrap.append(more);
    headRight.append(followBtn, wrap);
  }

  const nameEl = h('h1', null, p.display_name || p.username);
  const bioEl = h('p', { class: 'bio' }, p.bio || '');
  const avatarHost = h('div', null, avatar(p, 'l'));
  const statsEl = h('div', { class: 'stats' },
    h('div', null, h('b', null, String(stats.posts)), h('span', null, t('profile.posts'))),
    h('div', null, h('b', null, String(stats.likes)), h('span', null, t('profile.likes'))),
    h('div', null, followers, h('span', null, t('profile.followers'))),
    h('div', null, h('b', null, String(stats.following)), h('span', null, t('profile.following'))));

  const head = h('div', { class: 'profile-head' }, avatarHost,
    h('div', null, nameEl, h('div', { class: 'muted' }, '@' + p.username + ' · ' + t('profile.since', { date: fmtDate(p.created_at, { month: 'long', year: 'numeric' }) })),
      statsEl, p.bio ? bioEl : bioEl, headRight));

  // ---------- записи
  const list = h('div', { class: 'feed' });
  const more = h('button', { class: 'btn ghost hidden', style: { margin: '26px auto 0', display: 'flex' }, onclick: () => load() }, t('archive.more'));
  let before = null, done = false, loaded = 0, busy = false;
  async function load() {
    if (busy || done) return;
    busy = true; const sp = spinner(); list.append(sp);
    try {
      const rows = await rpc('get_user_posts', { p_username: p.username, p_limit: 20, p_before: before });
      sp.remove();
      for (const r of rows) list.append(postCard(r));
      loaded += rows.length;
      if (rows.length) before = rows[rows.length - 1].created_at;
      if (rows.length < 20) done = true;
      reveal(list); fillCovers(rows, list);
      more.classList.toggle('hidden', done);
      if (!loaded) list.replaceChildren(emptyState(isMe ? t('profile.empty_me') : t('profile.empty'), isMe ? t('profile.empty_me_text') : '', isMe ? h('a', { class: 'btn', href: '/new' }, t('nav.new')) : null));
    } catch { sp.remove(); toast(t('err.generic'), 'error'); }
    busy = false;
  }

  // ---------- редактирование профиля
  function editModal() {
    const me = state.profile;
    let newAvatarUrl = null, nameOk = true, seq = 0;
    const dn = field({ label: t('profile.display_name'), id: 'pe-dn', type: 'text', maxlength: '40', value: me.display_name || '' });
    const un = field({ label: t('auth.username'), id: 'pe-un', type: 'text', maxlength: '20', value: me.username, autocapitalize: 'none', spellcheck: 'false', hint: t('auth.username_hint') });
    const bio = field({ label: t('profile.bio'), id: 'pe-bio', type: 'textarea', maxlength: '150', hint: '' });
    bio.el.value = me.bio || ''; bio.el.style.minHeight = '90px';
    const cnt = () => setHint(bio.hintEl, `${bio.el.value.length} / 150`);
    bio.el.addEventListener('input', cnt); cnt();

    const ask = debounce(async (name, my) => {
      try {
        const r = await rpc('username_status', { p_username: name });
        if (my !== seq) return;
        nameOk = !!r.available;
        setHint(un.hintEl, nameOk ? t('auth.username_free') : r.code === 'taken' ? t('auth.username_taken') : t('err.username_bad'), nameOk ? 'ok' : 'bad');
      } catch { /* сеть */ }
    }, 380);
    un.el.addEventListener('input', () => {
      const name = un.el.value.trim().toLowerCase(); const my = ++seq;
      if (name === me.username) { nameOk = true; return setHint(un.hintEl, t('auth.username_hint')); }
      nameOk = false;
      const l = checkUsername(name);
      if (!l.ok) return setHint(un.hintEl, l.code === 'format' ? t('auth.username_format') : t('err.username_bad'), 'bad');
      setHint(un.hintEl, t('auth.username_checking')); ask(name, my);
    });

    const prev = h('div', null, avatar(me, 'l'));
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'sr', tabindex: '-1' });
    const status = h('div', { class: 'hint' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0]; if (!f) return;
      setHint(status, t('profile.avatar_check'));
      try {
        const r = await prepareImage(f, 640);
        const res = await callAi('upload_images', { kind: 'avatar', items: [await toUploadItem('avatar', r.blob)] });
        if (!res?.ok) { setHint(status, ''); await handleFail(res, { navigate }); return; }
        newAvatarUrl = res.files[0].url;
        prev.replaceChildren(avatar({ ...me, avatar_url: newAvatarUrl }, 'l'));
        setHint(status, t('profile.avatar_ok'), 'ok');
      } catch { setHint(status, t('compose.photo_bad'), 'bad'); }
    });

    const body = h('div', null,
      h('div', { class: 'row', style: { marginBottom: '16px' } }, prev,
        h('div', null, h('button', { class: 'btn ghost small', type: 'button', onclick: () => file.click() }, t('profile.avatar_change')), file, status)),
      dn.wrap, un.wrap, bio.wrap,
      h('p', { class: 'small' }, h('a', { href: '/settings' }, t('profile.to_settings'))));

    modal({
      title: t('profile.edit'), body,
      actions: [
        { label: t('common.cancel'), class: 'ghost', value: false },
        { label: t('common.save'), onClick: async (close) => {
          if (!nameOk) { toast(t('err.username_bad'), 'error'); return false; }
          const r = await rpc('update_profile', { p_display_name: dn.el.value.trim(), p_bio: bio.el.value.trim(), p_avatar_url: newAvatarUrl });
          if (await handleFail(r, { navigate })) return false;
          const newName = un.el.value.trim().toLowerCase();
          if (newName !== me.username) {
            const u = await rpc('change_username', { p_username: newName });
            if (await handleFail(u, { navigate })) return false;
          }
          await loadProfile();
          toast(t('profile.saved'), 'ok');
          close(true);
          if (newName !== me.username) navigate('/u/' + newName, { replace: true }); else navigate('/u/' + p.username, { replace: true });
        } },
      ],
    });
  }

  const el = h('div', null, head, h('hr', { class: 'divider' }), list, more);
  load();
  return { el, title: '@' + p.username };
}
