// Название папки дня без ИИ: 3-7 слов, один тон, существительные в правильной форме.
// Если работает ИИ, берётся его название, а это запасной вариант.

// [основа в тексте, название, фраза «где»]  (места)
const PLACES = {
  ru: [
    ['парк', 'парк', 'в парке'], ['лес', 'лес', 'в лесу'], ['озер', 'озеро', 'у озера'], ['пруд', 'пруд', 'у пруда'], ['рек', 'река', 'у реки'],
    ['мор', 'море', 'у моря'], ['гор', 'горы', 'в горах'], ['офис', 'офис', 'в офисе'], ['кафе', 'кафе', 'в кафе'], ['кино', 'кино', 'в кино'],
    ['школ', 'школа', 'в школе'], ['универ', 'университет', 'в университете'], ['двор', 'двор', 'во дворе'], ['город', 'город', 'в городе'],
    ['деревн', 'деревня', 'в деревне'], ['поезд', 'поезд', 'в поезде'], ['дорог', 'дорога', 'в дороге'], ['кухн', 'кухня', 'на кухне'],
    ['пляж', 'пляж', 'на пляже'], ['каток', 'каток', 'на катке'], ['балкон', 'балкон', 'на балконе'], ['дом', 'дом', 'дома'],
  ],
  kk: [
    ['саябақ', 'саябақ', 'саябақтағы'], ['орман', 'орман', 'ормандағы'], ['көл', 'көл', 'көл жағасындағы'], ['өзен', 'өзен', 'өзен жағасындағы'],
    ['теңіз', 'теңіз', 'теңіздегі'], ['тау', 'тау', 'таудағы'], ['кеңсе', 'кеңсе', 'кеңседегі'], ['кафе', 'кафе', 'кафедегі'], ['мектеп', 'мектеп', 'мектептегі'],
    ['аула', 'аула', 'ауладағы'], ['қала', 'қала', 'қаладағы'], ['ауыл', 'ауыл', 'ауылдағы'], ['пойыз', 'пойыз', 'пойыздағы'], ['үй', 'үй', 'үйдегі'],
  ],
  en: [
    ['park', 'park', 'in the park'], ['forest', 'forest', 'in the forest'], ['lake', 'lake', 'by the lake'], ['river', 'river', 'by the river'],
    ['sea', 'sea', 'by the sea'], ['mountain', 'mountains', 'in the mountains'], ['office', 'office', 'in the office'], ['cafe', 'cafe', 'in a cafe'],
    ['school', 'school', 'at school'], ['beach', 'beach', 'on the beach'], ['train', 'train', 'on the train'], ['home', 'home', 'at home'],
  ],
};

// [основа, название]  (предметы, события)
const THINGS = {
  ru: [
    ['какао', 'какао'], ['чай', 'чай'], ['кофе', 'кофе'], ['дожд', 'дождь'], ['снег', 'снег'], ['закат', 'закат'], ['разговор', 'разговоры'],
    ['дедлайн', 'дедлайн'], ['экзамен', 'экзамен'], ['музык', 'музыка'], ['книг', 'книга'], ['фильм', 'фильм'], ['ужин', 'ужин'], ['завтрак', 'завтрак'],
    ['танц', 'танцы'], ['концерт', 'концерт'], ['друз', 'друзья'], ['семь', 'семья'], ['бабушк', 'бабушка'], ['прогулк', 'прогулка'], ['гуляли', 'прогулка'],
    ['трениров', 'тренировка'], ['праздн', 'праздник'], ['подар', 'подарок'], ['торт', 'торт'], ['велосипед', 'велосипед'], ['футбол', 'футбол'],
    ['проект', 'проект'], ['презентаци', 'презентация'], ['поездк', 'поездка'], ['встреч', 'встреча'], ['листь', 'листья'], ['ветер', 'ветер'], ['пицц', 'пицца'],
  ],
  kk: [
    ['какао', 'какао'], ['шай', 'шай'], ['кофе', 'кофе'], ['жаңбыр', 'жаңбыр'], ['қар', 'қар'], ['күн бат', 'күн батуы'], ['сөйлес', 'әңгіме'], ['емтихан', 'емтихан'],
    ['дедлайн', 'дедлайн'], ['музыка', 'музыка'], ['кітап', 'кітап'], ['фильм', 'фильм'], ['түскі ас', 'түскі ас'], ['би', 'би'], ['концерт', 'концерт'],
    ['дос', 'достар'], ['отбасы', 'отбасы'], ['әже', 'әже'], ['серуен', 'серуен'], ['жаттығ', 'жаттығу'], ['мереке', 'мереке'], ['сыйлық', 'сыйлық'],
    ['футбол', 'футбол'], ['жоба', 'жоба'], ['сапар', 'сапар'], ['кездесу', 'кездесу'], ['жапырақ', 'жапырақтар'], ['жел', 'жел'],
  ],
  en: [
    ['cocoa', 'cocoa'], ['tea', 'tea'], ['coffee', 'coffee'], ['rain', 'rain'], ['snow', 'snow'], ['sunset', 'sunset'], ['talk', 'long talks'], ['deadline', 'a deadline'],
    ['exam', 'an exam'], ['music', 'music'], ['book', 'a book'], ['movie', 'a movie'], ['dinner', 'dinner'], ['dance', 'dancing'], ['concert', 'a concert'],
    ['friend', 'friends'], ['family', 'family'], ['walk', 'a walk'], ['workout', 'a workout'], ['party', 'a party'], ['gift', 'a gift'], ['football', 'football'],
  ],
};

