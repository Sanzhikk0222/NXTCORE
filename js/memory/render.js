// Рендер воспоминания дня на canvas.
//
// Что постоянно в каждом дне (это и делает набор дней серией):
//   формат 4:5, поля 5%, окно с фото на одном месте, тонкая рамка окна,
//   дата слева сверху, метка NXTCORE справа сверху, название Playfair Display слева снизу,
//   рукописная подпись Caveat справа снизу, строка с песней под названием, зерно поверх всего.
// Что меняется: техника, палитра, ритм смены кадров, воздух, контраст, зерно, движение.

import { rng, hashSeed, FRAME } from './engine.js';
import { hexToRgb, hexToOklch, rgbToOklch, oklchToRgb, mixHue, clamp, lerp } from './color.js';

export const BASE_W = 1080;
export const BASE_H = 1350;
export const STILL_TIME = 7;

const mk = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};
const ease = (x) => 1 - (1 - clamp(x, 0, 1)) ** 3;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const rgbStr = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

function coverCanvas(img, w, h, zoom = 1) {
  const c = mk(w, h), g = c.getContext('2d');
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const r = Math.max(w / iw, h / ih) * zoom;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (w - iw * r) / 2, (h - ih * r) / 2, iw * r, ih * r);
  return c;
}

// Размытие без ctx.filter (его нет в части браузеров): уменьшили и растянули обратно
function blurCanvas(src, k) {
  let cur = src;
  let left = k;
  while (left > 1) {
    const step = Math.min(left, 3);
    const next = mk(cur.width / step, cur.height / step);
    const g = next.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
    left /= step;
  }
  const out = mk(src.width, src.height), og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  og.drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

function mapPixels(canvas, fn) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) fn(d, i);
  g.putImageData(img, 0, 0);
}

function synthSource(c, rand, w, h) {
  const cv = mk(w, h), g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, c.pal.soft);
  grd.addColorStop(1, c.pal.bg);
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 6; i++) {
    const x = rand() * w, y = rand() * h, r = (0.15 + rand() * 0.3) * Math.min(w, h);
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const col = i % 2 ? c.pal.accent : c.pal.accent2;
    rg.addColorStop(0, col + 'cc');
    rg.addColorStop(1, col + '00');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  }
  return cv;
}

// ============================================================== техники
// Каждая принимает фото (или null), контекст и генератор случайных чисел,
// возвращает canvas размера окна (плюс поле bleed, если оно нужно).

function impressionist(img, c, rand, w, h) {
  const cv = mk(w, h), g = cv.getContext('2d');
  const src = img ? coverCanvas(img, w, h) : synthSource(c, rand, w, h);
  g.drawImage(blurCanvas(src, 14), 0, 0, w, h);
  g.globalAlpha = 0.2;
  g.fillStyle = c.pal.soft;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;

  const sw = Math.round(w / 8), sh = Math.round(h / 8);
  const sm = mk(sw, sh);
  sm.getContext('2d').drawImage(src, 0, 0, sw, sh);
  const px = sm.getContext('2d').getImageData(0, 0, sw, sh).data;
  const lum = new Float32Array(sw * sh);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  const at = (x, y) => lum[clamp(y, 0, sh - 1) * sw + clamp(x, 0, sw - 1)];

  const pullHue = hexToOklch(c.pal.accent).h;
  const pull = 0.2 + c.v.warmth * 0.08;
  const passes = [
    { size: 38 * c.s, k: 1.4, detail: 0 },
    { size: 21 * c.s, k: 2.6, detail: 0 },
    { size: 10 * c.s, k: 3.4, detail: 0.35 },
  ];
  let maxGrad = 1;
  for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
    maxGrad = Math.max(maxGrad, Math.hypot(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1)));
  }

  for (const p of passes) {
    const n = Math.round(((w * h) / (p.size * p.size)) * p.k);
    for (let i = 0; i < n; i++) {
      const x = rand() * w, y = rand() * h;
      const cx = Math.floor((x / w) * sw), cy = Math.floor((y / h) * sh);
      const gx = at(cx + 1, cy) - at(cx - 1, cy), gy = at(cx, cy + 1) - at(cx, cy - 1);
      const mag = Math.hypot(gx, gy) / maxGrad;
      if (mag < p.detail * 0.5 && p.detail) continue;
      const o = (cy * sw + cx) * 4;
      const ok = rgbToOklch(px[o], px[o + 1], px[o + 2]);
      const rgb = oklchToRgb(
        clamp(ok.L + (rand() - 0.5) * 0.07 + (c.v.light - 0.5) * 0.05, 0.05, 0.98),
        ok.C * 1.1 + 0.004,
        mixHue(ok.h, pullHue, pull) + (rand() - 0.5) * 9,
      );
      const angle = Math.atan2(gy, gx) + Math.PI / 2 + (rand() - 0.5) * 0.9;
      const len = p.size * (1.3 + rand() * 0.9), half = len / 2;
      g.strokeStyle = rgbStr(rgb[0], rgb[1], rgb[2], 0.82);
      g.lineWidth = p.size * (0.42 + rand() * 0.15);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x - Math.cos(angle) * half, y - Math.sin(angle) * half);
      g.lineTo(x + Math.cos(angle) * half, y + Math.sin(angle) * half);
      g.stroke();
    }
  }
  // дымка света, как в плейнере
  g.globalCompositeOperation = 'screen';
  g.globalAlpha = 0.12 + c.v.light * 0.1;
  g.drawImage(blurCanvas(cv, 6), 0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return cv;
}

