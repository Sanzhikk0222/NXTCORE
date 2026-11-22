// Озвучка записи: синтезированный голос браузера (Web Speech API), без записи реальных людей.
// Профиль голоса (темп и высота) выбирает движок по настроению дня, а конкретный голос из тех,
// что есть на устройстве, выбирается по правилу: один и тот же профиль всегда даёт один и тот же голос.

import { hashSeed } from './engine.js';

export const voiceSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

function loadVoices() {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const now = synth.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 800);
  });
}

const LANG_CODE = { ru: 'ru', kk: 'kk', en: 'en' };

export async function pickVoice(profile, lang) {
  if (!voiceSupported()) return null;
  const voices = await loadVoices();
  const want = LANG_CODE[lang] || 'ru';
  let pool = voices.filter((v) => v.lang.toLowerCase().startsWith(want));
  if (!pool.length && want === 'kk') pool = voices.filter((v) => v.lang.toLowerCase().startsWith('ru'));
  if (!pool.length) pool = voices.filter((v) => v.default);
  if (!pool.length) return null;
  pool.sort((a, b) => Number(b.localService) - Number(a.localService) || a.name.localeCompare(b.name));
  return pool[hashSeed(profile.key) % pool.length];
}

let current = null;

export function stopVoice() {
  if (voiceSupported()) window.speechSynthesis.cancel();
  current = null;
}

export async function speak(text, profile, lang, { onEnd } = {}) {
  if (!voiceSupported() || !text) return false;
  stopVoice();
  const voice = await pickVoice(profile, lang);
  // длинный текст режем по предложениям: так браузеры не обрываются на середине
  const chunks = String(text).match(/[^.!?\n]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang === 'kk' ? 'ru-RU' : lang;
    u.rate = profile.rate;
    u.pitch = profile.pitch;
    if (i === chunks.length - 1) u.onend = () => { current = null; onEnd?.(); };
    window.speechSynthesis.speak(u);
  });
  current = text;
  return true;
}

export const isSpeaking = () => voiceSupported() && (window.speechSynthesis.speaking || current != null);
