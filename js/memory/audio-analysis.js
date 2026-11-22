// Анализ собственного аудиофайла прямо в браузере: темп, энергия, яркость, мажор/минор.
// Файл никуда не отправляется. analyzeSamples работает с обычным массивом чисел,
// поэтому проверяется в Node (tests/engine.test.mjs).

const KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

function correlation(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function detectBpm(onsets, frameRate) {
  const n = onsets.length;
  if (n < frameRate * 4) return null;
  const mean = onsets.reduce((s, v) => s + v, 0) / n;
  const x = onsets.map((v) => v - mean);
  const minLag = Math.floor((frameRate * 60) / 190), maxLag = Math.ceil((frameRate * 60) / 55);
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    score[lag] = s / (n - lag);
  }
  // удвоенный и учетверённый лаг подтверждают темп: суммируем гармоники
  let best = 0, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    let s = score[lag];
    if (lag * 2 <= maxLag + 1) s += 0.5 * score[lag * 2];
    if (bpm >= 70 && bpm <= 160) s *= 1.15; // самый частый диапазон
    if (s > bestScore) { bestScore = s; best = lag; }
  }
  if (!best) return null;
  // параболическая интерполяция пика даёт доли удара
  const a = score[best - 1] || 0, b = score[best], c = score[best + 1] || 0;
  const denom = a - 2 * b + c;
  const shift = denom ? (0.5 * (a - c)) / denom : 0;
  let bpm = (60 * frameRate) / (best + Math.max(-1, Math.min(1, shift)));
  while (bpm < 70) bpm *= 2;
  while (bpm > 170) bpm /= 2;
  return bpm;
}

export function analyzeSamples(samples, sampleRate) {
  const hop = 512;
  const frameRate = sampleRate / hop;
  const frames = Math.floor(samples.length / hop);
  if (frames < 8) return null;

  // огибающая громкости и приращение (onset strength)
  const env = new Float64Array(frames);
  let rmsSum = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = 0; i < hop; i++) { const v = samples[f * hop + i]; s += v * v; }
    env[f] = Math.sqrt(s / hop);
    rmsSum += env[f];
  }
  const onsets = new Float64Array(frames);
  for (let f = 1; f < frames; f++) onsets[f] = Math.max(0, Math.sqrt(env[f]) - Math.sqrt(env[f - 1]));

  const rms = rmsSum / frames;
  const energy = Math.min(1, Math.max(0, (Math.log10(rms + 1e-4) + 2.2) / 1.5)); // 0.006 → 0, 0.2 → 1

  // спектр: яркость и ноты. Берём каждый 6-й кадр, чтобы быстро
  const size = 2048;
  const chroma = new Float64Array(12);
  let centroidSum = 0, centroidN = 0;
  const win = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const step = Math.max(1, Math.floor((samples.length - size) / 80));
  for (let start = 0; start + size <= samples.length; start += step) {
    const re = new Float64Array(size), im = new Float64Array(size);
    let loud = 0;
    for (let i = 0; i < size; i++) { re[i] = samples[start + i] * win[i]; loud += Math.abs(re[i]); }
    if (loud / size < 1e-4) continue;
    fft(re, im);
    let num = 0, den = 0;
    for (let k = 1; k < size / 2; k++) {
      const freq = (k * sampleRate) / size;
      const mag = Math.hypot(re[k], im[k]);
      num += freq * mag; den += mag;
      if (freq >= 65 && freq <= 2000) {
        const midi = 69 + 12 * Math.log2(freq / 440);
        chroma[((Math.round(midi) % 12) + 12) % 12] += mag * mag;
      }
    }
    if (den > 0) { centroidSum += num / den; centroidN++; }
  }
  const brightness = centroidN ? Math.min(1, centroidSum / centroidN / (sampleRate / 4)) : 0.3;

  let mode = 'unknown', keyConfidence = 0;
  if (chroma.some((v) => v > 0)) {
    let bestMaj = -1, bestMin = -1;
    for (let k = 0; k < 12; k++) {
      const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + k) % 12]);
      bestMaj = Math.max(bestMaj, correlation(rot, KRUMHANSL_MAJOR));
      bestMin = Math.max(bestMin, correlation(rot, KRUMHANSL_MINOR));
    }
    keyConfidence = Math.abs(bestMaj - bestMin);
    if (keyConfidence > 0.02) mode = bestMaj > bestMin ? 'major' : 'minor';
  }

  const bpm = detectBpm(onsets, frameRate);
  // «светлота» звучания: мажор, яркий тембр и громкость поднимают оценку
  const valence = Math.min(1, Math.max(0, 0.45 + (mode === 'major' ? 0.18 : mode === 'minor' ? -0.18 : 0) + (brightness - 0.3) * 0.5 + (energy - 0.5) * 0.2));

  return {
    bpm: bpm ? Math.round(bpm) : null,
    energy: Number(energy.toFixed(3)),
    brightness: Number(brightness.toFixed(3)),
    mode,
    keyConfidence: Number(keyConfidence.toFixed(3)),
    valence: Number(valence.toFixed(3)),
  };
}

// Обёртка для браузера: декодируем файл, берём до 75 секунд из середины, сводим в моно 11 кГц
export async function analyzeAudioFile(file) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const sr = buf.sampleRate;
    const total = buf.length;
    const len = Math.min(total, Math.floor(75 * sr));
    const from = Math.max(0, Math.floor((total - len) / 2));
    const ch = buf.numberOfChannels;
    const factor = Math.max(1, Math.round(sr / 11025));
    const out = new Float32Array(Math.floor(len / factor));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) {
        const data = buf.getChannelData(c);
        for (let j = 0; j < factor; j++) s += data[from + i * factor + j] || 0;
      }
      out[i] = s / (ch * factor);
    }
    return { ...analyzeSamples(out, sr / factor), duration: Math.round(buf.duration) };
  } finally {
    ctx.close?.();
  }
}