function kandinsky(img, c, rand, w, h) {
  const cv = mk(w, h), g = cv.getContext('2d');
  const { pal, v, s } = c;
  g.fillStyle = pal.dark ? pal.soft : pal.soft;
  g.fillRect(0, 0, w, h);
  const m = Math.min(w, h);
  const sign = rand() < 0.5 ? 1 : -1;
  const theta = (sign * (16 + v.arousal * 40) * Math.PI) / 180;
  const R = (a, b) => a + rand() * (b - a);

  // сетка: чем больше напряжения, тем гуще
  g.strokeStyle = pal.ink;
  g.globalAlpha = 0.16;
  g.lineWidth = 2 * s;
  const cols = 5 + Math.round(v.tension * 6);
  for (let i = 1; i < cols; i++) { g.beginPath(); g.moveTo((w / cols) * i, 0); g.lineTo((w / cols) * i, h); g.stroke(); }
  for (let i = 1; i < cols; i++) { g.beginPath(); g.moveTo(0, (h / cols) * i); g.lineTo(w, (h / cols) * i); g.stroke(); }
  g.globalAlpha = 1;

  // фото как дуотон в круге или прямоугольнике
  const pw = m * R(0.42, 0.52);
  const px0 = w * R(0.18, 0.5), py0 = h * R(0.18, 0.4);
  const src = img ? coverCanvas(img, Math.round(pw), Math.round(pw)) : synthSource(c, rand, Math.round(pw), Math.round(pw));
  const lo = hexToRgb(pal.deep), hi = hexToRgb(pal.dark ? pal.accent : pal.soft);
  mapPixels(src, (d, i) => {
    let t = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    t = clamp((t - 0.5) * (1.1 + c.contrast * 0.8) + 0.5, 0, 1);
    d[i] = lerp(lo[0], hi[0], t); d[i + 1] = lerp(lo[1], hi[1], t); d[i + 2] = lerp(lo[2], hi[2], t);
  });

  const circle = rand() < 0.6;
  g.save();
  g.beginPath();
  if (circle) g.arc(px0 + pw / 2, py0 + pw / 2, pw / 2, 0, Math.PI * 2);
  else g.rect(px0, py0, pw, pw);
  g.clip();
  g.drawImage(src, px0, py0);
  g.restore();

  // геометрия поверх
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = pal.accent;
  g.beginPath();
  g.arc(w * R(0.6, 0.8), h * R(0.55, 0.75), m * R(0.14, 0.22), 0, Math.PI * 2);
  g.fill();

  g.fillStyle = pal.accent2;
  const tx = w * R(0.15, 0.55), ty = h * R(0.5, 0.7), ts = m * R(0.3, 0.45);
  g.save();
  g.translate(tx, ty);
  g.rotate(theta);
  g.beginPath(); g.moveTo(0, -ts * 0.6); g.lineTo(ts * 0.55, ts * 0.45); g.lineTo(-ts * 0.55, ts * 0.45); g.closePath(); g.fill();
  g.restore();
  g.globalCompositeOperation = 'source-over';

  // длинные линии под углом
  g.strokeStyle = pal.ink;
  g.lineCap = 'round';
  const lines = 3 + Math.round(v.tension * 5);
  for (let i = 0; i < lines; i++) {
    const off = R(-0.5, 1.2) * w;
    g.lineWidth = (i === 0 ? 7 : 2.5) * s;
    g.beginPath();
    g.moveTo(off, -20);
    g.lineTo(off + Math.tan(theta) * h * 1.2, h * 1.2);
    g.stroke();
  }
  // дуги, кольцо, пунктир, квадраты
  g.strokeStyle = pal.accent2; g.lineWidth = 11 * s;
  g.beginPath(); g.arc(w * R(0.2, 0.5), h * R(0.7, 1), m * R(0.2, 0.34), Math.PI * 1.1, Math.PI * 1.9); g.stroke();
  g.strokeStyle = pal.ink; g.lineWidth = 5 * s;
  g.beginPath(); g.arc(w * R(0.55, 0.85), h * R(0.15, 0.35), m * R(0.06, 0.1), 0, Math.PI * 2); g.stroke();
  g.fillStyle = pal.ink;
  const dots = 8 + Math.round(v.arousal * 8);
  const dx = R(0.1, 0.4) * w, dy = R(0.8, 0.95) * h;
  for (let i = 0; i < dots; i++) { g.beginPath(); g.arc(dx + i * 22 * s * Math.cos(theta), dy - i * 22 * s * Math.sin(theta + 0.3), 4.5 * s, 0, Math.PI * 2); g.fill(); }
  for (let i = 0; i < 3; i++) {
    g.save();
    g.translate(w * R(0.05, 0.95), h * R(0.05, 0.95)); g.rotate(R(0, Math.PI));
    g.fillStyle = i % 2 ? pal.accent : pal.ink;
    const q = m * R(0.02, 0.05);
    g.fillRect(-q, -q, q * 2, q * 2);
    g.restore();
  }
  return cv;
}

