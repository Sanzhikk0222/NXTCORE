// Цвет в OKLab/OKLCH: палитра дня считается в перцептивном пространстве,
// поэтому «светлее» и «насыщеннее» ведут себя предсказуемо.

const clamp01 = (x) => Math.min(1, Math.max(0, x));

const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklab(r, g, b) {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function rgbToOklch(r, g, b) {
  const { L, a, b: bb } = rgbToOklab(r, g, b);
  const C = Math.hypot(a, bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

// OKLCH → [r,g,b] 0..255, при выходе за гамму уменьшаем насыщенность
export function oklchToRgb(L, C, h) {
  L = clamp01(L);
  const rad = (h * Math.PI) / 180;
  let c = Math.max(0, C);
  let lin = oklabToLinear(L, c * Math.cos(rad), c * Math.sin(rad));
  for (let i = 0; i < 24 && !inGamut(lin); i++) {
    c *= 0.93;
    lin = oklabToLinear(L, c * Math.cos(rad), c * Math.sin(rad));
  }
  return lin.map((v) => Math.round(Math.min(255, Math.max(0, fromLinear(clamp01(v))))));
}

export const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const oklchHex = (L, C, h) => rgbToHex(oklchToRgb(L, C, h));
export const hexToOklch = (hex) => rgbToOklch(...hexToRgb(hex));

export function luminance([r, g, b]) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(hexA, hexB) {
  const a = luminance(hexToRgb(hexA)), b = luminance(hexToRgb(hexB));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// Подвигаем светлоту текста, пока контраст с фоном не станет достаточным
export function ensureContrast(fgHex, bgHex, min = 4.5) {
  if (contrast(fgHex, bgHex) >= min) return fgHex;
  const fg = hexToOklch(fgHex);
  const bgL = hexToOklch(bgHex).L;
  const dir = bgL > 0.55 ? -1 : 1;
  let L = fg.L;
  for (let i = 0; i < 60; i++) {
    L = clamp01(L + dir * 0.015);
    const hex = oklchHex(L, fg.C, fg.h);
    if (contrast(hex, bgHex) >= min) return hex;
  }
  return dir < 0 ? '#000000' : '#ffffff';
}

// Среднее по кругу: оттенки 350° и 10° дают 0°, а не 180°
export function mixHue(h1, h2, t) {
  let d = ((h2 - h1 + 540) % 360) - 180;
  return (h1 + d * t + 360) % 360;
}

export const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
