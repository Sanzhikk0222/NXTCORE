// Песня дня: ссылка или свой файл, описание, оценка звучания.
// Авторские права: песни не хранятся и не раздаются. Для ссылок строится официальный
// плеер сервиса, свой файл лежит в приватной папке автора и слышен только ему.

import { clamp } from './color.js';

// ------------------------------------------------------------------ ссылки
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|webm)(\?.*)?$/i;

export function parseMusicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const href = u.toString();

  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') {
    let id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
    if (m) id = m[1];
    if (id && /^[\w-]{11}$/.test(id.slice(0, 11))) {
      id = id.slice(0, 11);
      return { provider: 'youtube', id, url: href, embed: `https://www.youtube-nocookie.com/embed/${id}`, height: 220 };
    }
    return { provider: 'youtube', url: href, embed: null };
  }
  if (host === 'open.spotify.com') {
    const m = u.pathname.match(/\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/);
    if (m) return { provider: 'spotify', id: m[2], url: href, embed: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, height: m[1] === 'track' ? 152 : 232 };
  }
  if (host === 'soundcloud.com') {
    return { provider: 'soundcloud', url: href, embed: `https://w.soundcloud.com/player/?url=${encodeURIComponent(href)}&visual=false`, height: 166 };
  }
  if (host === 'music.apple.com') {
    return { provider: 'apple', url: href, embed: `https://embed.music.apple.com${u.pathname}${u.search}`, height: 175 };
  }
  if (host === 'music.yandex.ru' || host === 'music.yandex.kz') {
    const m = u.pathname.match(/\/album\/(\d+)\/track\/(\d+)/);
    if (m) return { provider: 'yandex', url: href, embed: `https://music.yandex.ru/iframe/track/${m[2]}/${m[1]}`, height: 100 };
    return { provider: 'yandex', url: href, embed: null };
  }
  if (AUDIO_EXT.test(u.pathname)) return { provider: 'audio', url: href, embed: null, direct: true };
  return { provider: 'other', url: href, embed: null };
}

export const PROVIDER_LABEL = {
  youtube: 'YouTube', spotify: 'Spotify', soundcloud: 'SoundCloud', apple: 'Apple Music',
  yandex: 'Яндекс Музыка', audio: 'Аудио', other: 'Ссылка', file: 'Свой файл',
};

// Название и автор из oEmbed. Если сервис не отвечает, человек впишет сам.
export async function fetchSongMeta(link, signal) {
  const endpoints = {
    youtube: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`,
    spotify: (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}`,
    soundcloud: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  };
  const make = endpoints[link?.provider];
  if (!make) return null;
  try {
    const res = await fetch(make(link.url), { signal });
    if (!res.ok) return null;
    const d = await res.json();
    let title = String(d.title || '').trim();
    let artist = String(d.author_name || '').replace(/ - Topic$/i, '').trim();
    const dash = title.match(/^(.{2,60}?)\s[-–—]\s(.{2,100})$/);
    if (dash && link.provider !== 'spotify') { artist = dash[1].trim(); title = dash[2].trim(); }
    return { title: title.slice(0, 120), artist: artist.slice(0, 80) };
  } catch {
    return null;
  }
}

export function searchLinks(song) {
  const q = encodeURIComponent(`${song.artist || ''} ${song.title || ''}`.trim());
  return {
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    spotify: `https://open.spotify.com/search/${q}`,
  };
}