function film(img, c, rand, w, h) {
  const cv = mk(w, h), g = cv.getContext('2d');
  const src = img ? coverCanvas(img, w, h) : synthSource(c, rand, w, h);
  g.drawImage(src, 0, 0);
  const warm = (c.v.warmth - 0.5) * 2; // -1..1
  const fade = 0.05 + c.v.nostalgia * 0.06;
  mapPixels(cv, (d, i) => {
    let r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    // тёплые света и холодноватые тени
    r += (l - 0.5) * 0.1 * (1 + warm) + warm * 0.035;
    b -= (l - 0.5) * 0.1 * (1 + warm) + warm * 0.04;
    gg += warm * 0.006;
    // приглушаем насыщенность, поднимаем чёрный, мягкая S-кривая
    const gray = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    r = lerp(gray, r, 0.9); gg = lerp(gray, gg, 0.9); b = lerp(gray, b, 0.9);
    const curve = (x) => clamp(fade + x * (1 - fade) + (x - 0.5) * 0.14 * (0.6 + c.contrast), 0, 1);
    d[i] = curve(r) * 255; d[i + 1] = curve(gg) * 255; d[i + 2] = curve(b) * 255;
  });
  // ореол вокруг ярких мест
  const glow = mk(w, h);
  glow.getContext('2d').drawImage(cv, 0, 0);
  mapPixels(glow, (d, i) => {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const k = clamp((l - 190) / 65, 0, 1);
    d[i] *= k; d[i + 1] *= k * 0.8; d[i + 2] *= k * 0.6;
  });
  g.globalCompositeOperation = 'screen';
  g.globalAlpha = 0.55;
  g.drawImage(blurCanvas(glow, 10), 0, 0);
  g.globalAlpha = 1;

  // засветка из угла
  const corner = [[0, 0], [w, 0], [0, h], [w, h]][Math.floor(rand() * 4)];
  const lr = Math.min(w, h) * 0.75;
  const lg = g.createRadialGradient(corner[0], corner[1], 0, corner[0], corner[1], lr);
  lg.addColorStop(0, c.pal.accent2 + 'aa');
  lg.addColorStop(1, c.pal.accent2 + '00');
  g.globalAlpha = 0.28 + c.v.nostalgia * 0.25;
  g.fillStyle = lg;
  g.fillRect(0, 0, w, h);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  const vg = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, `rgba(10,6,2,${0.3 + c.contrast * 0.2})`);
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);

  // пыль и царапины
  for (let i = 0; i < 50; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(255,248,230,.5)' : 'rgba(20,12,6,.35)';
    g.beginPath(); g.arc(rand() * w, rand() * h, (0.6 + rand() * 1.8) * c.s, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = 'rgba(255,248,230,.18)';
  g.lineWidth = c.s;
  for (let i = 0; i < 2; i++) { const x = rand() * w; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (rand() - 0.5) * 8, h); g.stroke(); }

  // бумажная рамка и штамп даты, как на отпечатке
  g.strokeStyle = c.pal.dark ? c.pal.soft : '#f7f2e8';
  g.lineWidth = 26 * c.s;
  g.strokeRect(0, 0, w, h);
  if (c.dateStamp) {
    g.font = `600 ${Math.round(24 * c.s)}px ${FRAME.fonts.ui}`;
    g.textAlign = 'right';
    g.shadowColor = 'rgba(255,120,30,.8)';
    g.shadowBlur = 8 * c.s;
    g.fillStyle = '#ff8a3a';
    g.fillText(c.dateStamp, w - 44 * c.s, h - 44 * c.s);
    g.shadowBlur = 0;
    g.textAlign = 'left';
  }
  return cv;
}

