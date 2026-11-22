import ru from './ru.js';
import kk from './kk.js';

const DICTS = { ru, kk };
export const LANGS = [['ru', 'Русский'], ['kk', 'Қазақша']];
let lang = 'ru';

export const getLang = () => lang;

export function setLang(l) {
  if (!DICTS[l]) l = 'ru';
  lang = l;
  document.documentElement.lang = l === 'kk' ? 'kk' : 'ru';
  try { localStorage.setItem('nx_lang', l); } catch { /* приватный режим */ }
}

export function detectLang() {
  try {
    const saved = localStorage.getItem('nx_lang');
    if (DICTS[saved]) return saved;
  } catch { /* ничего */ }
  return /^kk/i.test(navigator.language || '') ? 'kk' : 'ru';
}

// t('feed.empty') или t('toast.strike', { n: 2 }); если перевода нет, берём русский, потом сам ключ
export function t(key, params) {
  let s = DICTS[lang]?.[key] ?? DICTS.ru[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
