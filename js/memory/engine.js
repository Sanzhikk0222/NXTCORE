// Движок воспоминаний NXTCORE.
// Превращает сигналы дня (текст, фото, песня, погода, настроение) в параметры визуальной системы.
// Всё детерминировано и объяснимо: у каждого решения есть причина, которую видно человеку.
// Без DOM: проверяется в Node (tests/engine.test.mjs).

import { oklchHex, ensureContrast, clamp, lerp, hueDistance, mixHue } from './color.js';

export const TECHNIQUES = ['impressionist', 'kandinsky', 'film', 'collage', 'ma'];

// Постоянные элементы серии: одинаковы в каждом дне
export const FRAME = {
  ratio: [4, 5],
  margin: 0.05,        // доля ширины
  window: { top: 0.095, bottom: 0.215 }, // окно с фото: доли высоты сверху и снизу
  fonts: { title: '"Playfair Display", Georgia, serif', ui: 'Inter, system-ui, sans-serif', hand: 'Caveat, "Segoe Script", cursive' },
};

// Приёмы и референсы: нужны и движку, и описанию для жюри
export const TECHNIQUE_INFO = {
  impressionist: { ref: 'Клод Моне', moods: 'спокойные, светлые дни на воздухе' },
  kandinsky: { ref: 'Василий Кандинский', moods: 'напряжённые, быстрые, ночные дни' },
  film: { ref: 'Плёночная фотография', moods: 'дни с воспоминаниями и теплом' },
  collage: { ref: 'Коллаж и бумажные вырезки', moods: 'шумные дни с людьми и событиями' },
  ma: { ref: 'Японская графика и принцип «ма» (пауза, пустота)', moods: 'тихие, холодные, одинокие дни' },
};

const TOD_LIGHT = { night: 0.2, evening: 0.45, morning: 0.68, day: 0.82, unknown: null };
const WEATHER_LIGHT = { clear: 0.78, cloudy: 0.5, rain: 0.38, fog: 0.5, snow: 0.82, unknown: null };
const SEASON_WARM = { summer: 0.66, autumn: 0.6, spring: 0.52, winter: 0.34, unknown: null };

// Тёплые цвета идут через жёлтый и оранжевый, холодные через голубой: без розового посередине
const HUE_RAMP = [[0, 250], [0.3, 205], [0.5, 125], [0.65, 82], [0.82, 56], [1, 36]];
function hueForWarmth(w) {
  w = clamp(w, 0, 1);
  for (let i = 1; i < HUE_RAMP.length; i++) {
    if (w <= HUE_RAMP[i][0]) {
      const [w0, h0] = HUE_RAMP[i - 1], [w1, h1] = HUE_RAMP[i];
      return lerp(h0, h1, (w - w0) / (w1 - w0));
    }
  }
  return HUE_RAMP.at(-1)[1];
}

function fuse(parts) {
  let s = 0, w = 0;
  for (const p of parts) if (p && Number.isFinite(p[0])) { s += p[0] * p[1]; w += p[1]; }
  return w ? s / w : null;
}