function tornPath(g, x, y, w, h, rand, s) {
  const jag = 3.2 * s;
  const edge = (x0, y0, x1, y1) => {
    const n = Math.round(Math.hypot(x1 - x0, y1 - y0) / (14 * s));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      g.lineTo(lerp(x0, x1, t) + (rand() - 0.5) * jag * 2, lerp(y0, y1, t) + (rand() - 0.5) * jag * 2);
    }
  };
  g.beginPath();
  g.moveTo(x, y);
  edge(x, y, x + w, y); edge(x + w, y, x + w, y + h); edge(x + w, y + h, x, y + h); edge(x, y + h, x, y);
  g.closePath();
}

function collage(imgs, c, rand, w, h, heroIndex) {
  const cv = mk(w, h), g = cv.getContext('2d');
  const { pal, s, v } = c;
  g.fillStyle = pal.soft;
  g.fillRect(0, 0, w, h);
  // волокна бумаги
  g.strokeStyle = pal.ink;
  g.globalAlpha = 0.05;
  for (let i = 0; i < 220; i++) { const x = rand() * w, y = rand() * h; g.lineWidth = s * 0.8; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 30 * s, y + (rand() - 0.5) * 30 * s); g.stroke(); }
  g.globalAlpha = 1;

  // цветные плашки
  const block = (col, x, y, bw, bh, rot) => {
    g.save(); g.translate(x, y); g.rotate(rot); g.fillStyle = col; g.fillRect(-bw / 2, -bh / 2, bw, bh); g.restore();
  };
  block(pal.accent, w * 0.72, h * 0.28, w * 0.55, h * 0.3, -0.1);
  block(pal.accent2, w * 0.25, h * 0.78, w * 0.5, h * 0.26, 0.07);
  // растр на плашке
  g.save();
  g.beginPath(); g.rect(w * 0.42, h * 0.62, w * 0.5, h * 0.3); g.clip();
  g.fillStyle = pal.ink; g.globalAlpha = 0.28;
  const step = 16 * s;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) { g.beginPath(); g.arc(x + ((y / step) % 2) * step * 0.5, y, step * 0.28 * (0.4 + c.contrast * 0.6), 0, Math.PI * 2); g.fill(); }
  g.restore();

  const order = imgs.length ? imgs.map((_, i) => (i + heroIndex) % imgs.length) : [];
  const slots = [
    { x: 0.08, y: 0.1, w: 0.62, r: -0.045 },
    { x: 0.58, y: 0.5, w: 0.34, r: 0.1 },
    { x: 0.1, y: 0.62, w: 0.3, r: -0.12 },
  ];
  const shown = Math.min(order.length, 3);
  for (let k = shown - 1; k >= 0; k--) {
    const slot = slots[k], img = imgs[order[k]];
    const pw = w * slot.w, ratio = (img.naturalHeight || img.height) / (img.naturalWidth || img.width);
    const ph = pw * clamp(ratio, 0.75, 1.3);
    const pad = 15 * s;
    g.save();
    g.translate(w * slot.x + pw / 2, h * slot.y + ph / 2);
    g.rotate(slot.r);
    g.shadowColor = 'rgba(30,20,10,.4)';
    g.shadowBlur = 22 * s;
    g.shadowOffsetX = 7 * s; g.shadowOffsetY = 10 * s;
    tornPath(g, -pw / 2 - pad, -ph / 2 - pad, pw + pad * 2, ph + pad * 2, rand, s);
    g.fillStyle = '#fbf8f0';
    g.fill();
    g.shadowColor = 'transparent';
    g.save();
    g.beginPath(); g.rect(-pw / 2, -ph / 2, pw, ph); g.clip();
    g.drawImage(coverCanvas(img, Math.round(pw), Math.round(ph)), -pw / 2, -ph / 2);
    g.restore();
    if (k === 0) { // скотч
      g.rotate(0.35);
      g.fillStyle = pal.accent2 + 'b3';
      g.fillRect(-pw / 2 - 30 * s, -ph / 2 - 24 * s, 120 * s, 34 * s);
    }
    g.restore();
  }
  if (!shown) { // без фото: бумажные обрывки
    for (let i = 0; i < 3; i++) {
      g.save(); g.translate(w * (0.25 + i * 0.25), h * (0.3 + rand() * 0.3)); g.rotate((rand() - 0.5) * 0.4);
      tornPath(g, -w * 0.12, -h * 0.14, w * 0.24, h * 0.28, rand, s);
      g.fillStyle = i % 2 ? '#fbf8f0' : pal.accent; g.fill(); g.restore();
    }
  }

  // рукописные пометки: кружок и стрелка
  g.strokeStyle = pal.ink;
  g.lineWidth = 4.5 * s;
  g.lineCap = 'round';
  const ax = w * (0.62 + rand() * 0.2), ay = h * (0.12 + rand() * 0.1);
  g.beginPath();
  g.ellipse(ax, ay, 54 * s, 34 * s, -0.2, 0.2, Math.PI * 2.1);
  g.stroke();
  g.beginPath();
  g.moveTo(ax - 20 * s, ay + 80 * s);
  g.bezierCurveTo(ax - 80 * s, ay + 120 * s, ax - 60 * s, ay + 200 * s, ax - 140 * s, ay + 220 * s);
  g.stroke();
  g.beginPath(); g.moveTo(ax - 140 * s, ay + 220 * s); g.lineTo(ax - 108 * s, ay + 222 * s); g.moveTo(ax - 140 * s, ay + 220 * s); g.lineTo(ax - 128 * s, ay + 192 * s); g.stroke();
  return cv;
}

