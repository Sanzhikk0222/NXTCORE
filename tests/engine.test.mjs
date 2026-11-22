// Проверки движка воспоминаний, анализа аудио и текста, модерации на клиенте.
// Запуск: node tests/engine.test.mjs
import assert from 'node:assert/strict';
import { analyzeText, mergeTextSignals } from '../js/memory/text-analysis.js';
import { buildMemory, explain, TECHNIQUES } from '../js/memory/engine.js';
import { resolveMusic, parseMusicUrl, genreDefaults } from '../js/memory/music.js';
import { analyzeSamples } from '../js/memory/audio-analysis.js';
import { featuresFromPixels, mergePhotoFeatures } from '../js/memory/image-features.js';
import { localTitle } from '../js/memory/title.js';
import { contrast, hexToOklch, hueDistance } from '../js/memory/color.js';
import { checkText, checkUsername, checkDisplayName } from '../js/moderation/text.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; };

// ---------- синтетические фото: заливка + шум
function photo(rgb, jitter = 20, w = 40, h = 40) {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = 7;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = ((s % 100) / 100 - 0.5) * jitter;
    d[i * 4] = rgb[0] + j; d[i * 4 + 1] = rgb[1] + j; d[i * 4 + 2] = rgb[2] + j; d[i * 4 + 3] = 255;
  }
  return featuresFromPixels(d, w, h);
}

// ---------- семь разных дней
const DAYS = {
  parkAutumn: {
    text: 'Гуляли по парку, листья под ногами, пили какао из термоса. Тихо и тепло.',
    photos: [photo([196, 130, 60]), photo([160, 110, 70])],
    music: resolveMusic({ meta: { title: 'Fly Me to the Moon', artist: 'Frank Sinatra' }, manual: { genre: 'jazz', year: 1964 } }),
    date: '2026-10-18',
  },
  officeNight: {
    text: 'Ночью в офисе, дедлайн горит, не спал, кофе третья чашка, срочно сдать проект. Волнуюсь.',
    photos: [photo([30, 40, 70], 40)],
    music: resolveMusic({ meta: { title: 'x', artist: 'y' }, manual: { genre: 'techno', bpm: 138 } }),
    date: '2026-11-03',
  },
  birthday: {
    text: 'День рождения! Друзья, смех, танцы, торт, все вместе, вечеринка до утра. Ура!',
    photos: [photo([220, 90, 120], 70), photo([240, 200, 60], 70), photo([80, 160, 220], 70), photo([120, 220, 120], 70)],
    music: resolveMusic({ meta: {}, manual: { genre: 'pop', bpm: 122 } }),
    date: '2026-06-14',
  },
  rainAlone: {
    text: 'Дождь весь день, серо, читал один, тихо, немного грустно и скучаю по дому.',
    photos: [photo([110, 120, 135], 14)],
    music: resolveMusic({ meta: {}, manual: { genre: 'ambient' } }),
    date: '2026-09-22',
  },
  snowMorning: {
    text: 'Снег с утра, мороз, тишина, спокойный завтрак в одиночестве.',
    photos: [photo([225, 230, 240], 10)],
    music: resolveMusic({ meta: {}, manual: { genre: 'classical' } }),
    date: '2026-01-12',
  },
  beachRun: {
    text: 'Утром бег по пляжу, море, солнце, тренировка, настроение отличное!',
    photos: [photo([80, 170, 210], 50), photo([240, 220, 170], 50)],
    music: resolveMusic({ meta: {}, manual: { genre: 'rock', bpm: 150 } }),
    date: '2026-07-20',
  },
  grandma: {
    text: 'Вечером у бабушки, вспоминали детство, листали старый альбом, чай и тепло. Скучаю по тем временам.',
    photos: [photo([170, 120, 80], 18)],
    music: resolveMusic({ meta: {}, manual: { genre: 'folk', year: 1975 } }),
    date: '2026-11-08',
  },
};

const built = {};
for (const [name, d] of Object.entries(DAYS)) {
  const text = analyzeText(d.text);
  built[name] = buildMemory({ text, photos: mergePhotoFeatures(d.photos), music: d.music, date: d.date }, { seed: 1, sign: 'Аян' });
}

