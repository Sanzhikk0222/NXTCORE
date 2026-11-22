// Локальный разбор текста дня: работает без ИИ и без сети.
// Результат того же вида, что отдаёт ИИ (analyze_day), поэтому движок не знает, откуда сигналы.
// Это оценка атмосферы текста по словам, а не оценка состояния человека.

// [основа слова, {измерение: вклад}]. Совпадение идёт по началу слова.
const LEX = [
  // тепло и уют
  ['тепл', { warmth: 0.3, valence: 0.15, arousal: -0.1 }], ['уют', { warmth: 0.35, arousal: -0.15, valence: 0.15 }],
  ['какао', { warmth: 0.3, arousal: -0.1 }], ['чай', { warmth: 0.2, arousal: -0.1 }], ['плед', { warmth: 0.3, arousal: -0.2 }],
  ['камин', { warmth: 0.3, arousal: -0.2 }], ['обним', { warmth: 0.25, valence: 0.2, social: 0.2 }], ['солнц', { warmth: 0.3, valence: 0.2 }],
  ['солнеч', { warmth: 0.3, valence: 0.2 }], ['мам', { warmth: 0.15, nostalgia: 0.1 }], ['бабушк', { warmth: 0.2, nostalgia: 0.25 }],
  ['жылы', { warmth: 0.3, valence: 0.15 }], ['жылыл', { warmth: 0.3 }], ['шай', { warmth: 0.2, arousal: -0.1 }], ['күн ', { warmth: 0.2 }],
  ['warm', { warmth: 0.3, valence: 0.15 }], ['cozy', { warmth: 0.35, arousal: -0.15 }], ['cocoa', { warmth: 0.3 }], ['tea', { warmth: 0.15 }], ['sun', { warmth: 0.3, valence: 0.2 }],
  // холод
  ['холод', { warmth: -0.35 }], ['мороз', { warmth: -0.35 }], ['лёд', { warmth: -0.3 }], ['лед', { warmth: -0.3 }], ['ветер', { warmth: -0.15, arousal: 0.1 }],
  ['дрож', { warmth: -0.25 }], ['озноб', { warmth: -0.3 }], ['снег', { warmth: -0.25, arousal: -0.1 }], ['зим', { warmth: -0.2 }],
  ['суық', { warmth: -0.35 }], ['аяз', { warmth: -0.35 }], ['қар', { warmth: -0.25 }], ['қыс', { warmth: -0.2 }], ['жел', { warmth: -0.15, arousal: 0.1 }],
  ['cold', { warmth: -0.35 }], ['frost', { warmth: -0.35 }], ['snow', { warmth: -0.25, arousal: -0.1 }], ['winter', { warmth: -0.2 }],
  // серость, дождь, тишина
  ['дожд', { valence: -0.1, nostalgia: 0.15, warmth: -0.1, arousal: -0.1 }], ['ливн', { arousal: 0.1, valence: -0.1 }], ['туман', { arousal: -0.2, warmth: -0.1 }],
  ['серы', { valence: -0.1, warmth: -0.1 }], ['пасмурн', { valence: -0.1, warmth: -0.1 }], ['жаңбыр', { nostalgia: 0.15, arousal: -0.1 }],
  ['тұман', { arousal: -0.2 }], ['бұлт', { valence: -0.05 }], ['rain', { nostalgia: 0.15, arousal: -0.1 }], ['fog', { arousal: -0.2 }],
  ['тишин', { arousal: -0.25, social: -0.15 }], ['спокой', { arousal: -0.25, valence: 0.1 }], ['тихо', { arousal: -0.25 }], ['медлен', { arousal: -0.2 }],
  ['тыныш', { arousal: -0.25 }], ['баяу', { arousal: -0.2 }], ['quiet', { arousal: -0.25 }], ['calm', { arousal: -0.25, valence: 0.1 }], ['slow', { arousal: -0.2 }],
  ['читал', { arousal: -0.2, social: -0.15 }], ['книг', { arousal: -0.15, social: -0.1 }], ['оқыд', { arousal: -0.2 }], ['one ', { social: -0.1 }],
  ['один', { social: -0.25, arousal: -0.1 }], ['одинок', { social: -0.3, valence: -0.2 }], ['жалғыз', { social: -0.3 }], ['alone', { social: -0.3 }],
  // напряжение, спешка
  ['дедлайн', { tension: 0.35, arousal: 0.25 }], ['deadline', { tension: 0.35, arousal: 0.25 }], ['дедлайн', { tension: 0.35 }], ['срочн', { tension: 0.3, arousal: 0.25 }],
  ['сдач', { tension: 0.25, arousal: 0.15 }], ['сдать', { tension: 0.25, arousal: 0.15 }], ['успе', { tension: 0.15, arousal: 0.15 }], ['торопил', { tension: 0.25, arousal: 0.25 }],
  ['спеш', { tension: 0.25, arousal: 0.25 }], ['не спал', { tension: 0.3, arousal: 0.1 }], ['бессонн', { tension: 0.3 }], ['кофе', { tension: 0.1, arousal: 0.15 }],
  ['код', { tension: 0.1, arousal: 0.1 }], ['баг', { tension: 0.2 }], ['офис', { tension: 0.2, social: -0.05, warmth: -0.15 }], ['работ', { tension: 0.1 }],
  ['экзамен', { tension: 0.3, valence: -0.1 }], ['контрольн', { tension: 0.25 }], ['волнов', { tension: 0.25 }], ['страх', { tension: 0.3, valence: -0.2 }],
  ['тревож', { tension: 0.3, valence: -0.2 }], ['боял', { tension: 0.25, valence: -0.15 }], ['нервн', { tension: 0.3 }],
  ['асық', { tension: 0.3, arousal: 0.25 }], ['емтихан', { tension: 0.3 }], ['қорық', { tension: 0.3, valence: -0.2 }], ['алаң', { tension: 0.25 }],
  ['stress', { tension: 0.3, arousal: 0.2 }], ['exam', { tension: 0.3 }], ['panic', { tension: 0.35, arousal: 0.2 }], ['rush', { tension: 0.25, arousal: 0.25 }],
  // люди и праздник
  ['друз', { social: 0.3, valence: 0.15 }], ['друг', { social: 0.25 }], ['вместе', { social: 0.3, warmth: 0.1 }], ['компани', { social: 0.3, arousal: 0.1 }],
  ['вечеринк', { social: 0.35, arousal: 0.3, valence: 0.2 }], ['смех', { social: 0.2, valence: 0.3, arousal: 0.15 }], ['смеял', { social: 0.2, valence: 0.3 }],
  ['праздн', { social: 0.3, arousal: 0.2, valence: 0.25 }], ['день рожд', { social: 0.35, arousal: 0.25, valence: 0.3 }], ['танц', { arousal: 0.35, social: 0.2, valence: 0.2 }],
  ['семь', { social: 0.25, warmth: 0.15 }], ['девушк', { social: 0.2, warmth: 0.15 }], ['парень', { social: 0.2 }], ['разговарив', { social: 0.2, arousal: -0.05 }],
  ['дос', { social: 0.3 }], ['бірге', { social: 0.3 }], ['мереке', { social: 0.3, arousal: 0.2, valence: 0.25 }], ['күлк', { valence: 0.3, social: 0.2 }],
  ['күлд', { valence: 0.3, social: 0.2 }], ['би ', { arousal: 0.3 }], ['той', { social: 0.35, arousal: 0.25, valence: 0.25 }], ['отбасы', { social: 0.25, warmth: 0.15 }],
  ['friend', { social: 0.3, valence: 0.15 }], ['party', { social: 0.35, arousal: 0.3, valence: 0.2 }], ['together', { social: 0.3 }], ['dance', { arousal: 0.35, social: 0.2 }],
  ['birthday', { social: 0.35, arousal: 0.25, valence: 0.3 }], ['laugh', { valence: 0.3, social: 0.2 }],
  // чувства
  ['грустн', { valence: -0.3 }], ['груст', { valence: -0.3 }], ['скуч', { valence: -0.25, nostalgia: 0.2 }], ['плакал', { valence: -0.3 }], ['тоск', { valence: -0.3, nostalgia: 0.2 }],
  ['потерял', { valence: -0.25 }], ['расстал', { valence: -0.3, nostalgia: 0.2 }], ['обид', { valence: -0.25 }], ['устал', { valence: -0.15, arousal: -0.2 }],
  ['қайғ', { valence: -0.3 }], ['сағын', { valence: -0.2, nostalgia: 0.3 }], ['жылады', { valence: -0.3 }], ['шаршад', { arousal: -0.2, valence: -0.1 }],
  ['sad', { valence: -0.3 }], ['miss', { nostalgia: 0.25, valence: -0.15 }], ['tired', { arousal: -0.2, valence: -0.1 }], ['cried', { valence: -0.3 }],
  ['радост', { valence: 0.3, arousal: 0.1 }], ['счастл', { valence: 0.35, warmth: 0.1 }], ['класс', { valence: 0.2 }], ['круто', { valence: 0.25, arousal: 0.15 }],
  ['отличн', { valence: 0.25 }], ['любл', { valence: 0.25, warmth: 0.15 }], ['ура', { valence: 0.3, arousal: 0.2 }], ['здорово', { valence: 0.25 }],
  ['қуаныш', { valence: 0.3 }], ['бақыт', { valence: 0.35, warmth: 0.1 }], ['керемет', { valence: 0.3 }], ['жақсы', { valence: 0.2 }], ['сүй', { valence: 0.25, warmth: 0.15 }],
  ['happy', { valence: 0.35 }], ['joy', { valence: 0.3 }], ['love', { valence: 0.25, warmth: 0.15 }], ['great', { valence: 0.25 }],
  // память
  ['вспомин', { nostalgia: 0.3 }], ['вспомн', { nostalgia: 0.3 }], ['детств', { nostalgia: 0.4, warmth: 0.1 }], ['раньше', { nostalgia: 0.25 }], ['давно', { nostalgia: 0.25 }],
  ['старый', { nostalgia: 0.2 }], ['старые', { nostalgia: 0.25 }], ['альбом', { nostalgia: 0.2 }], ['школ', { nostalgia: 0.25 }], ['пленк', { nostalgia: 0.3 }],
  ['еске', { nostalgia: 0.3 }], ['балалық', { nostalgia: 0.4 }], ['ертеде', { nostalgia: 0.25 }], ['ескі', { nostalgia: 0.2 }], ['мектеп', { nostalgia: 0.25 }],
  ['remember', { nostalgia: 0.3 }], ['childhood', { nostalgia: 0.4 }], ['old ', { nostalgia: 0.2 }], ['memor', { nostalgia: 0.25 }], ['nostalg', { nostalgia: 0.4 }],
  // природа и движение
  ['гуляли', { outdoor: 0.35, arousal: -0.05 }], ['гулял', { outdoor: 0.35 }], ['прогулк', { outdoor: 0.3 }], ['парк', { outdoor: 0.35 }], ['лес', { outdoor: 0.35 }],
  ['озер', { outdoor: 0.35, arousal: -0.1 }], ['пруд', { outdoor: 0.35, arousal: -0.1 }], ['рек', { outdoor: 0.3 }], ['мор', { outdoor: 0.3 }], ['гор', { outdoor: 0.3 }],
  ['природ', { outdoor: 0.35 }], ['лист', { outdoor: 0.2 }], ['цвет', { outdoor: 0.15 }], ['двор', { outdoor: 0.2 }],
  ['серуен', { outdoor: 0.35 }], ['саябақ', { outdoor: 0.35 }], ['орман', { outdoor: 0.35 }], ['көл', { outdoor: 0.35 }], ['өзен', { outdoor: 0.3 }], ['теңіз', { outdoor: 0.3 }],
  ['тау', { outdoor: 0.3 }], ['табиғат', { outdoor: 0.35 }],
  ['walk', { outdoor: 0.35 }], ['park', { outdoor: 0.35 }], ['forest', { outdoor: 0.35 }], ['lake', { outdoor: 0.35 }], ['sea', { outdoor: 0.3 }], ['beach', { outdoor: 0.35, warmth: 0.2 }],
  ['бег', { arousal: 0.3, outdoor: 0.1 }], ['побегал', { arousal: 0.3 }], ['спорт', { arousal: 0.3 }], ['трениров', { arousal: 0.3 }], ['футбол', { arousal: 0.3, social: 0.15 }],
  ['гонк', { arousal: 0.4 }], ['драйв', { arousal: 0.35, valence: 0.15 }], ['скорост', { arousal: 0.3 }], ['жүгір', { arousal: 0.3 }], ['жаттығ', { arousal: 0.3 }],
  ['run', { arousal: 0.3 }], ['workout', { arousal: 0.3 }], ['race', { arousal: 0.35 }], ['concert', { arousal: 0.3, social: 0.25, valence: 0.2 }], ['концерт', { arousal: 0.3, social: 0.25, valence: 0.2 }],
];