const TIME = {
  ru: { morning: 'Утро', day: 'День', evening: 'Вечер', night: 'Ночь' },
  kk: { morning: 'Таң', day: 'Күн', evening: 'Кеш', night: 'Түн' },
  en: { morning: 'Morning', day: 'Day', evening: 'Evening', night: 'Night' },
};
const SEASON = {
  ru: { autumn: 'осенних', winter: 'зимних', spring: 'весенних', summer: 'летних' },
  kk: { autumn: 'күзгі', winter: 'қысқы', spring: 'көктемгі', summer: 'жазғы' },
  en: { autumn: 'autumn', winter: 'winter', spring: 'spring', summer: 'summer' },
};
const SEASON_WORD = {
  ru: { autumn: 'Осень', winter: 'Зима', spring: 'Весна', summer: 'Лето' },
  kk: { autumn: 'Күз', winter: 'Қыс', spring: 'Көктем', summer: 'Жаз' },
  en: { autumn: 'Autumn', winter: 'Winter', spring: 'Spring', summer: 'Summer' },
};

const find = (list, text) => {
  const found = [];
  for (const [stem, ...rest] of list) {
    const i = text.search(new RegExp('(?:^|[^\\p{L}])' + stem, 'iu'));
    if (i >= 0) found.push({ i, rest });
  }
  return found.sort((a, b) => a.i - b.i);
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const AND = { ru: ' и ', kk: ' және ', en: ' and ' };

export function localTitle(text, analysis = {}, lang = 'ru') {
  if (!['ru', 'kk', 'en'].includes(lang)) lang = 'ru';
  const t = String(text || '').toLowerCase();
  const places = find(PLACES[lang], t);
  const WEAK = /^(прогулка|серуен|a walk)$/;
  const things = find(THINGS[lang], t)
    .filter((x, idx, arr) => arr.findIndex((y) => y.rest[0] === x.rest[0]) === idx)
    .sort((a, b) => Number(WEAK.test(a.rest[0])) - Number(WEAK.test(b.rest[0])) || a.i - b.i);
  const tod = TIME[lang][analysis.time_of_day];
  const season = analysis.season && analysis.season !== 'unknown' ? analysis.season : null;
  const and = AND[lang];

  let title = '';
  if (places.length) {
    const ph = places[0].rest[1];
    const head = lang === 'kk'
      ? `${cap(ph)} ${(tod || TIME.kk.day).toLowerCase()}`
      : `${tod || (season ? SEASON_WORD[lang][season] : TIME[lang].day)} ${ph}`;
    title = things.length ? `${head}${and}${things[0].rest[0]}` : head;
    if (title.split(' ').length < 3) title += lang === 'ru' ? ' без спешки' : lang === 'kk' ? ' тыныш' : ' slowly';
  } else if (things.length >= 2) {
    title = `${tod || SEASON_WORD[lang][season] || TIME[lang].day}, ${things[0].rest[0]}${and}${things[1].rest[0]}`;
  } else if (things.length === 1) {
    const lead = tod || (season ? SEASON_WORD[lang][season] : '');
    title = lead ? `${lead}${and}${things[0].rest[0]}` : `${cap(things[0].rest[0])}${and}${lang === 'ru' ? 'обычный день' : lang === 'kk' ? 'қарапайым күн' : 'an ordinary day'}`;
  } else if (tod) {
    const calm = (analysis.arousal ?? 0.45) < 0.5;
    title = lang === 'ru' ? `${tod} ${calm ? 'без спешки' : 'на бегу'}` : lang === 'kk' ? `${tod} ${calm ? 'асықпай өтті' : 'жүгіріспен өтті'}` : `${tod} ${calm ? 'without a rush' : 'on the run'}`;
  } else {
    const s = season ? SEASON[lang][season] : null;
    title = lang === 'ru' ? `Один из ${s || 'обычных'} дней` : lang === 'kk' ? `${s ? cap(s) + ' ' : 'Қарапайым '}күндердің бірі` : `One of the ${s || 'ordinary'} days`;
  }

  title = cap(title.replace(/\s+/g, ' ').trim());
  const words = title.split(' ');
  return words.length > 7 ? words.slice(0, 7).join(' ') : title;
}
