import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { sb } from '../core/supabase.js';
import { state, settings } from '../core/state.js';
import { rpc, handleFail } from '../core/api.js';
import { applySettings, loadProfile, signOut, themePref } from '../core/auth.js';
import { toast, confirmDialog, modal, field, setHint } from '../core/ui.js';
import { downloadBlob } from '../core/media.js';
import { CONFIG } from '../config.js';
import { t, getLang, LANGS } from '../i18n/index.js';

export default async function page({ navigate }) {
  const me = state.profile;
  const cur = { ...settings() };

  async function save(patch, { reload = false } = {}) {
    Object.assign(cur, patch);
    try {
      const r = await rpc('update_profile', { p_settings: patch });
      if (await handleFail(r, { navigate })) return;
      state.profile = r.profile;
      applySettings(r.profile.settings);
      if (reload) location.reload(); else toast(t('settings.saved'), 'ok', { ms: 1800 });
    } catch { toast(t('err.generic'), 'error'); }
  }

  const seg = (label, options, value, onPick) => {
    const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    for (const [v, text] of options) {
      wrap.append(h('button', { type: 'button', 'aria-pressed': String(value === v), onclick: () => {
        wrap.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === v)));
        onPick(v);
      } }, text));
    }
    return wrap;
  };
  const sw = (key, def = false) => {
    const i = h('input', { type: 'checkbox', checked: cur[key] === undefined ? def : !!cur[key] });
    i.addEventListener('change', () => save({ [key]: i.checked }));
    return h('label', { class: 'switch' }, i, h('i'));
  };
  const row = (title, text, control) => h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', null, title), text ? h('span', null, text) : null), control);

  // ---- пароль
  async function passwordModal() {
    const p1 = field({ label: t('settings.new_password'), id: 'np', type: 'password', autocomplete: 'new-password', maxlength: '72', hint: t('auth.password_hint') });
    modal({
      title: t('settings.password'), body: p1.wrap,
      actions: [{ label: t('common.cancel'), class: 'ghost', value: false }, { label: t('common.save'), onClick: async (close) => {
        if (p1.el.value.length < 8) { setHint(p1.hintEl, t('auth.password_hint'), 'bad'); return false; }
        const { error } = await sb.auth.updateUser({ password: p1.el.value });
        if (error) { toast(/same|different/i.test(error.message) ? t('settings.password_same') : t('err.generic'), 'error'); return false; }
        toast(t('settings.password_done'), 'ok'); close(true);
      } }],
    });
  }

  // ---- выгрузка записей
  async function exportData() {
    const posts = [];
    for (let off = 0; off < 2000; off += 100) {
      const rows = await rpc('get_archive', { p_limit: 100, p_offset: off, p_mood: null });
      posts.push(...rows);
      if (rows.length < 100) break;
    }
    const out = {
      exported_at: new Date().toISOString(), service: 'NXTCORE',
      profile: { username: me.username, display_name: me.display_name, bio: me.bio, created_at: me.created_at, settings: me.settings },
      posts: posts.map((p) => ({ id: p.id, day: p.day_date, title: p.title, text: p.text, mood: p.mood, visibility: p.visibility, music: p.music, weather: p.weather, photos: (p.photos || []).length, created_at: p.created_at, edited_at: p.edited_at })),
    };
    downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `nxtcore-${me.username}.json`);
  }

  // ---- удаление аккаунта: сначала файлы, потом сама запись
  async function wipe(bucket, prefix, depth = 0) {
    const { data } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    const files = [];
    for (const it of data || []) {
      if (it.id === null && depth < 2) await wipe(bucket, `${prefix}/${it.name}`, depth + 1);
      else if (it.id !== null) files.push(`${prefix}/${it.name}`);
    }
    if (files.length) await sb.storage.from(bucket).remove(files);
  }
  async function deleteAccount() {
    const confirmInput = h('input', { class: 'input', placeholder: me.username, 'aria-label': t('settings.delete_title'), autocomplete: 'off' });
    modal({
      title: t('settings.delete_title'),
      body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, t('settings.delete_text')), h('p', { style: { margin: 0 } }, t('settings.delete_type', { name: me.username })), confirmInput),
      actions: [{ label: t('common.cancel'), class: 'ghost', value: false }, { label: t('settings.delete_btn'), class: 'danger', onClick: async (close) => {
        if (confirmInput.value.trim().toLowerCase() !== me.username) { toast(t('settings.delete_mismatch'), 'error'); return false; }
        try {
          for (const b of ['photos', 'audio', 'avatars']) await wipe(b, me.id);
          await rpc('delete_my_account');
          close(true);
          await signOut();
          toast(t('settings.deleted'), 'ok');
          navigate('/login', { replace: true });
        } catch { toast(t('err.generic'), 'error'); return false; }
      } }],
    });
  }

  const langSeg = seg(t('settings.language'), LANGS.map(([c, l]) => [c, l]), getLang(), (v) => save({ lang: v }, { reload: true }));
  const themeSeg = seg(t('settings.theme'), [['light', t('settings.theme_light')], ['dark', t('settings.theme_dark')], ['system', t('settings.theme_system')]], cur.theme || themePref(), (v) => save({ theme: v }));
  const visSeg = seg(t('settings.visibility'), [['private', t('compose.vis_private')], ['public', t('compose.vis_public')]], cur.default_visibility || 'private', (v) => save({ default_visibility: v }));

  const el = h('div', { class: 'settings' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.settings'))),
    h('section', { class: 'panel' }, h('h2', null, t('settings.view')),
      row(t('settings.language'), t('settings.language_text'), langSeg),
      row(t('settings.theme'), '', themeSeg),
      row(t('settings.reduce'), t('settings.reduce_text'), sw('reduce_motion'))),
    h('section', { class: 'panel' }, h('h2', null, t('settings.writing')),
      row(t('settings.visibility'), t('settings.visibility_text'), visSeg),
      row(t('settings.voice'), t('settings.voice_text'), sw('voice')),
      row(t('settings.ai'), t('settings.ai_text'), sw('use_ai', true))),
    h('section', { class: 'panel' }, h('h2', null, t('settings.account')),
      h('p', { class: 'muted small' }, t('settings.signed_as', { name: '@' + me.username })),
      row(t('settings.password'), '', h('button', { class: 'btn ghost small', type: 'button', onclick: passwordModal }, t('settings.change'))),
      row(t('settings.export'), t('settings.export_text'), h('button', { class: 'btn ghost small', type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; try { await exportData(); } catch { toast(t('err.generic'), 'error'); } e.currentTarget.disabled = false; } }, icon('download', 16), t('settings.export_btn'))),
      row(t('nav.logout'), '', h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await signOut(); navigate('/login', { replace: true }); } }, icon('logout', 16), t('nav.logout'))),
      row(t('settings.delete_title'), t('settings.delete_hint'), h('button', { class: 'btn danger small', type: 'button', onclick: deleteAccount }, t('settings.delete_btn')))),
    h('p', { class: 'small muted' }, h('a', { href: '/privacy' }, t('nav.privacy')), ' · ', h('a', { href: 'mailto:' + CONFIG.SUPPORT_EMAIL }, t('settings.support'))));
  return { el, title: t('nav.settings') };
}