const COMPILED = LEX.map(([stem, v]) => [new RegExp('(?:^|[^\\p{L}])' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), v]);

const TIME_OF_DAY = [
  ['night', /(?:^|[^\p{L}])(ноч|полночь|поздно вечер|түн|night|midnight)/iu],
  ['evening', /(?:^|[^\p{L}])(вечер|закат|ужин|сумерк|кеш|күн бат|evening|sunset|dusk)/iu],
  ['morning', /(?:^|[^\p{L}])(утр|рассвет|завтрак|таң|morning|sunrise|breakfast)/iu],
  ['day', /(?:^|[^\p{L}])(днём|днем|обед|полдень|жарк|түс|noon|afternoon|midday)/iu],
];
const SEASON = [
  ['autumn', /(?:^|[^\p{L}])(осен|листь|листопад|сентябр|октябр|ноябр|күз|autumn|fall |leaves)/iu],
  ['winter', /(?:^|[^\p{L}])(зим|снег|декабр|январ|феврал|мороз|новый год|қыс|қар|winter|snow)/iu],
  ['spring', /(?:^|[^\p{L}])(весн|март|апрел|подснежн|көктем|spring)/iu],
  ['summer', /(?:^|[^\p{L}])(лето|летом|жара|пляж|июн|июл|август|жаз|summer|beach)/iu],
];
const WEATHER = [
  ['rain', /(?:^|[^\p{L}])(дожд|ливн|жаңбыр|rain)/iu],
  ['snow', /(?:^|[^\p{L}])(снег|метел|қар|snow)/iu],
  ['fog', /(?:^|[^\p{L}])(туман|тұман|fog|mist)/iu],
  ['clear', /(?:^|[^\p{L}])(солнеч|ясно|безоблач|күн ашық|sunny|clear sky)/iu],
  ['cloudy', /(?:^|[^\p{L}])(пасмурн|облачн|серое небо|бұлтты|cloudy|overcast)/iu],
];