function ma(img, c, rand, w, h) {
  const cv = mk(w, h), g = cv.getContext('2d');
  const { pal, s, v } = c;
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = pal.ink;
  g.globalAlpha = 0.035;
  for (let i = 0; i < 260; i++) { const x = rand() * w, y = rand() * h; g.lineWidth = s; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 22 * s, y + (rand() - 0.5) * 6 * s); g.stroke(); }
  g.globalAlpha = 1;

  const side = rand() < 0.5 ? 0.3 : 0.7;
  const pw = w * lerp(0.5, 0.3, c.air + 0.2);
  const ph = pw * (rand() < 0.5 ? 1.25 : 1);
  const x0 = clamp(w * side - pw / 2, w * 0.06, w * 0.94 - pw);
  const y0 = h * lerp(0.2, 0.34, rand());
  const src = img ? coverCanvas(img, Math.round(pw), Math.round(ph)) : synthSource(c, rand, Math.round(pw), Math.round(ph));
  const tint = hexToRgb(pal.soft);
  mapPixels(src, (d, i) => {
    const gray = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    for (let k = 0; k < 3; k++) d[i + k] = lerp(lerp(gray, d[i + k], 0.62), tint[k], 0.1);
  });
  g.drawImage(src, x0, y0);
  g.strokeStyle = pal.ink; g.globalAlpha = 0.55; g.lineWidth = 1.5 * s;
  g.strokeRect(x0 - 16 * s, y0 - 16 * s, pw + 32 * s, ph + 32 * s);
  g.globalAlpha = 1;

  // единственный акцент и тонкая линия
  const r = Math.min(w, h) * (0.034 + v.warmth * 0.012);
  const dotX = side < 0.5 ? w * 0.82 : w * 0.17;
  g.fillStyle = pal.accent;
  g.beginPath(); g.arc(dotX, y0 + ph * rand(), r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = pal.ink; g.globalAlpha = 0.35; g.lineWidth = 1.5 * s;
  const ly = y0 + ph + h * 0.1;
  g.beginPath(); g.moveTo(side < 0.5 ? x0 : x0 + pw, ly); g.lineTo(side < 0.5 ? w * 0.9 : w * 0.1, ly); g.stroke();
  g.globalAlpha = 1;
  return cv;
}

