// Общее для формы записи и страницы дня: как из записи получить данные для рендера.
import { t, getLang } from '../i18n/index.js';
import { fmtDate } from '../core/ui.js';
import { PROVIDER_LABEL } from '../memory/music.js';

export function weatherKind(code) {
  if (code == null) return null;
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return null;
}

export function weatherLabel(w) {
  if (!w || w.code == null) return '';
  const k = weatherKind(w.code);
  const temp = Number.isFinite(w.temp) ? `${Math.round(w.temp)}°` : '';
  return [temp, k ? t(`weather.${k}`) : ''].filter(Boolean).join(', ');
}

export function musicLine(music) {
  if (!music) return '';
  const name = [music.artist, music.title].filter(Boolean).join(' · ');
  if (name) return name;
  const bits = [music.genre, music.bpm ? t('music.bpm', { n: music.bpm }) : ''].filter(Boolean);
  return bits.join(' · ');
}

export function metaText(music, weather) {
  return [musicLine(music), weatherLabel(weather)].filter(Boolean).join('   ·   ');
}

export function dateTextFor(day) {
  return fmtDate(day, { day: 'numeric', month: 'long', year: 'numeric' });
}
export function dateStampFor(day) {
  return `${day.slice(8, 10)} ${day.slice(5, 7)} '${day.slice(2, 4)}`;
}

export function renderData({ photos, title, day, music, weather, sign, scale }) {
  return { photos, title, dateText: dateTextFor(day), dateStamp: dateStampFor(day), metaText: metaText(music, weather), sign, scale };
}

export const providerLabel = (p) => PROVIDER_LABEL[p] || '';
export { getLang };
