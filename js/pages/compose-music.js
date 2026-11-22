// Блок «Песня дня» в форме записи: ссылка, название и свой файл. Остальное (темп, жанр) движок определяет сам.
import { h, debounce } from '../core/dom.js';
import { toast, setHint } from '../core/ui.js';
import { callAi } from '../core/api.js';
import { t } from '../i18n/index.js';
import { parseMusicUrl, fetchSongMeta, resolveMusic, PROVIDER_LABEL, genreDefaults } from '../memory/music.js';
import { analyzeAudioFile } from '../memory/audio-analysis.js';

const MAX_AUDIO = 15 * 1024 * 1024;

export function musicSection({ initial, onChange, aiEnabled }) {
  const s = {
    url: initial?.url || '', link: initial?.url ? parseMusicUrl(initial.url) : null,
    title: initial?.title || '', artist: initial?.artist || '', genre: initial?.genre || '', year: initial?.year || '',
    tempo: '', energy: '', audioFile: null, audioInfo: null, audioPath: initial?.audio_path || null,
    audioWasAnalyzed: initial?.source === 'audio', ai: null,
    // при редактировании сохранённые числа остаются как ручные значения
    keep: initial && initial.source !== 'audio' ? { bpm: initial.bpm, energy: initial.energy, mode: initial.mode, source: initial.source } : null,
  };
  if (initial?.source === 'audio') s.audioInfo = { bpm: initial.bpm, energy: initial.energy, mode: initial.mode, valence: initial.valence, brightness: initial.brightness };
  if (initial?.estimated || initial?.source === 'ai') s.ai = { bpm: initial.bpm, energy: initial.energy, mode: initial.mode, valence: initial.valence, genre: initial.genre };

  const emit = () => onChange?.();
  const input = (id, label, key, extra = {}) => {
    const el = h('input', { class: 'input', id, value: s[key], maxlength: extra.maxlength || '120', autocomplete: 'off', ...extra });
    el.addEventListener('input', () => { s[key] = el.value; emit(); });
    return { el, wrap: h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { for: id }, label), el) };
  };

  const urlF = input('m-url', t('music.link'), 'url', { type: 'url', placeholder: 'https://', maxlength: '300' });
  const urlHint = h('div', { class: 'hint' });
  const titleF = input('m-title', t('music.title'), 'title');

  const fetchMeta = debounce(async () => {
    const link = parseMusicUrl(urlF.el.value);
    s.link = link;
    if (!urlF.el.value.trim()) { setHint(urlHint, ''); return emit(); }
    if (!link) { setHint(urlHint, t('music.link_bad'), 'bad'); return emit(); }
    setHint(urlHint, link.embed || link.direct ? t('music.link_ok', { p: PROVIDER_LABEL[link.provider] }) : t('music.link_plain'), 'ok');
    emit();
    const meta = await fetchSongMeta(link).catch(() => null);
    if (meta && urlF.el.value.trim()) {
      if (!s.title) { s.title = meta.title; titleF.el.value = meta.title; }
      if (!s.artist) s.artist = meta.artist || '';
      estimateSoon();
      emit();
    }
  }, 450);
  urlF.el.addEventListener('input', () => { s.url = urlF.el.value.trim(); fetchMeta(); });

  // свой файл
  const fileInfo = h('div', { class: 'hint' });
  const fileInput = h('input', { type: 'file', accept: 'audio/*', class: 'sr', id: 'm-file', tabindex: '-1' });
  const fileBtn = h('button', { type: 'button', class: 'btn ghost small', onclick: () => fileInput.click() }, t('music.file'));
  const fileClear = h('button', { type: 'button', class: 'btn ghost small hidden', onclick: () => { s.audioFile = null; s.audioInfo = null; s.audioPath = null; fileInput.value = ''; fileClear.classList.add('hidden'); setHint(fileInfo, ''); emit(); } }, t('common.remove'));
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (!/^audio\//.test(f.type)) { fileInput.value = ''; return toast(t('music.file_type'), 'error'); }
    if (f.size > MAX_AUDIO) { fileInput.value = ''; return toast(t('music.file_big'), 'error'); }
    setHint(fileInfo, t('music.file_analyzing'));
    try {
      const info = await analyzeAudioFile(f);
      s.audioFile = f; s.audioInfo = info; s.audioPath = null;
      if (!s.title) { s.title = f.name.replace(/\.[^.]+$/, '').slice(0, 120); titleF.el.value = s.title; }
      setHint(fileInfo, info ? t('music.file_done', { bpm: info.bpm || '?', mode: t(`music.mode_${info.mode}`) }) : t('music.file_nodata'), info ? 'ok' : '');
      fileClear.classList.remove('hidden');
      emit();
    } catch {
      s.audioFile = f; s.audioInfo = null;
      setHint(fileInfo, t('music.file_nodata'));
      fileClear.classList.remove('hidden');
      emit();
    }
  });
  if (s.audioPath) { fileClear.classList.remove('hidden'); setHint(fileInfo, t('music.file_kept'), 'ok'); }

  // оценка звучания по названию: идёт тихо, без кнопки; если ИИ недоступен, движок возьмёт значения по умолчанию
  let estSeq = 0;
  async function estimate() {
    if (!aiEnabled || s.audioInfo || !(s.title || s.artist)) return;
    const my = ++estSeq;
    const r = await callAi('song_features', { title: s.title, artist: s.artist }).catch(() => null);
    if (my !== estSeq || !r?.ok) return;
    s.ai = r; s.keep = null;
    emit();
  }
  const estimateSoon = debounce(estimate, 1200);
  titleF.el.addEventListener('input', () => { s.ai = null; estimateSoon(); });

  const el = h('div', { class: 'stack' },
    h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', { for: 'm-url' }, t('music.link')), urlF.el, urlHint),
    titleF.wrap,
    h('div', { class: 'row wrap' }, fileBtn, fileClear, fileInput),
    fileInfo);

  const api = {
    el,
    setSong(song) {
      s.title = song.title || ''; s.artist = song.artist || '';
      titleF.el.value = s.title;
      s.ai = null; s.keep = null;
      emit();
      estimateSoon();
    },
    setAi(est) { s.ai = est; s.keep = null; emit(); },
    hasSong: () => !!(s.title || s.artist || s.url || s.audioFile || s.audioPath),
    get state() { return s; },
    resolved() {
      const manual = {};
      if (s.keep) {
        if (s.keep.source === 'manual') { manual.bpm = s.keep.bpm; manual.energy = s.keep.energy; if (s.keep.mode && s.keep.mode !== 'unknown') manual.mode = s.keep.mode; }
        else if (!s.ai) s.ai = { bpm: s.keep.bpm, energy: s.keep.energy, mode: s.keep.mode, genre: s.genre };
      }
      if (!s.title && !s.artist && !s.audioInfo && !s.ai && !manual.bpm && !manual.energy) return null;
      return resolveMusic({ meta: { title: s.title, artist: s.artist, genre: s.genre }, manual, audio: s.audioInfo, ai: s.ai });
    },
    // то, что уйдёт в базу (audio_path подставляет форма после загрузки файла)
    toJson(audioPath) {
      const r = api.resolved();
      if (!r && !s.link) return null;
      const out = { ...(r || {}) };
      if (s.link?.provider && s.link.provider !== 'other') out.provider = s.link.provider;
      if (s.link) out.url = s.link.url;
      if (audioPath || s.audioPath) out.audio_path = audioPath || s.audioPath;
      return out;
    },
  };
  return api;
}

export { genreDefaults };
