// Нормализация текста для проверки на запрещённые слова.
// Те же пять шагов, что в supabase/sql/01_schema.sql (функция nx_norm).
// Расхождение между клиентом и базой проверяет tests/parity.mjs.

const FOLD = {
  'ё': 'е', // ё → е
  'й': 'и', // й → и
  'ә': 'а', // ә → а
  'ғ': 'г', // ғ → г
  'қ': 'к', // қ → к
  'ң': 'н', // ң → н
  'ө': 'о', // ө → о
  'ұ': 'у', // ұ → у
  'ү': 'у', // ү → у
  'һ': 'х', // һ → х
  'і': 'и', // і → и
  'ь': '',       // ь убирается
};

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't' };

const LOOK = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м',
  o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', i: 'и',
};

function mapChars(str, map) {
  let out = '';
  for (const ch of str) out += ch in map ? map[ch] : ch;
  return out;
}

export function norm(text) {
  const s = mapChars(mapChars(mapChars(String(text ?? '').toLowerCase(), FOLD), LEET), LOOK);
  return s.replace(/([\s\S])\1+/g, '$1');
}

const SPLIT = /[^a-zа-я0-9]+/;

export function tokens(text) {
  return norm(text).split(SPLIT).filter(Boolean);
}

export function squash(text) {
  return norm(text).replace(/[^a-zа-я0-9]+/g, '').replace(/([\s\S])\1+/g, '$1');
}
