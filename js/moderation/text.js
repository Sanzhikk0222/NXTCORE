// Проверка текста и ников в браузере. Это подсказка до отправки: окончательное решение
// всегда принимает база (supabase/sql/02_moderation.sql), логика у них одна и та же.

import { tokens, squash } from './norm.js';
import { WORDS } from './words.js';

const matches = (w, toks) => {
  if (w.m === 'token') return toks.includes(w.n);
  if (w.m === 'prefix') return toks.some((t) => t.startsWith(w.n));
  return toks.some((t) => t.includes(w.n));
};

const LINK = /(https?:\/\/|www\.|t\.me\/|wa\.me\/)|\+?\d[\d\s\-()]{8,}\d/i;

export function checkText(text) {
  const toks = tokens(text);
  if (!toks.length) return { ok: true };
  const hits = WORDS.filter((w) => w.s === 'block' && w.c !== 'reserved' && matches(w, toks));
  if (hits.length) return { ok: false, code: 'forbidden', words: [...new Set(hits.map((h) => h.w))] };

  const soft = WORDS.filter((w) => w.s === 'soft' && matches(w, toks)).length;
  if (soft >= 2 || (soft >= 1 && LINK.test(String(text).toLowerCase()))) return { ok: false, code: 'spam' };
  return { ok: true };
}

export function checkDisplayName(name) {
  const r = checkText(name);
  if (!r.ok && r.code === 'forbidden') return r;
  const sq = squash(name);
  if (WORDS.some((w) => w.c === 'reserved' && sq.includes(w.n))) return { ok: false, code: 'reserved' };
  return { ok: true };
}

export function checkUsername(raw) {
  const name = String(raw || '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(name) || !/[a-z]/.test(name)) return { ok: false, code: 'format' };
  const toks = tokens(name);
  const sq = squash(name);
  let code = null;
  for (const w of WORDS) {
    if (w.s !== 'block') continue;
    if (w.c === 'reserved') {
      if (sq.includes(w.n)) return { ok: false, code: 'reserved' };
    } else if (!code) {
      const hit = w.m === 'token' ? toks.includes(w.n)
        : w.m === 'prefix' ? toks.some((t) => t.startsWith(w.n))
        : sq.includes(w.n);
      if (hit) code = 'forbidden';
    }
  }
  return code ? { ok: false, code } : { ok: true };
}
