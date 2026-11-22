// Пример для страницы входа: три придуманных дня, нарисованных настоящим движком.
// Это витрина, а не записи. Подписано как «пример», в ленту не попадает.
import { analyzeText } from '../memory/text-analysis.js';
import { buildMemory } from '../memory/engine.js';
import { resolveMusic } from '../memory/music.js';
import { featuresFromImage, mergePhotoFeatures } from '../memory/image-features.js';
import { createPlayer } from '../memory/render.js';
import { localTitle } from '../memory/title.js';
import { loadImage } from '../core/media.js';
import { getLang } from '../i18n/index.js';

const SAMPLES = {
  ru: [
    { text: 'Гуляли по парку, листья под ногами, пили какао из термоса. Тихо и тепло.', rgb: [196, 130, 60], music: { genre: 'jazz', year: 1964 }, date: '2026-10-18', meta: 'jazz · 1964', sign: 'Аян' },
    { text: 'Ночью в офисе, дедлайн горит, кофе третья чашка, срочно сдать проект.', rgb: [30, 40, 70], music: { genre: 'techno', bpm: 138 }, date: '2026-11-03', meta: 'techno · 138 уд/мин', sign: 'Дина' },
    { text: 'Дождь весь день, читал один, тихо и немного грустно.', rgb: [110, 120, 135], music: { genre: 'ambient' }, date: '2026-09-22', meta: 'ambient', sign: 'Тимур' },
  ],
  kk: [
    { text: 'Саябақта серуендедік, жапырақтар аяқ астында, термостан какао іштік. Тыныш әрі жылы.', rgb: [196, 130, 60], music: { genre: 'jazz', year: 1964 }, date: '2026-10-18', meta: 'jazz · 1964', sign: 'Аян' },
    { text: 'Түнде кеңседе, дедлайн жақын, үшінші кесе кофе, жобаны тез тапсыру керек.', rgb: [30, 40, 70], music: { genre: 'techno', bpm: 138 }, date: '2026-11-03', meta: 'techno · 138', sign: 'Дина' },
    { text: 'Күні бойы жаңбыр, жалғыз кітап оқыдым, тыныш әрі сәл мұңды.', rgb: [110, 120, 135], music: { genre: 'ambient' }, date: '2026-09-22', meta: 'ambient', sign: 'Тимур' },
  ],
};

function landscape(rgb, w = 640, h = 480) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const [r, gg, b] = rgb;
  const sky = g.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, `rgb(${r},${gg},${b})`);
  sky.addColorStop(1, `rgb(${Math.min(255, r + 50)},${Math.min(255, gg + 40)},${Math.min(255, b + 20)})`);
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.fillStyle = `rgb(${r * 0.5 | 0},${gg * 0.55 | 0},${b * 0.5 | 0})`; g.fillRect(0, h * 0.62, w, h * 0.38);
  for (let i = 0; i < 9; i++) {
    g.fillStyle = `rgba(${(r * (0.4 + i * 0.07)) | 0},${(gg * 0.5) | 0},${(b * 0.4) | 0},.9)`;
    g.beginPath(); g.arc(60 + i * 70, h * 0.58, 26 + (i % 3) * 14, 0, 7); g.fill();
  }
  g.fillStyle = 'rgba(255,240,200,.9)'; g.beginPath(); g.arc(w * 0.78, h * 0.22, 40, 0, 7); g.fill();
  return c;
}

export function startDemo(canvas, reduceMotion = false) {
  const lang = getLang();
  const list = SAMPLES[lang] || SAMPLES.ru;
  let i = 0, player = null, timer = 0, dead = false;

  async function show() {
    const s = list[i % list.length];
    const c = landscape(s.rgb);
    const img = await loadImage(c.toDataURL('image/jpeg', 0.8));
    const text = analyzeText(s.text);
    const memory = buildMemory({
      text, photos: mergePhotoFeatures([featuresFromImage(img)]),
      music: resolveMusic({ meta: {}, manual: s.music }), date: s.date,
    }, { seed: 7 + i, sign: s.sign });
    if (dead) return;
    player?.destroy();
    player = await createPlayer(canvas, memory, {
      photos: [img], title: localTitle(s.text, text, lang), metaText: s.meta, sign: s.sign, scale: 0.55,
      dateText: new Date(s.date + 'T12:00:00').toLocaleDateString(lang === 'kk' ? 'kk-KZ' : 'ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
      dateStamp: s.date.slice(8) + ' ' + s.date.slice(5, 7) + " '" + s.date.slice(2, 4),
    });
    if (dead) return player.destroy();
    if (reduceMotion) player.renderStill(); else player.play();
    i++;
    timer = setTimeout(show, 10_000);
  }
  show().catch(() => {});
  return () => { dead = true; clearTimeout(timer); player?.destroy(); };
}
