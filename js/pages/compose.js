// Новая запись и редактирование. Справа живой предпросмотр воспоминания: он пересобирается при каждом изменении.
import { h, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { sb } from '../core/supabase.js';
import { state, settings } from '../core/state.js';
import { rpc, callAi, handleFail, signedUrls, removeFiles, forgetSigned } from '../core/api.js';
import { toast, spinner, setHint, fmtDate } from '../core/ui.js';
import { prepareImage, loadImage, toUploadItem, blobToBase64 } from '../core/media.js';
import { t, getLang } from '../i18n/index.js';
import { analyzeText, mergeTextSignals } from '../memory/text-analysis.js';
import { buildMemory, explain, hashSeed } from '../memory/engine.js';
import { featuresFromImage, mergePhotoFeatures } from '../memory/image-features.js';
import { createPlayer, renderCover } from '../memory/render.js';
import { localTitle } from '../memory/title.js';
import { searchLinks } from '../memory/music.js';
import { checkText } from '../moderation/text.js';
import { musicSection } from './compose-music.js';
import { renderData, weatherLabel } from './memory-data.js';
import { MOODS } from './parts.js';

const MAX_PHOTOS = 6;
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export default async function page({ params, navigate }) {
  const editId = params.id || null;
  const me = state.profile;
  const aiOn = settings().use_ai !== false;

  // ---------- исходные данные
  let old = null;
  if (editId) {
    old = await rpc('get_post', { p_id: editId });
    if (!old || old.user_id !== me.id) { toast(t('err.not_found'), 'error'); navigate('/', { replace: true }); return { el: h('div') }; }
  }
  // капсула времени: при правке подтягиваем уже написанное письмо (если оно не запечатано)
  let oldCapsule = null;
  if (editId) { try { oldCapsule = await rpc('get_capsule', { p_post: editId }); } catch { oldCapsule = null; } }
  const S = {
    id: editId || crypto.randomUUID(),
    title: old?.title || '', text: old?.text || '', mood: old?.mood || null,
    visibility: old?.visibility || settings().default_visibility || 'private',
    day: old?.day_date || today(),
    sign: old?.memory?.sign ?? (me.display_name || me.username).split(/\s+/)[0].slice(0, 30),
    variant: old?.memory?.variant || 0,
    voice: old ? !!old.voice?.on : settings().voice === true,
    weather: old?.weather || null,
    items: [],
    aiText: null,        // ответ analyze_day
    aiTitle: '',
    aiDesc: old?.ai?.description || '',
    aiInfo: old?.ai || null,
    songs: [],
    busy: false,
  };
  const seed = () => (old?.memory?.seed ?? hashSeed(S.id)) >>> 0;

  // фото из прошлой версии записи
  if (old?.photos?.length) {
    const urls = await signedUrls('photos', old.photos.map((p) => p.path));
    for (const p of old.photos) {
      if (!urls[p.path]) continue;
      try {
        const img = await loadImage(urls[p.path], true);
        S.items.push({ kind: 'old', path: p.path, slot: slotOf(p.path), w: p.w, h: p.h, img, url: urls[p.path] });
      } catch { /* фото недоступно, пропускаем */ }
    }
  }

  // ---------- поля
  const title = h('input', { class: 'input', id: 'c-title', maxlength: '80', value: S.title, autocomplete: 'off' });
  const text = h('textarea', { class: 'textarea', id: 'c-text', maxlength: '1000', placeholder: t('compose.text_ph'), style: { minHeight: '170px' } });
  text.value = S.text;
  const counter = h('span', { class: 'counter' });
  const paintCounter = () => { const n = text.value.length; counter.textContent = `${n} / 1000`; counter.classList.toggle('over', n > 1000); };
  paintCounter();
  const dateIn = h('input', { class: 'input', type: 'date', id: 'c-date', value: S.day, max: today() });
  const signIn = h('input', { class: 'input', id: 'c-sign', maxlength: '30', value: S.sign });

  const photoGrid = h('div', { class: 'photo-grid' });
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sr', tabindex: '-1', id: 'c-files' });
  function paintPhotos() {
    photoGrid.replaceChildren(
      ...S.items.map((it, i) => h('div', { class: 'photo-tile' }, h('img', { src: it.url, alt: t('compose.photo_n', { n: i + 1 }) }),
        h('button', { type: 'button', 'aria-label': t('common.remove'), onclick: () => { S.items.splice(i, 1); paintPhotos(); schedule(); } }, icon('x', 14)))),
      S.items.length < MAX_PHOTOS ? h('button', { type: 'button', class: 'photo-add', onclick: () => fileIn.click(), 'aria-label': t('compose.add_photo') }, icon('plus', 22), h('span', { class: 'small' }, `${S.items.length}/${MAX_PHOTOS}`)) : null);
  }
  fileIn.addEventListener('change', async () => {
    const files = [...fileIn.files].slice(0, MAX_PHOTOS - S.items.length);
    fileIn.value = '';
    for (const f of files) {
      try {
        const r = await prepareImage(f);
        S.items.push({ kind: 'new', slot: null, w: r.w, h: r.h, img: r.img, url: r.url, blob: r.blob });
      } catch { toast(t('compose.photo_bad'), 'error'); }
    }
    paintPhotos(); schedule();
  });

  const moodChips = h('div', { class: 'chips', role: 'group', 'aria-label': t('compose.mood') },
    ...MOODS.map((m) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(S.mood === m), onclick: (e) => {
      S.mood = S.mood === m ? null : m;
      moodChips.querySelectorAll('.chip').forEach((c, i) => c.setAttribute('aria-pressed', String(MOODS[i] === S.mood)));
      schedule();
    } }, t(`mood.${m}`))));

  const music = musicSection({ initial: old?.music, aiEnabled: aiOn, onChange: () => schedule() });

  const vis = h('div', { class: 'seg', role: 'group', 'aria-label': t('compose.visibility') },
    ...['private', 'public'].map((v) => h('button', { type: 'button', 'aria-pressed': String(S.visibility === v), onclick: (e) => {
      S.visibility = v;
      vis.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['private', 'public'][i] === v)));
    } }, t(`compose.vis_${v}`))));
  const visHint = h('div', { class: 'hint' }, t('compose.vis_hint'));

  const voiceSw = h('input', { type: 'checkbox', checked: S.voice });
  voiceSw.addEventListener('change', () => { S.voice = voiceSw.checked; });

  // погода только с согласия: браузер спросит геолокацию, сохраняем код и температуру, не координаты
  const wxSw = h('input', { type: 'checkbox', checked: !!S.weather });
  const wxHint = h('div', { class: 'hint' }, S.weather ? weatherLabel(S.weather) : t('compose.weather_hint'));
  wxSw.addEventListener('change', async () => {
    if (!wxSw.checked) { S.weather = null; setHint(wxHint, t('compose.weather_hint')); return schedule(); }
    setHint(wxHint, t('compose.weather_loading'));
    try {
      const pos = await new Promise((ok, no) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(ok, no, { timeout: 9000, maximumAge: 600000 }) : no(new Error('geo')));
      const lat = pos.coords.latitude.toFixed(1), lon = pos.coords.longitude.toFixed(1);
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`);
      const j = await r.json();
      S.weather = { temp: Math.round(j.current.temperature_2m), code: j.current.weather_code };
      setHint(wxHint, weatherLabel(S.weather), 'ok');
    } catch {
      wxSw.checked = false; S.weather = null;
      setHint(wxHint, t('compose.weather_fail'), 'bad');
    }
    schedule();
  });

  // ---------- блок ИИ
  const suggestions = h('div', { class: 'chips' });
  const aiNote = h('div', { class: 'hint', 'aria-live': 'polite' }, aiOn ? '' : t('compose.ai_off'));
  const aiBtns = {};
  const mkAi = (key, label, fn, ic = 'sparkle') => (aiBtns[key] = h('button', { type: 'button', class: `btn ${key === 'all' ? '' : 'ghost'} small`, disabled: !aiOn, onclick: async () => {
    if (S.busy) return;
    S.busy = true; Object.values(aiBtns).forEach((b) => (b.disabled = true));
    try { await fn(); } catch { toast(t('err.ai_failed'), 'error'); }
    S.busy = false; Object.values(aiBtns).forEach((b) => (b.disabled = !aiOn));
  } }, icon(ic, 16), label));

  async function aiDescribe() {
    if (!S.items.length) { toast(t('compose.ai_need_photo'), 'error'); return; }
    setHint(aiNote, t('compose.ai_busy'));
    const imgs = [];
    for (const it of S.items.slice(0, 3)) {
      const c = document.createElement('canvas'); const k = Math.min(1, 768 / Math.max(it.img.naturalWidth, it.img.naturalHeight));
      c.width = Math.round(it.img.naturalWidth * k); c.height = Math.round(it.img.naturalHeight * k);
      c.getContext('2d').drawImage(it.img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
      imgs.push({ mime: 'image/jpeg', data: await blobToBase64(blob) });
    }
    const r = await callAi('describe_photos', { images: imgs });
    if (!r?.ok) { setHint(aiNote, ''); return void (await handleFail(r, { navigate }) || toast(t('err.ai_failed'), 'error')); }
    S.aiDesc = r.description;
    S.aiInfo = { description: r.description, scene: r.scene, tags: r.tags };
    S.aiText = { ...(S.aiText || {}), ok: true, time_of_day: r.time_of_day, season: r.season, weather: r.weather };
    const cur = text.value.trim();
    const add = r.description;
    if (!cur) text.value = add.slice(0, 1000);
    else if ((cur + '\n\n' + add).length <= 1000) text.value = cur + '\n\n' + add;
    else toast(t('compose.ai_no_room'), 'info');
    paintCounter();
    setHint(aiNote, t('compose.ai_desc_done'), 'ok');
    schedule();
  }

  async function aiTemplateAndMusic() {
    if (!text.value.trim() && !S.aiDesc) { toast(t('compose.ai_need_text'), 'error'); return; }
    setHint(aiNote, t('compose.ai_busy'));
    const [a, m] = await Promise.all([
      callAi('analyze_day', { text: text.value.trim(), photo_description: S.aiDesc || undefined, mood: S.mood || undefined, song: music.hasSong() ? { title: music.state.title, artist: music.state.artist } : undefined }),
      callAi('suggest_music', { text: text.value.trim(), photo_description: S.aiDesc || undefined, mood: S.mood || undefined }),
    ]);
    if (a?.ok) { S.aiText = { ...(S.aiText || {}), ...a }; S.aiTitle = a.title || ''; }
    else if (a?.code === 'banned' || a?.code === 'muted') return void (await handleFail(a, { navigate }));
    if (m?.ok && m.songs?.length) { S.songs = m.songs; paintSongs(); }
    setHint(aiNote, a?.ok || m?.ok ? t('compose.ai_done') : '', a?.ok || m?.ok ? 'ok' : '');
    if (!a?.ok && !m?.ok) toast(t('err.ai_failed'), 'error');
    schedule();
  }

  function paintSongs() {
    suggestions.replaceChildren(...S.songs.map((s) => h('button', { type: 'button', class: 'chip', title: s.why, onclick: () => { music.setSong(s); toast(t('compose.song_picked', { name: `${s.artist} · ${s.title}` }), 'ok'); } }, icon('music', 14), `${s.artist} · ${s.title}`)));
  }

  const aiBox = h('div', { class: 'ai-box' },
    h('div', { class: 'row wrap' },
      mkAi('tpl', t('compose.ai_tpl'), aiTemplateAndMusic),
      mkAi('photo', t('compose.ai_photo'), aiDescribe, 'image'),
      mkAi('all', t('compose.ai_all'), async () => { if (S.items.length) await aiDescribe(); await aiTemplateAndMusic(); })),
    aiNote, suggestions,
    h('p', { class: 'hint', style: { display: 'block' } }, t('compose.ai_privacy')));

  // ---------- предпросмотр
  const canvas = h('canvas', { role: 'img', 'aria-label': t('compose.preview_alt') });
  const why = h('ul', { class: 'small muted', style: { margin: 0, paddingLeft: '1.1em', display: 'grid', gap: '4px' } });
  const previewStatus = h('div', { class: 'hint', style: { justifyContent: 'center' } });
  let player = null, buildSeq = 0, current = null;

  function signals() {
    let tx = analyzeText([text.value, S.aiDesc].filter(Boolean).join(' '));
    if (S.aiText) tx = mergeTextSignals(tx, S.aiText);
    const feats = S.items.map((it) => featuresFromImage(it.img));
    return { text: tx, photos: feats.length ? mergePhotoFeatures(feats) : null, music: music.resolved(), mood: S.mood, weather: S.weather, date: S.day };
  }
  const effTitle = (sig) => title.value.trim() || S.aiTitle || localTitle(text.value, sig.text, getLang());
  function makeMemory() {
    const sig = signals();
    return { sig, memory: buildMemory(sig, { seed: seed(), sign: S.sign.trim(), variant: S.variant }) };
  }

  async function rebuild() {
    const my = ++buildSeq;
    const { sig, memory } = makeMemory();
    const ttl = effTitle(sig);
    title.placeholder = ttl;
    current = { memory, title: ttl };
    why.replaceChildren(...explain(memory, getLang()).map((l) => h('li', null, l)));
    try {
      const p = await createPlayer(canvas, memory, renderData({ photos: S.items.map((i) => i.img), title: ttl, day: S.day, music: music.toJson(), weather: S.weather, sign: S.sign.trim(), scale: 0.6 }));
      if (my !== buildSeq) { p.destroy(); return; }
      player?.destroy(); player = p; p.play();
    } catch (e) { console.warn('preview', e); }
  }
  const schedule = debounce(rebuild, 420);

  text.addEventListener('input', () => { paintCounter(); schedule(); });
  title.addEventListener('input', schedule);
  dateIn.addEventListener('change', () => { S.day = dateIn.value || today(); schedule(); });
  signIn.addEventListener('input', () => { S.sign = signIn.value; schedule(); });

  const reroll = h('button', { type: 'button', class: 'btn ghost small', onclick: () => { S.variant++; rebuild(); } }, icon('dice', 16), t('compose.reroll'));

  // ---------- капсула времени
  const capHas = !!oldCapsule?.exists;
  const capSealed = capHas && oldCapsule.sealed;
  const capText = h('textarea', { class: 'textarea', id: 'c-capsule', maxlength: '800', placeholder: t('capsule.ph'), style: { minHeight: '110px' } });
  capText.value = capHas && !capSealed ? (oldCapsule.body || '') : '';
  const capSeal = h('select', { class: 'select', id: 'c-seal', 'aria-label': t('capsule.seal') },
    capHas && oldCapsule.opens_on ? h('option', { value: 'keep' }, t('capsule.opt_keep', { date: fmtDate(oldCapsule.opens_on) })) : null,
    h('option', { value: 'now' }, t('capsule.opt_now')), h('option', { value: 'month' }, t('capsule.opt_month')),
    h('option', { value: 'half' }, t('capsule.opt_half')), h('option', { value: 'year' }, t('capsule.opt_year')));
  if (!(capHas && oldCapsule.opens_on)) capSeal.value = 'now';
  let capTouched = false;
  capText.addEventListener('input', () => { capTouched = true; });
  capSeal.addEventListener('change', () => { capTouched = true; });
  const capOpensDate = () => {
    const v = capSeal.value;
    if (v === 'keep') return oldCapsule.opens_on;
    const d = new Date(); d.setHours(12, 0, 0, 0);
    if (v === 'month') d.setMonth(d.getMonth() + 1);
    else if (v === 'half') d.setMonth(d.getMonth() + 6);
    else if (v === 'year') d.setFullYear(d.getFullYear() + 1);
    else return null;
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  // сохраняем письмо после записи; сбой письма не отменяет сохранённую запись
  async function saveCapsule() {
    const txt = capText.value.trim();
    if (editId && !capTouched) return true;
    if (capSealed && !txt) return true; // письмо запечатано, текста мы не видели: ничего не меняем
    if (!editId && !txt) return true;
    try {
      const r = await rpc('set_capsule', { p_post: S.id, p_body: txt, p_opens: txt ? capOpensDate() : null });
      return r?.ok !== false;
    } catch { return false; }
  }

  // ---------- публикация
  const publishBtn = h('button', { type: 'button', class: 'btn', style: { minWidth: '180px' } }, editId ? t('compose.save') : t('compose.publish'));
  const progress = h('div', { class: 'hint', 'aria-live': 'polite', style: { justifyContent: 'flex-start' } });

  const uploaded = [];   // что мы уже положили в Storage в этом запуске (убираем при ошибке)
  async function uploadBatches(kind, items) {
    const out = [];
    for (let i = 0; i < items.length; i += 4) {
      const batch = items.slice(i, i + 4);
      const r = await callAi('upload_images', { kind, post_id: S.id, items: await Promise.all(batch.map((b) => toUploadItem(b.name, b.blob))) });
      if (!r?.ok) return { fail: r };
      for (const f of r.files) { out.push(f); uploaded.push({ b: 'photos', p: f.path }); }
    }
    return { files: out };
  }

  async function publish() {
    if (S.busy) return;
    const body = text.value.trim();
    if (!body && !S.items.length) return toast(t('compose.empty'), 'error');
    if (body.length > 1000) return toast(t('err.too_long'), 'error');
    const pre = checkText((title.value || '') + '\n' + body);
    if (!pre.ok && pre.code === 'forbidden') return toast(t('err.forbidden_text'), 'error');

    S.busy = true; publishBtn.disabled = true;
    uploaded.length = 0;
    try {
      progress.replaceChildren(spinner2(), t('compose.p_cover'));
      const { sig, memory } = makeMemory();
      const ttl = effTitle(sig);
      const photos = S.items.map((i) => i.img);
      const coverBlob = await renderCover(memory, renderData({ photos, title: ttl, day: S.day, music: music.toJson(), weather: S.weather, sign: S.sign.trim() }));

      // слоты: 0..5 для фото, старые сохраняют свой номер
      const used = new Set(S.items.filter((i) => i.kind === 'old').map((i) => i.slot));
      const fresh = S.items.filter((i) => i.kind === 'new');
      let slot = 0;
      for (const it of fresh) { while (used.has(slot)) slot++; it.slot = slot; used.add(slot); }

      progress.replaceChildren(spinner2(), t('compose.p_check'));
      const up = await uploadBatches('post', fresh.map((it) => ({ name: String(it.slot), blob: it.blob })));
      if (up.fail) { await cleanup(); await handleFail(up.fail, { navigate }); return; }
      const photoByName = Object.fromEntries(up.files.map((f) => [f.name, f.path]));

      const cov = await uploadBatches('post', [{ name: 'memory', blob: coverBlob }]);
      if (cov.fail) { await cleanup(); await handleFail(cov.fail, { navigate }); return; }
      const coverPath = cov.files[0].path;

      let audioPath = null;
      const st = music.state;
      if (st.audioFile) {
        progress.replaceChildren(spinner2(), t('compose.p_audio'));
        const ext = (st.audioFile.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'mp3').toLowerCase();
        audioPath = `${me.id}/${S.id}.${ext}`;
        const { error } = await sb.storage.from('audio').upload(audioPath, st.audioFile, { upsert: true, contentType: st.audioFile.type });
        if (error) { audioPath = null; toast(t('compose.audio_fail'), 'error'); } else uploaded.push({ b: 'audio', p: audioPath });
      }

      progress.replaceChildren(spinner2(), t('compose.p_save'));
      const payload = {
        id: S.id, title: ttl,
        text: body,
        photos: S.items.map((it) => ({ path: it.kind === 'old' ? it.path : photoByName[String(it.slot)], w: it.w, h: it.h })),
        cover_path: coverPath, mood: S.mood || '', visibility: S.visibility, day_date: S.day,
        memory, music: music.toJson(audioPath), voice: S.voice ? { on: true } : null, weather: S.weather,
        ai: S.aiInfo ? { ...S.aiInfo, used: true } : null,
      };
      const call = () => (editId ? rpc('update_post', { p_id: editId, p: payload }) : rpc('create_post', { p: payload }));
      let res = await call();

      if (res?.code === 'spam_text') {
        // фильтр спама сработал: если ИИ включён, пусть решит, реклама это или обычный день
        const j = aiOn ? await callAi('judge_text', { text: body }) : null;
        if (j?.ok && j.spam === false) res = await call();
        else { await cleanup(); toast(t('err.spam_text'), 'error'); return; }
      }
      if (!res?.ok) { await cleanup(); await handleFail(res, { navigate }); return; }

      if (editId) {
        await removeFiles('photos', res.removed_paths);
        forgetSigned('photos', [coverPath, ...(res.removed_paths || [])]);
        // замененный аудиофайл
        if (old?.music?.audio_path && old.music.audio_path !== payload.music?.audio_path) await removeFiles('audio', [old.music.audio_path]);
      }
      const capOk = await saveCapsule();
      toast(editId ? t('compose.saved') : t('compose.published'), 'ok');
      if (!capOk) toast(t('capsule.fail'), 'error', { ms: 7000 });
      navigate('/post/' + S.id, { replace: true });
    } catch (e) {
      console.error(e);
      await cleanup();
      toast(t('err.generic'), 'error');
    } finally {
      S.busy = false; publishBtn.disabled = false; progress.replaceChildren();
    }
  }

  // файлы старой записи не трогаем: чистим только то, что загрузили сами. Для редактирования обложка перезаписана на месте.
  async function cleanup() {
    const mine = new Set([...(old?.photos || []).map((x) => x.path), old?.cover_path, old?.music?.audio_path].filter(Boolean));
    for (const b of ['photos', 'audio']) await removeFiles(b, uploaded.filter((u) => u.b === b && !mine.has(u.p)).map((u) => u.p));
    uploaded.length = 0;
  }
  publishBtn.addEventListener('click', publish);

  const sec = (label, ...kids) => h('section', null, h('h3', null, label), ...kids);
  const form = h('div', null,
    sec(t('compose.sec_text'),
      h('div', { class: 'field', style: { marginBottom: '10px' } }, h('label', { for: 'c-title' }, t('compose.title')), title, h('div', { class: 'hint' }, t('compose.title_hint'))),
      h('div', { class: 'field' }, h('label', { for: 'c-text' }, t('compose.text')), text, h('div', { class: 'hint' }, h('span', null, t('compose.text_hint')), counter))),
    sec(t('capsule.title'),
      h('p', { class: 'hint', style: { display: 'block', marginTop: 0 } }, t('capsule.hint')),
      capSealed ? h('p', { class: 'hint', style: { display: 'block' } }, t('capsule.sealed_note', { date: fmtDate(oldCapsule.opens_on) })) : null,
      h('div', { class: 'field' }, capText),
      h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { for: 'c-seal' }, t('capsule.seal')), capSeal)),
    sec(t('compose.sec_photos'), photoGrid, fileIn, h('div', { class: 'hint' }, t('compose.photos_hint'))),
    sec(t('compose.sec_ai'), aiBox),
    sec(t('compose.sec_mood'), moodChips),
    sec(t('compose.sec_music'), music.el),
    sec(t('compose.sec_extra'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { for: 'c-date' }, t('compose.date')), dateIn),
        h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { for: 'c-sign' }, t('compose.sign')), signIn)),
      h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', null, t('compose.weather')), wxHint), h('label', { class: 'switch' }, wxSw, h('i'))),
      h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', null, t('compose.voice')), h('span', null, t('compose.voice_hint'))), h('label', { class: 'switch' }, voiceSw, h('i')))),
    sec(t('compose.visibility'), vis, visHint),
    h('div', { class: 'row wrap' }, publishBtn, h('a', { class: 'btn ghost', href: editId ? '/post/' + editId : '/' }, t('common.cancel'))),
    progress);

  const el = h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, editId ? t('compose.edit_title') : t('compose.new_title'))),
    h('div', { class: 'compose' }, form,
      h('aside', { class: 'compose-preview', 'aria-label': t('compose.preview') },
        canvas, h('div', { class: 'row', style: { justifyContent: 'center' } }, reroll), previewStatus,
        h('div', { class: 'panel', style: { padding: '14px 16px' } }, h('b', { class: 'small' }, t('compose.why')), why))));

  paintPhotos();
  setTimeout(rebuild, 0);
  return { el, title: editId ? t('compose.edit_title') : t('compose.new_title'), destroy: () => { player?.destroy(); schedule.cancel(); S.items.forEach((i) => i.kind === 'new' && URL.revokeObjectURL(i.url)); } };
}

const spinner2 = () => h('span', { class: 'spinner', style: { width: '14px', height: '14px', borderWidth: '2px' } });
function slotOf(path) {
  const m = path.match(/\/(\d)\.[a-z]+$/i);
  return m ? Number(m[1]) : 0;
}
export { searchLinks };
