// Проверка переводов: каждый ключ, который используется в коде, есть в ru и kk, а наборы совпадают.
// Запуск: node scripts/check-i18n.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ru from '../js/i18n/ru.js';
import kk from '../js/i18n/kk.js';

const root = new URL('..', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (f === 'node_modules' || f === 'i18n') continue;
    if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
})(join(root, 'js'));

const used = new Set();
const dynamic = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\bt\(\s*(['`])([^'`]+)\1/g)) {
    if (m[2].includes('${')) dynamic.push([f, m[2]]); else used.add(m[2]);
  }
}
// динамические ключи вида `mood.${m}`: раскрываем известные семейства
const families = {
  'mood.${m}': ['warm', 'cold', 'energetic'], 'report.${r}': ['spam', 'insult', 'nsfw', 'other'], 'weather.${k}': ['clear', 'cloudy', 'rain', 'snow', 'fog'],
  'compose.vis_${v}': ['private', 'public'], 'music.tempo_${k}': ['slow', 'medium', 'fast'], 'music.energy_${k}': ['calm', 'medium', 'lively'],
  'music.mode_${info.mode}': ['major', 'minor', 'unknown'], 'notif.${n.type}': ['like', 'comment', 'follow'], 'err.${code}': [],
};
for (const [, key] of dynamic) {
  if (key in families) for (const v of families[key]) used.add(key.replace(/\$\{[^}]+\}/, v));
  else console.log('динамический ключ без проверки:', key);
}

for (const k of ['report.title_post','report.title_user','setup.lead','setup.lead_name']) used.add(k);
let bad = 0;
const miss = (lang, d) => { for (const k of used) if (!(k in d)) { console.log(`нет в ${lang}:`, k); bad++; } };
miss('ru', ru); miss('kk', kk);
for (const k of Object.keys(ru)) if (!(k in kk)) { console.log('нет перевода kk:', k); bad++; }
for (const k of Object.keys(kk)) if (!(k in ru)) { console.log('лишний ключ kk:', k); bad++; }
const unused = Object.keys(ru).filter((k) => !used.has(k) && !k.startsWith('err.'));
if (unused.length) console.log(`не используются (${unused.length}):`, unused.join(', '));
console.log(bad ? `Проблем: ${bad}` : `Переводы в порядке (${Object.keys(ru).length} ключей)`);
process.exit(bad ? 1 : 0);