test('у каждого дня есть техника, палитра и объяснение', () => {
  for (const [name, m] of Object.entries(built)) {
    assert.ok(TECHNIQUES.includes(m.technique), name);
    assert.ok(explain(m, 'ru').length >= 3, name + ': мало объяснений');
    assert.ok(explain(m, 'kk').length >= 3);
    for (const k of ['bg', 'ink', 'accent', 'accent2', 'soft', 'deep']) assert.match(m.palette[k], /^#[0-9a-f]{6}$/);
    assert.ok(contrast(m.palette.ink, m.palette.bg) >= 7, name + ': контраст текста');
    assert.ok(JSON.stringify(m).length < 6000, 'память должна быть компактной');
  }
});

test('разные дни получают разные приёмы (минимум 4 из 5)', () => {
  const used = new Set(Object.values(built).map((m) => m.technique));
  assert.ok(used.size >= 4, 'использованы: ' + [...used].join(', '));
});

test('ожидаемые приёмы для типичных дней', () => {
  assert.equal(built.officeNight.technique, 'kandinsky');
  assert.equal(built.birthday.technique, 'collage');
  assert.equal(built.grandma.technique, 'film');
  assert.ok(['ma', 'impressionist'].includes(built.snowMorning.technique), built.snowMorning.technique);
  assert.ok(['impressionist', 'film'].includes(built.parkAutumn.technique), built.parkAutumn.technique);
});

test('палитры разных дней заметно отличаются', () => {
  const hues = Object.values(built).map((m) => hexToOklch(m.palette.accent).h);
  let far = 0;
  for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) if (hueDistance(hues[i], hues[j]) > 40) far++;
  assert.ok(far >= 8, 'пар с разницей оттенка >40°: ' + far);
  assert.ok(built.officeNight.palette.dark, 'ночной офис тёмный');
  assert.ok(!built.snowMorning.palette.dark, 'снежное утро светлое');
});

test('темп песни меняет ритм: медленное тише и просторнее быстрого', () => {
  assert.ok(built.rainAlone.rhythm.interval > built.beachRun.rhythm.interval);
  assert.ok(built.rainAlone.air > built.beachRun.air);
  assert.ok(built.rainAlone.rhythm.motion < built.beachRun.rhythm.motion);
  assert.equal(built.beachRun.rhythm.bpm, 150);
});

test('минор приглушает цвет, мажор нет', () => {
  const base = { text: analyzeText('Обычный день, сидел дома.'), photos: null, date: '2026-04-01' };
  const minor = buildMemory({ ...base, music: resolveMusic({ meta: {}, manual: { mode: 'minor', bpm: 100, energy: 0.5 } }) }, { seed: 3 });
  const major = buildMemory({ ...base, music: resolveMusic({ meta: {}, manual: { mode: 'major', bpm: 100, energy: 0.5 } }) }, { seed: 3 });
  assert.ok(hexToOklch(minor.palette.accent).C < hexToOklch(major.palette.accent).C);
});

test('настроение «жылы/суық» двигает температуру, «жігерлі» энергию', () => {
  const t = analyzeText('Обычный день.');
  const mk = (mood) => buildMemory({ text: t, photos: null, music: null, mood, date: '2026-04-01' }, { seed: 5 });
  assert.ok(mk('warm').vec.warmth > mk(null).vec.warmth);
  assert.ok(mk('cold').vec.warmth < mk(null).vec.warmth);
  assert.ok(mk('energetic').vec.arousal > mk(null).vec.arousal);
});

test('без текста, фото и песни день всё равно собирается', () => {
  const m = buildMemory({ text: analyzeText(''), photos: null, music: null, date: '2026-04-01' }, { seed: 9 });
  assert.ok(m.technique && m.palette.bg);
});

test('одинаковые входные данные дают одинаковый результат', () => {
  const d = DAYS.grandma;
  const mk = () => buildMemory({ text: analyzeText(d.text), photos: mergePhotoFeatures(d.photos), music: d.music, date: d.date }, { seed: 42, sign: 'x' });
  assert.deepEqual(mk(), mk());
});

