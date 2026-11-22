// Собирает список запрещённых слов из data/banned-words.json в два файла:
//   supabase/sql/07_banned_words_seed.sql  (для базы)
//   js/moderation/words.js                 (для проверки в браузере)
// Запуск: node scripts/gen-words.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { norm } from '../js/moderation/norm.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { entries } = JSON.parse(readFileSync(join(root, 'data/banned-words.json'), 'utf8'));

const LANGS = new Set(['ru', 'kk', 'en']);
const CATS = new Set(['profanity', 'insult', 'slur', 'spam', 'reserved']);
const SEVS = new Set(['block', 'soft']);
const MATCH = new Set(['token', 'prefix', 'substr']);

const seen = new Set();
for (const [word, lang, cat, sev, match] of entries) {
  if (!word || /['"\\]/.test(word)) throw new Error(`Плохое слово: ${word}`);
  if (!LANGS.has(lang) || !CATS.has(cat) || !SEVS.has(sev) || !MATCH.has(match)) {
    throw new Error(`Плохая строка: ${[word, lang, cat, sev, match]}`);
  }
  const key = `${word}|${lang}`;
  if (seen.has(key)) throw new Error(`Дубль: ${key}`);
  seen.add(key);
}

const esc = (s) => s.replace(/'/g, "''");
const values = entries
  .map(([w, l, c, s, m]) => `  ('${esc(w)}', '${l}', '${c}', '${s}', '${m}')`)
  .join(',\n');

writeFileSync(
  join(root, 'supabase/sql/07_banned_words_seed.sql'),
  `-- ============================================================================
-- NXTCORE · 07 · Начальный список запрещённых слов
-- Сгенерировано из data/banned-words.json (node scripts/gen-words.mjs).
-- Свои слова добавляйте так:
--   insert into public.banned_words (word, language, category, severity, match_type)
--   values ('слово', 'ru', 'profanity', 'block', 'token');
-- Типы совпадения: token = слово целиком, prefix = начало слова, substr = внутри слова.
-- ============================================================================

insert into public.banned_words (word, language, category, severity, match_type)
values
${values}
on conflict (word, language) do update
  set category = excluded.category,
      severity = excluded.severity,
      match_type = excluded.match_type;
`
);

const compact = entries.map(([w, l, c, s, m]) => ({ w, l, c, s, m, n: norm(w) }));
writeFileSync(
  join(root, 'js/moderation/words.js'),
  `// Сгенерировано из data/banned-words.json: node scripts/gen-words.mjs. Руками не править.
// w — слово, l — язык, c — категория, s — строгость, m — тип совпадения, n — нормализованная форма.
export const WORDS = ${JSON.stringify(compact)};
`
);

console.log(`Слов: ${entries.length}`);
