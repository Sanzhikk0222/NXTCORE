// Что видно на фото: доминирующие цвета, свет, тепло, насыщенность.
// featuresFromPixels принимает обычный массив RGBA, поэтому проверяется в Node.

import { rgbToOklch, hueDistance, clamp } from './color.js';

export function featuresFromPixels(data, width, height) {
  const n = width * height;
  if (!n) return null;

  let sumL = 0, sumC = 0, warm = 0, sumL2 = 0;
  const pts = [];
  const stride = Math.max(1, Math.floor(n / 1600));
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const { L, C, h } = rgbToOklch(r, g, b);
    sumL += L; sumL2 += L * L; sumC += C;
    warm += (r - b) / 255;
    if (i % stride === 0) pts.push([L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180), C, h]);
  }
  const light = sumL / n;
  const colorful = clamp((sumC / n) / 0.16, 0, 1);
  const contrast = clamp(Math.sqrt(Math.max(0, sumL2 / n - light * light)) / 0.3, 0, 1);

  // k-средних в OKLab: 4 доминирующих цвета
  const k = Math.min(4, pts.length);
  const centers = [];
  const sorted = [...pts].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < k; i++) centers.push(sorted[Math.floor(((i + 0.5) / k) * sorted.length)].slice(0, 3));
  const owner = new Int16Array(pts.length);
  for (let it = 0; it < 6; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    pts.forEach((p, idx) => {
      let best = 0, bd = Infinity;
      centers.forEach((c, ci) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) { bd = d; best = ci; }
      });
      owner[idx] = best;
      acc[best][0] += p[0]; acc[best][1] += p[1]; acc[best][2] += p[2]; acc[best][3]++;
    });
    acc.forEach((a, ci) => { if (a[3]) centers[ci] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  const counts = new Array(k).fill(0);
  owner.forEach((o) => counts[o]++);
  const dominant = centers
    .map((c, i) => {
      const C = Math.hypot(c[1], c[2]);
      let h = (Math.atan2(c[2], c[1]) * 180) / Math.PI;
      if (h < 0) h += 360;
      return { L: c[0], C, h, share: counts[i] / pts.length };
    })
    .sort((a, b) => b.share - a.share);

  // главный оттенок: самый насыщенный из заметных цветов
  const chromatic = dominant.filter((d) => d.C > 0.03 && d.share > 0.08);
  const lead = chromatic.sort((a, b) => b.C * b.share - a.C * a.share)[0] || null;

  return {
    light: clamp(light, 0, 1),
    colorful,
    contrast,
    warmth: clamp(0.5 + (warm / n) * 1.6, 0, 1),
    hue: lead ? lead.h : null,
    chroma: lead ? lead.C : 0,
    dominant: dominant.map((d) => ({ L: +d.L.toFixed(3), C: +d.C.toFixed(3), h: +d.h.toFixed(1), share: +d.share.toFixed(3) })),
  };
}

// Сводка по нескольким фото: среднее с весом по насыщенности
export function mergePhotoFeatures(list) {
  const items = list.filter(Boolean);
  if (!items.length) return null;
  const avg = (key) => items.reduce((s, f) => s + f[key], 0) / items.length;
  const withHue = items.filter((f) => f.hue != null);
  let hue = null, chroma = 0;
  if (withHue.length) {
    let x = 0, y = 0, w = 0;
    withHue.forEach((f) => { const r = (f.hue * Math.PI) / 180; x += Math.cos(r) * f.chroma; y += Math.sin(r) * f.chroma; w += f.chroma; });
    hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    chroma = w / withHue.length;
  }
  return {
    count: items.length,
    light: avg('light'), colorful: avg('colorful'), contrast: avg('contrast'), warmth: avg('warmth'),
    hue, chroma,
    dominant: items.flatMap((f) => f.dominant).sort((a, b) => b.share * b.C - a.share * a.C).slice(0, 5),
  };
}

// Браузер: уменьшаем картинку до 56 px и считаем
export function featuresFromImage(img) {
  const w = 56, h = Math.max(8, Math.round((56 * (img.naturalHeight || img.height)) / (img.naturalWidth || img.width)));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return featuresFromPixels(ctx.getImageData(0, 0, w, h).data, w, h);
}

export { hueDistance };