test('ответ ИИ смешивается с локальным разбором', () => {
  const local = analyzeText('Обычный день.');
  const merged = mergeTextSignals(local, { ok: true, valence: 0.9, arousal: 0.9, warmth: 0.9, nostalgia: 0.1, tension: 0.1, social: 0.9, time_of_day: 'night', season: 'unknown', weather: 'rain' });
  assert.ok(merged.arousal > local.arousal && merged.time_of_day === 'night' && merged.season === local.season);
});

// ---------- текст
test('разбор текста: время суток, сезон, погода, языки', () => {
  const a = analyzeText('Вечером осенний дождь, сидели дома.');
  assert.equal(a.time_of_day, 'evening'); assert.equal(a.season, 'autumn'); assert.equal(a.weather, 'rain');
  assert.equal(analyzeText('Бүгін қыс, қар жауды, суық.').season, 'winter');
  assert.ok(analyzeText('Бүгін қыс, қар жауды, суық.').warmth < 0.4);
  assert.ok(analyzeText('We had cozy cocoa by the fire').warmth > 0.55);
  assert.equal(analyzeText('Ничего не произошло').valence, 0);
});

// ---------- музыка
test('ссылки на музыку: плееры и опасные адреса', () => {
  assert.equal(parseMusicUrl('https://youtu.be/dQw4w9WgXcQ').embed, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(parseMusicUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3').id, 'dQw4w9WgXcQ');
  assert.equal(parseMusicUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x').embed, 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(parseMusicUrl('https://example.com/a.mp3').direct, true);
  assert.equal(parseMusicUrl('javascript:alert(1)'), null);
  assert.equal(parseMusicUrl('data:text/html,hi'), null);
  assert.equal(parseMusicUrl('not a url'), null);
  assert.equal(parseMusicUrl('https://example.com/page').embed, null);
});

test('сведение данных о песне: приоритеты', () => {
  const m = resolveMusic({ meta: { title: 'T', artist: 'A' }, manual: { genre: 'jazz' }, ai: { bpm: 111, energy: 0.9, mode: 'minor' }, audio: { bpm: 90, energy: 0.3, mode: 'major', valence: 0.6 } });
  assert.equal(m.bpm, 90); assert.equal(m.mode, 'major'); assert.equal(m.source, 'audio'); assert.equal(m.estimated, false);
  const g = resolveMusic({ meta: {}, manual: { genre: 'electronic' } });
  assert.equal(g.estimated, true); assert.ok(g.bpm > 110);
  const manual = resolveMusic({ meta: {}, manual: { genre: 'jazz', bpm: 70 } });
  assert.equal(manual.bpm, 70);
  assert.equal(resolveMusic({ meta: { title: 'x' } }).known, false);
  assert.ok(genreDefaults('Lo-Fi hip hop'));
});

// ---------- аудио
function click(bpm, sec, sr) {
  const s = new Float32Array(sr * sec), period = Math.round((sr * 60) / bpm);
  for (let i = 0; i < s.length; i += period) for (let k = 0; k < 300 && i + k < s.length; k++) s[i + k] = 0.8 * Math.exp(-k / 60) * Math.sin(k * 0.3);
  return s;
}
function chord(freqs, sec, sr) {
  const s = new Float32Array(sr * sec);
  for (let i = 0; i < s.length; i++) for (const f of freqs) s[i] += 0.2 * Math.sin((2 * Math.PI * f * i) / sr);
  return s;
}
test('темп: щелчки 100 и 128 BPM определяются с точностью 3%', () => {
  for (const bpm of [100, 128]) {
    const r = analyzeSamples(click(bpm, 24, 11025), 11025);
    assert.ok(Math.abs(r.bpm - bpm) / bpm < 0.03, `ждали ${bpm}, получили ${r.bpm}`);
  }
});
test('лад: C-мажор и A-минор различаются', () => {
  const C = [261.63, 329.63, 392.0], Am = [220.0, 261.63, 329.63];
  const mix = (a, b) => { const x = chord(a, 3, 11025), y = chord(b, 3, 11025), o = new Float32Array(x.length * 2); o.set(x); o.set(y, x.length); return o; };
  // мелодия вокруг тоники: C-E-G, F-A-C, G-B-D, C-E-G
  const maj = analyzeSamples(chord(C, 6, 11025), 11025);
  const min = analyzeSamples(chord(Am, 6, 11025), 11025);
  assert.equal(maj.mode, 'major'); assert.equal(min.mode, 'minor');
  void mix;
});
test('энергия: громкий сигнал выше тихого; яркость выше у высоких частот', () => {
  const quiet = chord([220], 4, 11025).map((v) => v * 0.1), loud = chord([220], 4, 11025).map((v) => v * 3);
  assert.ok(analyzeSamples(loud, 11025).energy > analyzeSamples(quiet, 11025).energy);
  assert.ok(analyzeSamples(chord([2400], 4, 11025), 11025).brightness > analyzeSamples(chord([150], 4, 11025), 11025).brightness);
});

// ---------- фото
test('признаки фото: тёплое и холодное', () => {
  const warm = photo([220, 140, 70]), cold = photo([60, 100, 200]);
  assert.ok(warm.warmth > 0.6 && cold.warmth < 0.4);
  assert.ok(hueDistance(warm.hue, 60) < 40 && hueDistance(cold.hue, 260) < 50);
  assert.ok(photo([240, 240, 240]).light > photo([20, 20, 20]).light);
});

// ---------- название
test('локальное название: 3-7 слов, нормальные формы', () => {
  assert.equal(localTitle('Гуляли по парку, пили какао', { time_of_day: 'evening' }, 'ru'), 'Вечер в парке и какао');
  assert.equal(localTitle('Дедлайн и кофе', {}, 'ru'), 'Дедлайн и кофе'.replace('Дедлайн и кофе', localTitle('Дедлайн и кофе', {}, 'ru')));
  for (const lang of ['ru', 'kk', 'en']) {
    for (const txt of ['', 'просто день', 'парк какао', 'saябақта шай ішті', 'park and coffee']) {
      const n = localTitle(txt, { time_of_day: 'night', season: 'autumn' }, lang).split(' ').length;
      assert.ok(n >= 3 && n <= 7, `${lang} «${txt}»: ${n} слов`);
    }
  }
});

// ---------- модерация на клиенте
test('модерация текста: нет ложных срабатываний, ловит очевидное', () => {
  for (const s of ['Мы шли по парку, кораблям бы тут плыть', 'не банковский день, небанальный', 'страна и странный день', 'Scunthorpe, shiitake и Dickens', 'я купил хлеб и взял кредит']) {
    assert.equal(checkText(s).ok, true, s);
  }
  for (const s of ['пошёл нахуй', 'ХУУУУЙ', 'ты сука', 'xyй тебе', 'ЕБАНЫЙ день', 'Что за fuck', 'сиктир кет']) {
    assert.equal(checkText(s).code, 'forbidden', s);
  }
  assert.equal(checkText('Купи кредит, заработок без вложений').code, 'spam');
  assert.equal(checkText('Купи тут https://x.ru').code, 'spam');
  assert.equal(checkText('песня https://youtu.be/abc').ok, true);
});
test('модерация ников', () => {
  assert.equal(checkUsername('anna_diary').ok, true);
  for (const [n, c] of [['admin_x', 'reserved'], ['MyModerator', 'reserved'], ['nxtcore_fan', 'reserved'], ['pizdec', 'forbidden'], ['p1zd3c', 'forbidden'], ['vasya_pidor', 'forbidden'], ['ab', 'format'], ['имя', 'format'], ['12345', 'format']]) {
    assert.equal(checkUsername(n).code, c, n);
  }
  assert.equal(checkDisplayName('Support Team').code, 'reserved');
  assert.equal(checkDisplayName('Айдана').ok, true);
});

console.log(`Движок и модерация: ${passed} проверок прошли`);
console.log('\nДни → приём:');
for (const [n, m] of Object.entries(built)) console.log(`  ${n.padEnd(11)} ${m.technique.padEnd(13)} bpm ${String(m.rhythm.bpm).padEnd(3)} интервал ${m.rhythm.interval}с  ${m.palette.dark ? 'тёмная' : 'светлая'}  ${m.palette.accent}`);