// ------------------------------------------------------------------ жанры
// Жанр → типичное звучание. Это приблизительная оценка, и в интерфейсе она так и подписана.
const GENRES = [
  [/lo-?fi|лоу-?фай/i, { bpm: 76, energy: 0.25, valence: 0.5, mode: 'minor', era: 2018 }],
  [/ambient|эмбиент/i, { bpm: 64, energy: 0.12, valence: 0.45, mode: 'minor', era: 2005 }],
  [/classic|классик|орк/i, { bpm: 72, energy: 0.25, valence: 0.5, mode: 'major', era: 1850 }],
  [/jazz|джаз|swing|свинг|bossa/i, { bpm: 96, energy: 0.35, valence: 0.62, mode: 'major', era: 1960 }],
  [/blues|блюз/i, { bpm: 82, energy: 0.38, valence: 0.35, mode: 'minor', era: 1965 }],
  [/soul|соул|funk|фанк|disco|диско/i, { bpm: 108, energy: 0.6, valence: 0.7, mode: 'major', era: 1976 }],
  [/folk|фолк|acoustic|акустик|country|кантри/i, { bpm: 100, energy: 0.35, valence: 0.6, mode: 'major', era: 1985 }],
  [/indie|инди|alternative|альтернатив/i, { bpm: 112, energy: 0.5, valence: 0.5, mode: 'major', era: 2010 }],
  [/pop|поп|эстрада/i, { bpm: 118, energy: 0.65, valence: 0.7, mode: 'major', era: 2015 }],
  [/r&?b|rnb|ритм-?н/i, { bpm: 86, energy: 0.45, valence: 0.55, mode: 'minor', era: 2012 }],
  [/hip-?hop|rap|рэп|хип-?хоп|trap|трэп/i, { bpm: 92, energy: 0.68, valence: 0.5, mode: 'minor', era: 2016 }],
  [/rock|рок|punk|панк/i, { bpm: 126, energy: 0.78, valence: 0.5, mode: 'major', era: 1995 }],
  [/metal|метал/i, { bpm: 150, energy: 0.95, valence: 0.3, mode: 'minor', era: 2000 }],
  [/synth|синт|retro-?wave|ретровейв|new wave/i, { bpm: 108, energy: 0.6, valence: 0.5, mode: 'minor', era: 1986 }],
  [/electro|электрон|edm|house|хаус|techno|техно|trance|транс|dnb|drum|dance|данс|club|клуб/i, { bpm: 126, energy: 0.86, valence: 0.5, mode: 'minor', era: 2015 }],
  [/reggae|регги|latin|латин/i, { bpm: 90, energy: 0.5, valence: 0.72, mode: 'major', era: 1990 }],
  [/kazakh|қазақ|казах|dombyra|домбыр|ән/i, { bpm: 96, energy: 0.4, valence: 0.55, mode: 'minor', era: 1990 }],
];

export function genreDefaults(genre) {
  const g = String(genre || '');
  for (const [re, f] of GENRES) if (re.test(g)) return f;
  return null;
}

// Ручные поля формы → числа
export const TEMPO_CHOICES = { slow: 70, medium: 102, fast: 138 };
export const ENERGY_CHOICES = { calm: 0.2, medium: 0.5, lively: 0.85 };

/**
 * Сводит всё, что известно о песне, в одно описание.
 * Приоритет: руки человека → анализ файла → оценка ИИ → жанр.
 */
export function resolveMusic(input) {
  if (!input) return null;
  const { meta = {}, manual = {}, audio = null, ai = null } = input;
  const base = genreDefaults(manual.genre || meta.genre || ai?.genre);
  const year = Number(manual.year || meta.year || ai?.year) || base?.era || null;

  const pick = (key, ...sources) => {
    for (const [value, label] of sources) if (Number.isFinite(value) || (typeof value === 'string' && value)) return { value, source: label };
    return { value: null, source: null };
  };

  const bpm = pick('bpm', [manual.bpm, 'manual'], [audio?.bpm, 'audio'], [ai?.bpm, 'ai'], [base?.bpm, 'genre']);
  const energy = pick('energy', [manual.energy, 'manual'], [audio?.energy, 'audio'], [ai?.energy, 'ai'], [base?.energy, 'genre']);
  const valence = pick('valence', [manual.valence, 'manual'], [audio?.valence, 'audio'], [ai?.valence, 'ai'], [base?.valence, 'genre']);
  const modeSrc = pick('mode', [manual.mode && manual.mode !== 'unknown' ? manual.mode : null, 'manual'], [audio?.mode, 'audio'], [ai?.mode && ai.mode !== 'unknown' ? ai.mode : null, 'ai'], [base?.mode, 'genre']);

  const known = bpm.value != null || energy.value != null || modeSrc.value != null;
  return {
    title: String(meta.title || '').slice(0, 120),
    artist: String(meta.artist || '').slice(0, 80),
    genre: String(manual.genre || meta.genre || ai?.genre || '').slice(0, 30),
    year,
    bpm: bpm.value != null ? Math.round(clamp(bpm.value, 40, 200)) : null,
    energy: energy.value != null ? clamp(energy.value, 0, 1) : null,
    valence: valence.value != null ? clamp(valence.value, 0, 1) : null,
    mode: modeSrc.value || 'unknown',
    brightness: audio?.brightness ?? null,
    source: audio ? 'audio' : bpm.source === 'manual' || energy.source === 'manual' ? 'manual' : ai ? 'ai' : base ? 'genre' : 'none',
    estimated: !audio && (bpm.source === 'ai' || bpm.source === 'genre'),
    known,
  };
}
