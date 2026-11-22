import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { sb } from '../core/supabase.js';
import { state } from '../core/state.js';
import { rpc, handleFail, signedUrls, removeFiles } from '../core/api.js';
import { avatar, toast, modal, confirmDialog, spinner, timeAgo, fmtDate, fmtDateTime, popMenu } from '../core/ui.js';
import { loadImage } from '../core/media.js';
import { t, getLang } from '../i18n/index.js';
import { createPlayer } from '../memory/render.js';
import { explain, TECHNIQUE_INFO, voiceProfile } from '../memory/engine.js';
import { parseMusicUrl, PROVIDER_LABEL, searchLinks } from '../memory/music.js';
import { speak, stopVoice, voiceSupported, isSpeaking } from '../memory/voice.js';
import { likeButton, moodPill, reportModal } from './parts.js';
import { renderData, weatherLabel, musicLine } from './memory-data.js';

export default async function page({ params, navigate }) {
  const me = state.profile;
  const post = await rpc('get_post', { p_id: params.id });
  if (!post) {
    return { title: '404', el: h('div', { class: 'empty' }, h('h2', null, t('post.gone_title')), h('p', null, t('post.gone_text')), h('a', { class: 'btn', href: '/' }, t('nav.feed'))) };
  }
  const own = post.user_id === me.id;
  const a = post.author;
  const mem = post.memory || {};
  let player = null, dead = false;

  // ---------- сцена
  const canvas = h('canvas', { role: 'img', 'aria-label': post.title || t('post.canvas_alt') });
  const stage = h('div', { class: 'stage' }, canvas);
  const ctrl = h('div', { class: 'stage-controls' });
  stage.append(ctrl);

  async function startPlayer() {
    try {
      const paths = (post.photos || []).map((p) => p.path);
      const urls = await signedUrls('photos', paths);
      const imgs = [];
      for (const p of paths) if (urls[p]) { try { imgs.push(await loadImage(urls[p], true)); } catch { /* пропуск */ } }
      if (dead) return;
      player = await createPlayer(canvas, mem, renderData({ photos: imgs, title: post.title || '', day: post.day_date, music: post.music, weather: post.weather, sign: mem.sign || '', scale: 0.62 }));
      if (dead) return player.destroy();
      const reduce = document.documentElement.dataset.reduce === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) player.renderStill(); else player.play();
      paintControls();
      thumbs.replaceChildren(...imgs.map((im) => h('img', { src: im.src, alt: '', loading: 'lazy' })));
    } catch (e) { console.warn('player', e); }
  }

  const playBtn = h('button', { class: 'btn ghost small', type: 'button' });
  const restartBtn = h('button', { class: 'btn ghost small', type: 'button', 'aria-label': t('post.restart'), onclick: () => player?.restart() }, icon('restart', 16));
  const voiceBtn = h('button', { class: 'btn ghost small', type: 'button' });
  function paintControls() {
    const playing = !!player?.playing;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 16), playing ? t('post.pause') : t('post.play'));
    voiceBtn.replaceChildren(icon(isSpeaking() ? 'mute' : 'speaker', 16), isSpeaking() ? t('post.voice_stop') : t('post.voice'));
  }
  playBtn.addEventListener('click', () => { if (!player) return; player.playing ? player.pause() : player.play(); paintControls(); });
  voiceBtn.addEventListener('click', async () => {
    if (isSpeaking()) { stopVoice(); return paintControls(); }
    const text = [post.title, post.text].filter(Boolean).join('. ');
    await speak(text, mem.voice || voiceProfile(mem.vec || { arousal: 0.5, warmth: 0.5 }), getLang(), { onEnd: paintControls });
    paintControls();
  });
  ctrl.append(playBtn, restartBtn);
  if (post.voice?.on && voiceSupported()) ctrl.append(voiceBtn);
  const onVis = () => { if (document.hidden && player?.playing) { player.pause(); paintControls(); } };
  document.addEventListener('visibilitychange', onVis);

  // ---------- текст и действия
  const menuWrap = h('div', { class: 'rel' });
  const more = h('button', { class: 'iconbtn', type: 'button', 'aria-label': t('common.more'), 'aria-haspopup': 'menu' }, icon('more'));
  more.addEventListener('click', () => popMenu(menuWrap, own ? [
    { label: t('post.edit'), icon: 'edit', onClick: () => navigate('/post/' + post.id + '/edit') },
    { label: t('post.delete'), icon: 'trash', danger: true, onClick: del },
  ] : [{ label: t('report.btn'), icon: 'flag', onClick: () => reportModal('post', post.id) }]));
  menuWrap.append(more);

  async function del() {
    if (!(await confirmDialog(t('post.delete_title'), t('post.delete_text'), t('post.delete'), true))) return;
    try {
      const r = await rpc('delete_post', { p_id: post.id });
      if (await handleFail(r, { navigate })) return;
      await removeFiles('photos', r.paths);
      if (post.music?.audio_path) await removeFiles('audio', [post.music.audio_path]);
      toast(t('post.deleted'), 'ok');
      navigate('/archive', { replace: true });
    } catch { toast(t('err.generic'), 'error'); }
  }

  async function showLikers() {
    const body = h('div', null, spinner());
    modal({ title: t('post.likers'), body, actions: [{ label: t('common.close'), class: 'ghost', value: true }] });
    try {
      const rows = await rpc('get_likers', { p_post: post.id });
      body.replaceChildren(rows.length ? h('div', { class: 'list' }, ...rows.map((r) => h('a', { class: 'list-item', href: '/u/' + r.user.username },
        avatar(r.user), h('div', { class: 'grow' }, h('b', null, r.user.display_name || r.user.username), h('div', { class: 'ex' }, '@' + r.user.username)),
        h('span', { class: 'small muted' }, timeAgo(r.created_at))))) : h('p', { class: 'muted' }, t('post.no_likes')));
    } catch { body.replaceChildren(h('p', { class: 'muted' }, t('err.generic'))); }
  }

  // ---------- песня
  function musicBlock() {
    const m = post.music;
    if (!m) return null;
    const link = m.url ? parseMusicUrl(m.url) : null;
    const line = musicLine(m);
    const wrap = h('div', { class: 'stack' });
    if (line) wrap.append(h('div', null, h('b', null, line), m.year ? h('span', { class: 'muted' }, ' · ' + m.year) : null));
    if (link?.embed) wrap.append(h('iframe', { class: 'embed', src: link.embed, height: String(link.height || 152), title: line || t('post.song'), loading: 'lazy', allow: 'autoplay; encrypted-media; clipboard-write', referrerpolicy: 'strict-origin-when-cross-origin', sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups' }));
    else if (link?.direct) wrap.append(h('audio', { controls: true, preload: 'none', src: link.url, style: { width: '100%' } }));
    else if (link) wrap.append(h('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, t('post.open_song', { p: PROVIDER_LABEL[link.provider] || '' })));
    else if (line && !m.audio_path) {
      const s = searchLinks({ artist: m.artist, title: m.title });
      wrap.append(h('div', { class: 'row wrap small' }, t('post.find_song'), h('a', { href: s.youtube, target: '_blank', rel: 'noopener noreferrer' }, 'YouTube'), h('a', { href: s.spotify, target: '_blank', rel: 'noopener noreferrer' }, 'Spotify')));
    }
    if (m.audio_path && own) {
      const holder = h('div');
      signedUrls('audio', [m.audio_path]).then((u) => { if (u[m.audio_path]) holder.append(h('audio', { controls: true, preload: 'none', src: u[m.audio_path], style: { width: '100%' } })); });
      wrap.append(holder);
    } else if (m.audio_path) wrap.append(h('p', { class: 'small muted' }, t('post.own_audio_private')));
    if (m.bpm) wrap.append(h('p', { class: 'small muted', style: { margin: 0 } }, [t('music.bpm', { n: m.bpm }), m.estimated ? t('post.estimated') : ''].filter(Boolean).join(' · ')));
    return h('section', null, h('h3', null, t('post.song')), wrap);
  }

  const thumbs = h('div', { class: 'thumbs' });
  const info = TECHNIQUE_INFO[mem.technique];
  const lines = mem.explain ? explain(mem, getLang()) : [];
  const inside = h('section', { class: 'inside' },
    h('h3', null, t('post.inside')),
    h('ul', null,
      post.photos?.length ? h('li', null, t('post.inside_photos', { n: post.photos.length })) : null,
      post.weather ? h('li', null, t('post.inside_weather', { w: weatherLabel(post.weather) })) : null,
      post.ai?.used ? h('li', null, t('post.inside_ai')) : null,
      ...lines.map((l) => h('li', null, l))),
    info ? h('p', { class: 'small muted', style: { margin: '12px 0 0' } }, t('post.inside_ref', { ref: info.ref })) : null,
    thumbs);

  // ---------- комментарии
  const commentsBox = h('div', { class: 'comments' }, spinner());
  const commentCount = h('span', { class: 'counter' }, String(post.comments_count || 0));
  const draw = (c) => h('div', { class: 'comment' },
    h('a', { href: '/u/' + c.author.username }, avatar(c.author, 's')),
    h('div', { class: 'bubble' }, h('a', { href: '/u/' + c.author.username }, c.author.display_name || c.author.username), h('span', { class: 'small muted' }, ' · ' + timeAgo(c.created_at)), h('div', null, c.text)));
  (async () => {
    try {
      const rows = await rpc('get_comments', { p_post: post.id });
      commentsBox.replaceChildren(...(rows.length ? rows.map(draw) : [h('p', { class: 'muted small', id: 'no-comments' }, t('post.no_comments'))]));
    } catch { commentsBox.replaceChildren(h('p', { class: 'muted' }, t('err.generic'))); }
  })();

  const cin = h('textarea', { class: 'textarea', maxlength: '300', style: { minHeight: '70px' }, placeholder: t('post.comment_ph'), 'aria-label': t('post.comment_ph') });
  const csend = h('button', { class: 'btn small', type: 'submit' }, t('post.comment_send'));
  const cform = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const txt = cin.value.trim();
    if (!txt) return;
    csend.disabled = true;
    try {
      const r = await rpc('create_comment', { p_post: post.id, p_text: txt });
      if (r?.code === 'spam_text') toast(t('err.spam_text'), 'error');
      else if (!(await handleFail(r, { navigate }))) {
        document.getElementById('no-comments')?.remove();
        commentsBox.append(draw(r.comment));
        commentCount.textContent = String(Number(commentCount.textContent) + 1);
        cin.value = '';
      }
    } catch { toast(t('err.generic'), 'error'); } finally { csend.disabled = false; }
  } }, cin, h('div', null, csend));

  const body = h('div', { class: 'post-body' },
    h('div', { class: 'row between', style: { marginBottom: '14px' } },
      h('a', { class: 'row', href: '/u/' + a.username, style: { textDecoration: 'none', color: 'inherit' } }, avatar(a),
        h('div', { style: { lineHeight: 1.25 } }, h('b', null, a.display_name || a.username), h('div', { class: 'small muted' }, '@' + a.username))),
      menuWrap),
    h('p', { class: 'small muted', style: { margin: '0 0 4px' } }, fmtDate(post.day_date)),
    h('h1', null, post.title || t('post.untitled')),
    h('div', { class: 'row wrap', style: { marginBottom: '18px' } },
      moodPill(post.mood),
      post.visibility === 'private' ? h('span', { class: 'pill' }, icon('lock', 14), t('post.private')) : h('span', { class: 'pill' }, icon('globe', 14), t('post.public')),
      post.edited_at ? h('span', { class: 'small muted', title: fmtDateTime(post.edited_at) }, t('post.edited')) : null),
    post.text ? h('div', { class: 'post-text' }, post.text) : null,
    h('div', { class: 'row', style: { margin: '18px 0 0' } },
      likeButton(post),
      h('button', { class: 'btn ghost small', type: 'button', onclick: showLikers }, t('post.who_liked')),
      h('a', { class: 'like', href: '#comments', 'aria-label': t('post.comments') }, icon('comment', 22), commentCount)),
    inside,
    musicBlock(),
    h('section', { id: 'comments', style: { marginTop: '30px' } }, h('h3', null, t('post.comments')), commentsBox, cform));

  const el = h('div', { class: 'post-page' }, stage, body);
  startPlayer();
  if (location.hash === '#comments') setTimeout(() => document.getElementById('comments')?.scrollIntoView(), 400);

  return { el, title: post.title || t('post.untitled'), destroy: () => { dead = true; player?.destroy(); stopVoice(); document.removeEventListener('visibilitychange', onVis); } };
}