export function hashSeed(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * signals: {
 *   text:   результат analyzeText / mergeTextSignals
 *   photos: результат mergePhotoFeatures или null
 *   music:  результат resolveMusic или null
 *   mood:   'warm' | 'cold' | 'energetic' | null (выбрал человек)
 *   weather:{temp, code} | null (с согласия человека)
 *   date:   'YYYY-MM-DD'
 * }
 * opts: { seed, sign, variant }
 */
export function buildMemory(signals, opts = {}) {
  const text = signals.text || {};
  const photos = signals.photos || null;
  const music = signals.music?.known ? signals.music : null;
  const mood = signals.mood || null;
  const why = [];

  const tod = text.time_of_day && text.time_of_day !== 'unknown' ? text.time_of_day : 'unknown';
  const season = text.season && text.season !== 'unknown' ? text.season : seasonFromDate(signals.date);
  const wx = text.weather && text.weather !== 'unknown' ? text.weather : weatherFromCode(signals.weather?.code);
  const temp = Number.isFinite(signals.weather?.temp) ? signals.weather.temp : null;

  // ---- ось за осью: текст 0.5, музыка 0.3, фото 0.2
  const bpmNorm = music?.bpm ? clamp((music.bpm - 60) / 110, 0, 1) : null;
  let arousal = fuse([
    [text.arousal, 0.5],
    music ? [fuse([[music.energy, 0.6], [bpmNorm, 0.4]]), 0.35] : null,
    photos ? [clamp(photos.colorful * 0.4 + photos.contrast * 0.6, 0, 1) * 0.85, 0.1] : null,
  ]) ?? 0.45;
  if (mood === 'energetic') arousal += 0.2;
  if (wx === 'rain' || wx === 'fog' || wx === 'snow') arousal -= 0.05;
  arousal = clamp(arousal, 0, 1);

  const tension = clamp(
    fuse([[text.tension, 0.65], [arousal * (music?.mode === 'minor' ? 1 : 0.5), 0.35]]) ?? 0.2, 0, 1);

  let valence = fuse([
    [((text.valence ?? 0) + 1) / 2, 0.5],
    music?.valence != null ? [music.valence - (music.mode === 'minor' ? 0.04 : 0), 0.3] : null,
    photos ? [photos.light * 0.45 + photos.warmth * 0.35 + 0.1, 0.1] : null,
  ]) ?? 0.5;
  valence = clamp(valence, 0, 1);

  let warmth = fuse([
    [text.warmth, 0.4],
    photos ? [photos.warmth, 0.25] : null,
    music ? [music.mode === 'major' ? 0.58 : music.mode === 'minor' ? 0.42 : 0.5, 0.1] : null,
    SEASON_WARM[season] != null ? [SEASON_WARM[season], 0.1] : null,
    temp != null ? [clamp((temp + 10) / 40, 0, 1), 0.2] : null,
  ]) ?? 0.5;
  if (mood === 'warm') warmth += 0.25;
  if (mood === 'cold') warmth -= 0.25;
  warmth = clamp(warmth, 0, 1);

  const light = clamp(
    fuse([
      photos ? [photos.light, 0.4] : null,
      TOD_LIGHT[tod] != null ? [TOD_LIGHT[tod], 0.35] : null,
      WEATHER_LIGHT[wx] != null ? [WEATHER_LIGHT[wx], 0.15] : null,
      [0.35 + valence * 0.4, 0.1],
    ]) ?? 0.6, 0, 1);

  const eraNostalgia = music?.year ? clamp((2026 - music.year) / 45, 0, 1) : null;
  const nostalgia = clamp(fuse([[text.nostalgia, 0.6], eraNostalgia != null ? [eraNostalgia, 0.3] : null]) ?? 0.2, 0, 1);
  const social = clamp(fuse([[text.social, 0.65], photos ? [clamp((photos.count - 1) / 4, 0, 1), 0.1] : null]) ?? 0.25, 0, 1);
  const outdoor = text.outdoor ?? 0.15;

  const vec = { arousal, valence, warmth, light, nostalgia, tension, social, outdoor };
  const quietWeather = wx === 'snow' || wx === 'fog';
  const electronic = music?.genre && /electro|электрон|edm|house|хаус|techno|техно|trance|dnb|synth/i.test(music.genre);
  const slowMinor = music && music.bpm && music.bpm < 90 && music.mode === 'minor';

  // ---- выбор техники: у каждого слагаемого есть причина
  const score = {
    impressionist: [
      ['calm', (1 - arousal) * 0.34], ['outdoor', outdoor * 0.2], ['warm', warmth * 0.16],
      ['bright', light * 0.14], ['happy', valence * 0.12],
    ],
    kandinsky: [
      ['lively', arousal * 0.34], ['tense', tension * 0.4], ['cold', (1 - warmth) * 0.1],
      ['night', tod === 'night' ? 0.1 : 0], ['electronic', electronic ? 0.12 : 0], ['minorFast', music?.mode === 'minor' && arousal > 0.55 ? 0.08 : 0],
    ],
    film: [
      ['nostalgic', nostalgia * 0.52], ['warm', warmth * 0.14], ['oldSong', eraNostalgia != null ? eraNostalgia * 0.14 : 0],
      ['evening', tod === 'evening' ? 0.1 : 0], ['social', social * 0.08],
    ],
    collage: [
      ['social', social * 0.36], ['lively', arousal * 0.24], ['happy', valence * 0.2],
      ['manyPhotos', photos ? clamp((photos.count - 1) / 4, 0, 1) * 0.12 : 0], ['party', mood === 'energetic' ? 0.1 : 0],
    ],
    ma: [
      ['calm', (1 - arousal) * 0.26], ['cold', (1 - warmth) * 0.22], ['solitude', (1 - social) * 0.22],
      ['quietWeather', quietWeather ? 0.16 : 0], ['slowMinor', slowMinor ? 0.12 : 0], ['relaxed', (1 - tension) * 0.1],
    ],
  };
  const rand = rng(hashSeed(`${opts.seed ?? 0}|tech`));
  const totals = TECHNIQUES.map((t) => [t, score[t].reduce((s, [, v]) => s + v, 0) + rand() * 0.012]);
  totals.sort((a, b) => b[1] - a[1]);
  const technique = totals[0][0];
  const second = totals[1][1] > totals[0][1] - 0.05 ? totals[1][0] : null;
  const reasons = score[technique].filter(([, v]) => v >= 0.07).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  why.push({ k: 'tech', p: { technique, reasons, second } });

  // ---- темп и ритм
  const bpm = music?.bpm ?? Math.round(70 + arousal * 70);
  const interval = clamp((8 * 60) / bpm, 2.6, 8);
  const motion = clamp(0.2 + arousal * 0.7 + (music?.energy ?? 0) * 0.1, 0.1, 1);
  const air = clamp(lerp(0.62, 0.12, arousal * 0.6 + (music?.energy ?? arousal) * 0.4), 0.1, 0.65);
  const contrast = clamp(0.25 + arousal * 0.35 + tension * 0.3 + (music?.energy ?? 0) * 0.1, 0, 1);
  const grain = clamp(0.12 + nostalgia * 0.55 + (technique === 'film' ? 0.2 : 0), 0, 1);
  if (music?.bpm) why.push({ k: 'tempo', p: { bpm: music.bpm, interval: +interval.toFixed(1), slow: music.bpm < 90 } });
  else why.push({ k: 'tempoGuess', p: { bpm, interval: +interval.toFixed(1) } });
  if (music?.mode === 'minor') why.push({ k: 'minor', p: {} });
  if (music?.mode === 'major') why.push({ k: 'major', p: {} });
  if ((music?.energy ?? 0) > 0.7) why.push({ k: 'energy', p: {} });
  if (eraNostalgia != null && eraNostalgia > 0.45) why.push({ k: 'era', p: { year: music.year } });

  // ---- палитра
  const moodHue = hueForWarmth(warmth);
  const photoWeight = photos?.hue != null ? clamp(0.2 + photos.colorful * 0.55, 0, 0.7) : 0;
  let hue = photos?.hue != null ? mixHue(moodHue, photos.hue, photoWeight) : moodHue;
  if (music?.mode === 'minor') hue = mixHue(hue, 250, 0.12);
  if (music?.mode === 'major') hue = mixHue(hue, 70, 0.06);

  let chroma = 0.035 + 0.115 * clamp(arousal * 0.45 + valence * 0.3 + (photos?.colorful ?? 0.4) * 0.25, 0, 1);
  if (music?.mode === 'minor') chroma *= 0.8;
  if (music?.mode === 'major') chroma *= 1.08;
  if (wx === 'rain' || wx === 'fog') chroma *= 0.72;
  if (technique === 'ma') chroma *= 0.6;
  if (technique === 'kandinsky') chroma *= 1.25;
  chroma = clamp(chroma, 0.02, 0.19);

  const dark = light < 0.36 || (technique === 'kandinsky' && light < 0.5 && tod === 'night');
  const shift = tension > 0.55 || technique === 'kandinsky' ? 165 : 32;
  const bg = oklchHex(dark ? 0.19 + light * 0.1 : 0.955 - (1 - light) * 0.05, 0.012 + 0.02 * (1 - air), hue);
  const ink = ensureContrast(oklchHex(dark ? 0.94 : 0.22, 0.02, hue), bg, 9);
  const accent = oklchHex(dark ? 0.72 : 0.6 - contrast * 0.06, chroma, hue);
  const accent2 = oklchHex(dark ? 0.68 : 0.66, chroma * 0.92, (hue + shift) % 360);
  const soft = oklchHex(dark ? 0.32 : 0.87, chroma * 0.45, hue);
  const deep = oklchHex(dark ? 0.12 : 0.3, chroma * 0.5, hue);
  const palette = { bg, ink, accent, accent2, soft, deep, dark };
  why.push({ k: 'palette', p: { dark, photo: photos?.hue != null && photoWeight > 0.3, warm: warmth > 0.6, cold: warmth < 0.4 } });

  if (tod !== 'unknown') why.push({ k: 'tod', p: { tod } });
  if (wx !== 'unknown') why.push({ k: 'weather', p: { wx } });
  if (mood) why.push({ k: 'mood', p: { mood } });
  if (tension > 0.55) why.push({ k: 'tense', p: {} });
  if (social > 0.6) why.push({ k: 'crowd', p: {} });

  return {
    v: 1,
    technique,
    technique2: second,
    seed: (opts.seed ?? 0) >>> 0,
    variant: opts.variant ?? 0,
    palette,
    vec: Object.fromEntries(Object.entries(vec).map(([k, x]) => [k, +x.toFixed(3)])),
    rhythm: { bpm, interval: +interval.toFixed(2), motion: +motion.toFixed(2) },
    air: +air.toFixed(2),
    contrast: +contrast.toFixed(2),
    grain: +grain.toFixed(2),
    sign: String(opts.sign || '').slice(0, 30),
    signals: {
      tod, season, weather: wx,
      music: music ? { bpm: music.bpm, mode: music.mode, energy: music.energy, genre: music.genre, year: music.year, source: music.source } : null,
      photos: photos ? { count: photos.count, hue: photos.hue != null ? Math.round(photos.hue) : null } : null,
      ai: text.source === 'ai',
    },
    voice: voiceProfile(vec),
    explain: why,
  };
}

function seasonFromDate(date) {
  const m = Number(String(date || '').slice(5, 7));
  if (!m) return 'unknown';
  if (m === 12 || m <= 2) return 'winter';
  if (m <= 5) return 'spring';
  if (m <= 8) return 'summer';
  return 'autumn';
}

// Коды WMO из Open-Meteo
function weatherFromCode(code) {
  if (code == null) return 'unknown';
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'unknown';
}

// Голос выбирается по правилам, а не случайно (см. voice.js: сопоставление с голосами браузера)
export function voiceProfile(vec) {
  if (vec.arousal > 0.64) return { key: 'bright', rate: 1.12, pitch: 1.1 };
  if (vec.arousal < 0.42 && vec.warmth >= 0.5) return { key: 'warm', rate: 0.88, pitch: 1.0 };
  if (vec.warmth < 0.42) return { key: 'cool', rate: 0.97, pitch: 0.85 };
  return { key: 'steady', rate: 0.95, pitch: 0.95 };
}

// ---- объяснения для человека: хранятся как ключи, переводятся при показе
const T = {
  ru: {
    tech: {
      impressionist: 'Мазки в духе Клода Моне',
      kandinsky: 'Геометрия Кандинского',
      film: 'Плёночная фотография',
      collage: 'Коллаж из вырезок',
      ma: 'Японский минимализм с паузами',
    },
    reasons: {
      calm: 'спокойный ритм дня', outdoor: 'прогулка на воздухе', warm: 'тёплые тона', bright: 'много света', happy: 'хорошее настроение',
      lively: 'высокая энергия', tense: 'напряжение и спешка', cold: 'холодные тона', night: 'ночь', electronic: 'электронная музыка',
      minorFast: 'быстрая песня в миноре', nostalgic: 'воспоминания в тексте', oldSong: 'песня из прошлых лет', evening: 'вечер', social: 'люди рядом',
      manyPhotos: 'много кадров', party: 'настроение «жігерлі»', solitude: 'тишина и одиночество', quietWeather: 'снег или туман',
      slowMinor: 'медленная песня в миноре', relaxed: 'никакой спешки',
    },
    tech_line: (name, reasons, second) =>
      `${name}: ${reasons.length ? reasons.join(', ') : 'так сложилось по сумме признаков'}.${second ? ` Следом шёл приём «${second}», поэтому его черты подмешаны.` : ''}`,
    tempo: (p) => `Песня идёт в темпе ${p.bpm} ударов в минуту: фото меняются каждые ${p.interval} с${p.slow ? ', между кадрами больше воздуха' : ', кадры сменяются бодрее'}.`,
    tempoGuess: (p) => `Песни нет, темп взят по энергии дня (около ${p.bpm}): фото меняются каждые ${p.interval} с.`,
    minor: 'Минор: цвета приглушены и сдвинуты к прохладным.',
    major: 'Мажор: цвета чище и чуть светлее.',
    energy: 'Песня энергичная: контраст выше, движение быстрее.',
    era: (p) => `Песня ${p.year} года: добавлено плёночное зерно.`,
    palette: (p) => `Палитра ${p.dark ? 'тёмная, потому что день шёл при слабом свете' : 'светлая, день был при хорошем свете'}${p.photo ? '; оттенок взят с ваших фото' : ''}${p.warm ? '; тона тёплые' : p.cold ? '; тона холодные' : ''}.`,
    tod: (p) => `${{ morning: 'Утро', day: 'День', evening: 'Вечер', night: 'Ночь' }[p.tod]} задаёт яркость фона.`,
    weather: (p) => ({ rain: 'Дождь приглушает цвета.', snow: 'Снег делает фон светлее и тише.', fog: 'Туман смягчает контраст.', clear: 'Ясная погода добавляет света.', cloudy: 'Облачность делает свет ровным.' }[p.wx]),
    mood: (p) => `Вы выбрали настроение «${{ warm: 'жылы', cold: 'суық', energetic: 'жігерлі' }[p.mood]}»: оно сдвинуло ${p.mood === 'energetic' ? 'энергию' : 'температуру цвета'}.`,
    tense: 'В тексте чувствуется спешка: контраст выше, композиция жёстче.',
    crowd: 'В дне много людей: композиция плотнее.',
  },
  kk: {
    tech: {
      impressionist: 'Клод Моне рухындағы бояу жағындылары',
      kandinsky: 'Кандинский геометриясы',
      film: 'Фотопленка',
      collage: 'Қиындылардан коллаж',
      ma: 'Үзілістері бар жапон минимализмі',
    },
    reasons: {
      calm: 'күннің тыныш ырғағы', outdoor: 'ашық ауада серуен', warm: 'жылы реңктер', bright: 'жарық көп', happy: 'көңіл-күй жақсы',
      lively: 'энергия жоғары', tense: 'асығыс пен қысым', cold: 'суық реңктер', night: 'түн', electronic: 'электронды музыка',
      minorFast: 'минордағы жылдам ән', nostalgic: 'мәтіндегі естеліктер', oldSong: 'өткен жылдардағы ән', evening: 'кеш', social: 'жанында адамдар',
      manyPhotos: 'кадр көп', party: '«жігерлі» көңіл-күй', solitude: 'тыныштық пен жалғыздық', quietWeather: 'қар немесе тұман',
      slowMinor: 'минордағы баяу ән', relaxed: 'асығыс жоқ',
    },
    tech_line: (name, reasons, second) =>
      `${name}: ${reasons.length ? reasons.join(', ') : 'белгілердің жиынтығына қарай таңдалды'}.${second ? ` Одан кейін «${second}» келді, сондықтан оның белгілері араласты.` : ''}`,
    tempo: (p) => `Ән минутына ${p.bpm} соққы қарқынымен жүреді: суреттер ${p.interval} с сайын ауысады${p.slow ? ', кадрлар арасы кеңірек' : ', кадрлар жылдамырақ ауысады'}.`,
    tempoGuess: (p) => `Ән жоқ, қарқын күн энергиясына қарай алынды (шамамен ${p.bpm}): суреттер ${p.interval} с сайын ауысады.`,
    minor: 'Минор: түстер бәсеңдеп, салқын жаққа ауысты.',
    major: 'Мажор: түстер тазарақ әрі сәл ашығырақ.',
    energy: 'Ән қуатты: контраст жоғары, қозғалыс жылдамырақ.',
    era: (p) => `${p.year} жылғы ән: фотопленка түйіршігі қосылды.`,
    palette: (p) => `Палитра ${p.dark ? 'қараңғы, өйткені күн әлсіз жарықта өтті' : 'ашық, күн жақсы жарықта өтті'}${p.photo ? '; реңк суреттеріңізден алынды' : ''}${p.warm ? '; реңктер жылы' : p.cold ? '; реңктер суық' : ''}.`,
    tod: (p) => `${{ morning: 'Таң', day: 'Күндіз', evening: 'Кеш', night: 'Түн' }[p.tod]} фонның жарықтығын белгілейді.`,
    weather: (p) => ({ rain: 'Жаңбыр түстерді бәсеңдетеді.', snow: 'Қар фонды ашық әрі тыныш етеді.', fog: 'Тұман контрастты жұмсартады.', clear: 'Ашық ауа райы жарық қосады.', cloudy: 'Бұлтты ауа райы жарықты біркелкі етеді.' }[p.wx]),
    mood: (p) => `Сіз «${{ warm: 'жылы', cold: 'суық', energetic: 'жігерлі' }[p.mood]}» көңіл-күйін таңдадыңыз: ол ${p.mood === 'energetic' ? 'энергияны' : 'түс температурасын'} ығыстырды.`,
    tense: 'Мәтінде асығыс сезіледі: контраст жоғары, композиция қатаңырақ.',
    crowd: 'Күнде адам көп: композиция тығызырақ.',
  },
};
T.en = {
  ...T.ru,
  tech: { impressionist: 'Brushwork in the spirit of Claude Monet', kandinsky: 'Kandinsky-style geometry', film: 'Film photography', collage: 'Paper collage', ma: 'Japanese minimalism with pauses' },
  reasons: Object.fromEntries(Object.keys(T.ru.reasons).map((k) => [k, k])),
  tech_line: (n, r) => `${n}: ${r.join(', ')}.`,
  tempo: (p) => `The song runs at ${p.bpm} BPM: photos change every ${p.interval} s.`,
  tempoGuess: (p) => `No song: tempo guessed from the day's energy (about ${p.bpm}).`,
  minor: 'Minor key: colours are muted and cooler.', major: 'Major key: cleaner, lighter colours.',
  energy: 'Energetic song: higher contrast, faster motion.', era: (p) => `A song from ${p.year}: film grain added.`,
  palette: (p) => `${p.dark ? 'Dark' : 'Light'} palette.`, tod: (p) => `Time of day: ${p.tod}.`, weather: (p) => `Weather: ${p.wx}.`,
  mood: (p) => `Chosen mood: ${p.mood}.`, tense: 'Tense text: higher contrast.', crowd: 'Many people: denser layout.',
};

export function explain(memory, lang = 'ru') {
  const d = T[lang] || T.ru;
  const out = [];
  for (const item of memory?.explain || []) {
    const p = item.p || {};
    let line = '';
    if (item.k === 'tech') {
      line = d.tech_line(d.tech[p.technique], (p.reasons || []).map((r) => d.reasons[r] || r), p.second ? d.tech[p.second] : null);
    } else if (typeof d[item.k] === 'function') line = d[item.k](p);
    else if (typeof d[item.k] === 'string') line = d[item.k];
    if (line) out.push(line);
  }
  return out;
}

export { hueDistance };