const TECHNIQUE_FN = { impressionist, kandinsky, film, ma };

// ============================================================== плеер

let fontPromise = null;
export function ensureFonts() {
  if (!fontPromise) {
    const load = (spec) => Promise.race([document.fonts.load(spec, 'Абв Аб Abc 123'), new Promise((r) => setTimeout(r, 2500))]).catch(() => {});
    fontPromise = Promise.all([load('600 64px "Playfair Display"'), load('500 26px Inter'), load('800 22px Inter'), load('600 60px Caveat')]);
  }
  return fontPromise;
}

function wrap(g, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (g.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * data: { photos: HTMLImageElement[], title, dateText, metaText, dateStamp, sign, scale }
 * Возвращает управление воспроизведением. Для неподвижной картинки: opts.still = true.
 */
export async function createPlayer(canvas, memory, data, opts = {}) {
  await ensureFonts();
  const s = data.scale || 0.6;
  const W = Math.round(BASE_W * s), H = Math.round(BASE_H * s);
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');

  const M = Math.round(BASE_W * FRAME.margin * s);
  const win = { x: M, y: Math.round(H * FRAME.window.top), w: W - M * 2 };
  win.h = Math.round(H * (1 - FRAME.window.top - FRAME.window.bottom));

  const pal = memory.palette;
  const v = memory.vec;
  const rhythm = memory.rhythm;
  const photos = data.photos || [];
  const ctx = { pal, v, s, air: memory.air, contrast: memory.contrast, dateStamp: data.dateStamp };
  const bleed = memory.technique === 'collage' ? Math.round(30 * s) : 0;
  const pw = win.w + bleed * 2, ph = win.h + bleed * 2;

  // тарелки окна: по одной на кадр
  const plates = [];
  const count = Math.max(1, photos.length);
  for (let i = 0; i < count; i++) {
    const rand = rng(hashSeed(`${memory.seed}|${memory.variant}|${memory.technique}|${i}`));
    const img = photos[i] || null;
    const cv = memory.technique === 'collage' ? collage(photos, ctx, rand, pw, ph, i) : TECHNIQUE_FN[memory.technique](img, ctx, rand, pw, ph);
    plates.push({ cv, dx: (rand() - 0.5) * 2, dy: (rand() - 0.5) * 2 });
    if (!opts.still && i < count - 1) await new Promise((r) => requestAnimationFrame(r));
  }

  // зерно: один шумовой тайл, который сдвигается каждый кадр
  const noise = mk(256, 256);
  {
    const ng = noise.getContext('2d');
    const id = ng.createImageData(256, 256);
    const nr = rng(hashSeed(String(memory.seed) + 'grain'));
    for (let i = 0; i < id.data.length; i += 4) { const x = 90 + nr() * 110; id.data[i] = id.data[i + 1] = id.data[i + 2] = x; id.data[i + 3] = 255; }
    ng.putImageData(id, 0, 0);
  }
  const grainPattern = g.createPattern(noise, 'repeat');

  const fadeDur = clamp(rhythm.interval * 0.3, 0.7, 1.6);
  const bpmHz = rhythm.bpm / 60;

  // подписи заранее: перенос строк и размеры
  const titleSize = (() => {
    let size = Math.round(66 * s);
    const maxW = (W - M * 2) * 0.66;
    for (; size > 38 * s; size -= 2) {
      g.font = `600 ${size}px ${FRAME.fonts.title}`;
      if (wrap(g, data.title || '', maxW).length <= 2) break;
    }
    return size;
  })();
  g.font = `600 ${titleSize}px ${FRAME.fonts.title}`;
  const titleLines = wrap(g, data.title || '', (W - M * 2) * 0.66).slice(0, 2);
  const signSize = Math.round(62 * s);
  g.font = `600 ${signSize}px ${FRAME.fonts.hand}`;
  const signW = g.measureText(data.sign || '').width;

  function draw(t, still) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = pal.bg;
    g.fillRect(0, 0, W, H);

    // окно: появление, кадры, медленный наезд
    const intro = still ? 1 : ease(t / 1.1);
    const idx = still ? 0 : Math.floor(t / rhythm.interval) % plates.length;
    const phase = still ? rhythm.interval * 0.45 : t % rhythm.interval;
    const mix = still || plates.length < 2 ? 0 : smooth(rhythm.interval - fadeDur, rhythm.interval, phase);
    const drawPlate = (pl, alpha, local) => {
      const zoom = 1 + 0.07 * rhythm.motion * local;
      const cx = win.x + win.w / 2 + pl.dx * 14 * s * rhythm.motion * local;
      const cy = win.y + win.h / 2 + pl.dy * 10 * s * rhythm.motion * local;
      g.save();
      g.beginPath();
      g.rect(win.x, win.y + (win.h * (1 - intro)) / 2, win.w, win.h * intro);
      g.clip();
      g.globalAlpha = alpha * intro;
      g.translate(cx, cy);
      g.scale(zoom, zoom);
      g.drawImage(pl.cv, -pw / 2, -ph / 2);
      g.restore();
    };
    drawPlate(plates[idx], 1, phase / rhythm.interval);
    if (mix > 0) drawPlate(plates[(idx + 1) % plates.length], mix, 0);

    // пульс песни: лёгкая вспышка окна на сильную долю при высокой энергии
    const pulse = 0.5 + 0.5 * Math.cos(2 * Math.PI * bpmHz * t);
    if (!still && (memory.signals?.music?.energy ?? 0) > 0.55) {
      g.globalAlpha = 0.035 * pulse * v.arousal;
      g.fillStyle = pal.dark ? '#ffffff' : pal.accent2;
      g.fillRect(win.x, win.y, win.w, win.h);
      g.globalAlpha = 1;
    }

    // рамка окна
    g.strokeStyle = pal.ink;
    g.globalAlpha = 0.5 * intro;
    g.lineWidth = Math.max(1, s * 1.5);
    g.strokeRect(win.x - 0.5, win.y - 0.5, win.w + 1, win.h + 1);
    g.globalAlpha = 1;

    // дата и метка
    const textIn = still ? 1 : ease((t - 0.3) / 0.8);
    g.globalAlpha = textIn;
    g.fillStyle = pal.ink;
    g.textBaseline = 'alphabetic';
    g.font = `600 ${Math.round(25 * s)}px ${FRAME.fonts.ui}`;
    if ('letterSpacing' in g) g.letterSpacing = `${Math.round(2.2 * s)}px`;
    g.textAlign = 'left';
    g.fillText(String(data.dateText || '').toUpperCase(), M, M + Math.round(26 * s));
    g.font = `800 ${Math.round(22 * s)}px ${FRAME.fonts.ui}`;
    if ('letterSpacing' in g) g.letterSpacing = `${Math.round(4 * s)}px`;
    g.textAlign = 'right';
    g.fillText('NXTCORE', W - M, M + Math.round(25 * s));
    if ('letterSpacing' in g) g.letterSpacing = '0px';
    const nameW = g.measureText('NXTCORE').width + 14 * s * 7 * 0.4; // запас на разрядку
    g.fillStyle = pal.accent;
    g.beginPath();
    g.arc(W - M - nameW - 20 * s, M + Math.round(17 * s), 6.5 * s * (1 + (still ? 0 : 0.28 * pulse)), 0, Math.PI * 2);
    g.fill();

    // название: плавно проявляется
    const tIn = still ? 1 : ease((t - 1.2) / 1.0);
    g.globalAlpha = tIn;
    g.fillStyle = pal.ink;
    g.textAlign = 'left';
    g.font = `600 ${titleSize}px ${FRAME.fonts.title}`;
    const lh = titleSize * 1.12;
    const baseY = H - M - Math.round(76 * s) - (titleLines.length - 1) * lh;
    titleLines.forEach((line, i) => g.fillText(line, M, baseY + i * lh + (1 - tIn) * 14 * s));

    // строка про песню или погоду
    g.globalAlpha = tIn * 0.75;
    g.font = `500 ${Math.round(25 * s)}px ${FRAME.fonts.ui}`;
    g.fillText(data.metaText || '', M, H - M - Math.round(14 * s), W - M * 2 - signW - 20 * s);

    // подпись: рисуется слева направо
    const sp = still ? 1 : ease((t - 2.4) / 1.8);
    if (sp > 0 && data.sign) {
      g.save();
      g.globalAlpha = 1;
      g.font = `600 ${signSize}px ${FRAME.fonts.hand}`;
      g.fillStyle = pal.accent;
      g.textAlign = 'left';
      g.translate(W - M - signW, H - M - Math.round(34 * s));
      g.rotate(-0.055);
      g.beginPath();
      g.rect(-12 * s, -signSize * 1.1, (signW + 24 * s) * sp, signSize * 1.6);
      g.clip();
      g.fillText(data.sign, 0, 0);
      g.restore();
    }
    g.globalAlpha = 1;

    // зерно
    const grain = memory.grain;
    if (grain > 0.02 && grainPattern) {
      const f = still ? 3 : Math.floor(t * 12);
      g.save();
      g.globalCompositeOperation = pal.dark ? 'screen' : 'soft-light';
      g.globalAlpha = pal.dark ? grain * 0.12 : grain * 0.55;
      g.translate((f * 53) % 256, (f * 97) % 256);
      g.fillStyle = grainPattern;
      g.fillRect(-256, -256, W + 512, H + 512);
      g.restore();
    }
  }

  let raf = 0, playing = false, startedAt = 0, offset = 0;
  const frame = (now) => {
    if (!playing) return;
    draw(Math.max(0, offset + (now - startedAt) / 1000), false);
    raf = requestAnimationFrame(frame);
  };

  const api = {
    width: W, height: H,
    renderStill() { draw(STILL_TIME, true); },
    play() {
      if (playing) return;
      playing = true;
      startedAt = performance.now();
      raf = requestAnimationFrame(frame);
    },
    pause() {
      if (!playing) return;
      offset += (performance.now() - startedAt) / 1000;
      playing = false;
      cancelAnimationFrame(raf);
    },
    restart() { offset = 0; startedAt = performance.now(); if (!playing) api.play(); },
    get playing() { return playing; },
    destroy() { playing = false; cancelAnimationFrame(raf); },
  };
  api.renderStill();
  return api;
}

// Готовое «воспоминание» одной картинкой: оно сохраняется в папку дня и показывается в ленте
export async function renderCover(memory, data, quality = 0.86) {
  const c = document.createElement('canvas');
  const player = await createPlayer(c, memory, { ...data, scale: 1 }, { still: true });
  player.renderStill();
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return blob;
}
