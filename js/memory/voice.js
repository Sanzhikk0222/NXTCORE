// Озвучка записи: синтезированный голос браузера (Web Speech API), без записи реальных людей.
// Берётся самый естественный голос из установленных на устройстве, читает спокойно и с паузами.

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

// Чем естественнее голос, тем выше оценка. Нейросетевые голоса (Microsoft «Natural», Google, Apple Siri/Enhanced)
// звучат почти как живой человек, обычные системные голоса заметно роботизированы.
function voiceScore(v) {
  const n = v.name.toLowerCase();
  let sc = 0;
  if (/natural/.test(n)) sc += 100;
  if (/online|neural/.test(n)) sc += 60;
  if (/premium|enhanced|siri|studio|wavenet/.test(n)) sc += 50;
  if (/google/.test(n)) sc += 40;
  if (/svetlana|dmitry|dariya|aigul|daulet|milena|yuri|katya|alena|irina|pavel|yandex/.test(n)) sc += 25;
  if (/compact|espeak|robot/.test(n)) sc -= 80;
  if (!v.localService) sc += 5;
  return sc;
}

export async function pickVoice(profile, lang) {
  if (!voiceSupported()) return null;
  const voices = await loadVoices();
  const want = LANG_CODE[lang] || 'ru';
  let pool = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(want));
  if (!pool.length && want === 'kk') pool = voices.filter((v) => v.lang.toLowerCase().startsWith('ru'));
  if (!pool.length) pool = voices.filter((v) => v.default);
  if (!pool.length) return null;
  pool.sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
  return pool[0]; // всегда самый естественный из доступных
}

let current = null;
let token = 0;

export function stopVoice() {
  token++;
  if (voiceSupported()) window.speechSynthesis.cancel();
  current = null;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Читаем спокойно: чуть медленнее обычного, обычная высота, между предложениями короткие паузы.
export async function speak(text, profile, lang, { onEnd, onStart } = {}) {
  if (!voiceSupported() || !text) return false;
  stopVoice();
  const my = token;
  const voice = await pickVoice(profile, lang);
  if (my !== token) return false;
  const chunks = String(text).replace(/\s+/g, ' ').match(/[^.!?…\n]+[.!?…]*/g)?.map((x) => x.trim()).filter(Boolean) || [text];
  const rate = 0.9 + Math.max(-0.04, Math.min(0.04, (profile.rate - 0.95) * 0.3)); // 0.86–0.94: спокойный темп
  current = text;
  onStart?.();
  (async () => {
    for (let i = 0; i < chunks.length; i++) {
      if (my !== token) return;
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(chunks[i]);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang === 'kk' ? 'ru-RU' : lang;
        u.rate = rate;
        u.pitch = 1;
        u.volume = 1;
        u.onend = resolve;
        u.onerror = resolve;
        window.speechSynthesis.speak(u);
      });
      if (my !== token) return;
      await pause(/[.!?…]$/.test(chunks[i]) ? 380 : 200);
    }
    if (my === token) { current = null; onEnd?.(); }
  })();
  return true;
}

export const isSpeaking = () => voiceSupported() && current != null;