const firstMatch = (table, text) => {
  for (const [name, re] of table) if (re.test(text)) return name;
  return 'unknown';
};

export function detectLang(text) {
  const t = String(text || '');
  if (/[әғқңөұүһі]/i.test(t)) return 'kk';
  if (/[а-яё]/i.test(t)) return 'ru';
  if (/[a-z]/i.test(t)) return 'en';
  return 'ru';
}

const soft = (x) => Math.tanh(x * 1.4);

export function analyzeText(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const sum = { valence: 0, arousal: 0, warmth: 0, nostalgia: 0, tension: 0, social: 0, outdoor: 0 };
  const hits = [];
  for (const [re, v] of COMPILED) {
    re.lastIndex = 0;
    const found = t.match(re);
    if (!found) continue;
    hits.push(found[0].trim());
    const k = Math.min(found.length, 2); // повторы одного слова усиливают слабо
    for (const [dim, d] of Object.entries(v)) sum[dim] += d * (k === 2 ? 1.3 : 1);
  }
  const exclam = (t.match(/!/g) || []).length;
  sum.arousal += Math.min(exclam, 3) * 0.05;

  return {
    source: 'local',
    valence: soft(sum.valence),                       // -1..1
    arousal: Math.min(1, Math.max(0, 0.45 + soft(sum.arousal) * 0.5)),
    warmth: Math.min(1, Math.max(0, 0.5 + soft(sum.warmth) * 0.5)),
    nostalgia: Math.min(1, Math.max(0, 0.2 + soft(sum.nostalgia) * 0.8)),
    tension: Math.min(1, Math.max(0, 0.15 + soft(sum.tension) * 0.85)),
    social: Math.min(1, Math.max(0, 0.25 + soft(sum.social) * 0.75)),
    outdoor: Math.min(1, Math.max(0, 0.15 + soft(sum.outdoor) * 0.85)),
    time_of_day: firstMatch(TIME_OF_DAY, t),
    season: firstMatch(SEASON, t),
    weather: firstMatch(WEATHER, t),
    words: hits.slice(0, 12),
    lang: detectLang(text),
    length: String(text || '').trim().length,
  };
}

// Слить локальный разбор и ответ ИИ. ИИ точнее читает контекст, поэтому его вес выше.
export function mergeTextSignals(local, ai) {
  if (!ai || ai.ok === false) return local;
  const w = 0.65;
  const mix = (a, b, d) => (Number.isFinite(b) ? a * (1 - w) + b * w : (d ?? a));
  return {
    ...local,
    source: 'ai',
    valence: mix(local.valence, ai.valence),
    arousal: mix(local.arousal, ai.arousal),
    warmth: mix(local.warmth, ai.warmth),
    nostalgia: mix(local.nostalgia, ai.nostalgia),
    tension: mix(local.tension, ai.tension),
    social: mix(local.social, ai.social),
    time_of_day: ai.time_of_day && ai.time_of_day !== 'unknown' ? ai.time_of_day : local.time_of_day,
    season: ai.season && ai.season !== 'unknown' ? ai.season : local.season,
    weather: ai.weather && ai.weather !== 'unknown' ? ai.weather : local.weather,
    places: ai.places || [],
    people: ai.people || [],
    activities: ai.activities || [],
    summary: ai.summary || '',
  };
}
