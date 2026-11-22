// Проверка Edge Function на подставных зависимостях: node --experimental-strip-types tests/edge.test.mjs
import assert from 'node:assert/strict';
import { handle, resetPausedForTests } from '../supabase/functions/ai/handlers.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1)]).toString('base64');

function mkDeps({ gemini, state = { exists: true, banned: false, muted: false }, allowed = true } = {}) {
  const calls = { rpc: [], upload: [], fetch: [] };
  return {
    calls,
    deps: {
      fetch: async (url, init) => {
        calls.fetch.push({ url, body: JSON.parse(init.body) });
        return gemini(url, init, calls.fetch.length);
      },
      env: (k) => ({ GEMINI_API_KEY: 'k', GEMINI_MODELS: 'm1,m2' })[k],
      rpc: async (name, args) => {
        calls.rpc.push([name, args]);
        if (name === 'nx_user_state') return { data: state };
        if (name === 'ai_rate_ok') return { data: allowed };
        if (name === 'register_violation_for') return { data: { strikes: 1, action: 'warning' } };
        return { data: null };
      },
      upload: async (bucket, path) => { calls.upload.push([bucket, path]); return { error: null }; },
      publicUrl: (b, p) => `https://x/${b}/${p}`,
      log: () => {},
      now: () => Date.now(),
    },
  };
}
const ok = (obj) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
const uid = '11111111-1111-4111-8111-111111111111';
const pid = '22222222-2222-4222-8222-222222222222';
const up = (items, kind = 'post') => ({ action: 'upload_images', kind, post_id: pid, items });

// 1. безопасные фото загружаются, пути правильные
{
  resetPausedForTests();
  const { deps, calls } = mkDeps({ gemini: () => ok({ results: [{ index: 0, safe: true }, { index: 1, safe: true }] }) });
  const r = await handle(deps, uid, up([{ name: '0', mime: 'image/jpeg', data: JPEG }, { name: 'memory', mime: 'image/jpeg', data: JPEG }]));
  assert.equal(r.json.ok, true);
  assert.deepEqual(calls.upload.map((u) => u[1]), [`${uid}/${pid}/0.jpg`, `${uid}/${pid}/memory.jpg`]);
  assert.equal(calls.fetch.length, 1, 'все фото одним запросом к Gemini');
}

// 2. небезопасное фото: ничего не загружаем, страйк записан
{
  resetPausedForTests();
  const { deps, calls } = mkDeps({ gemini: () => ok({ results: [{ index: 0, safe: true }, { index: 1, safe: false, reason: 'обнажённость' }] }) });
  const r = await handle(deps, uid, up([{ name: '0', mime: 'image/jpeg', data: JPEG }, { name: '1', mime: 'image/jpeg', data: JPEG }]));
  assert.equal(r.json.ok, false); assert.equal(r.json.code, 'unsafe'); assert.equal(r.json.reason, 'обнажённость');
  assert.equal(calls.upload.length, 0);
  assert.ok(calls.rpc.some(([n]) => n === 'register_violation_for'));
}

// 3. Gemini недоступен: фото не загружаем (fail closed)
{
  resetPausedForTests();
  const { deps, calls } = mkDeps({ gemini: () => new Response('{}', { status: 403 }) });
  const r = await handle(deps, uid, up([{ name: '0', mime: 'image/jpeg', data: JPEG }]));
  assert.equal(r.status, 503); assert.equal(r.json.code, 'moderation_unavailable'); assert.equal(calls.upload.length, 0);
}

// 4. 429 на первой модели: переходим на вторую
{
  resetPausedForTests();
  const { deps, calls } = mkDeps({
    gemini: (url) => url.includes('/m1:') ? new Response('{}', { status: 429, headers: { 'retry-after': '5' } })
      : ok({ results: [{ index: 0, safe: true }] }),
  });
  const r = await handle(deps, uid, up([{ name: '0', mime: 'image/jpeg', data: JPEG }]));
  assert.equal(r.json.ok, true);
  assert.ok(calls.fetch[1].url.includes('/m2:'), 'запасная модель');
}

// 5. подделанный файл и чужие параметры
{
  resetPausedForTests();
  const { deps } = mkDeps({ gemini: () => ok({}) });
  let r = await handle(deps, uid, up([{ name: '0', mime: 'image/jpeg', data: Buffer.from('not an image'.repeat(20)).toString('base64') }]));
  assert.equal(r.json.code, 'bad_image');
  r = await handle(deps, uid, { ...up([{ name: '../x', mime: 'image/jpeg', data: JPEG }]) });
  assert.equal(r.json.code, 'bad_request');
  r = await handle(deps, uid, { ...up([{ name: '0', mime: 'image/jpeg', data: JPEG }]), post_id: '../../etc' });
  assert.equal(r.json.code, 'bad_request');
  r = await handle(deps, uid, { action: 'nope' });
  assert.equal(r.json.code, 'bad_request');
}

// 6. забаненный, мут, лимиты
{
  resetPausedForTests();
  let r = await handle(mkDeps({ gemini: () => ok({}), state: { exists: true, banned: true } }).deps, uid, up([]));
  assert.equal(r.status, 403);
  r = await handle(mkDeps({ gemini: () => ok({}), state: { exists: true, muted: true } }).deps, uid, up([{ name: '0', mime: 'image/jpeg', data: JPEG }]));
  assert.equal(r.json.code, 'muted');
  r = await handle(mkDeps({ gemini: () => ok({}), allowed: false }).deps, uid, { action: 'analyze_day', text: 'привет' });
  assert.equal(r.status, 429);
}

// 7. аватар: публичная ссылка
{
  resetPausedForTests();
  const { deps } = mkDeps({ gemini: () => ok({ results: [{ index: 0, safe: true }] }) });
  const r = await handle(deps, uid, { action: 'upload_images', kind: 'avatar', items: [{ name: 'avatar', mime: 'image/jpeg', data: JPEG }] });
  assert.equal(r.json.ok, true);
  assert.match(r.json.files[0].url, /avatars\/11111111/);
}

// 8. анализ дня: название 3-7 слов, числа в пределах
{
  resetPausedForTests();
  const mk = (title) => mkDeps({ gemini: () => ok({ title, summary: 'тихо', valence: 5, arousal: -2, warmth: 'x', time_of_day: 'evening', season: 'autumn', places: ['парк'] }) }).deps;
  let r = await handle(mk('«Осенний парк и какао».'), uid, { action: 'analyze_day', text: 'парк, какао' });
  assert.equal(r.json.title, 'Осенний парк и какао');
  assert.equal(r.json.valence, 1); assert.equal(r.json.arousal, 0); assert.equal(r.json.warmth, 0.5);
  r = await handle(mk('Парк'), uid, { action: 'analyze_day', text: 'парк' });
  assert.equal(r.json.title, '', 'слишком короткое название отбрасывается');
}

// 9. описание по фото, подсказка песен, оценка песни
{
  resetPausedForTests();
  let r = await handle(mkDeps({ gemini: () => ok({ safe: true, description: 'Мы гуляли по парку.', season: 'autumn', time_of_day: 'x', tags: ['парк'] }) }).deps, uid,
    { action: 'describe_photos', lang: 'ru', images: [{ mime: 'image/jpeg', data: JPEG }] });
  assert.equal(r.json.description, 'Мы гуляли по парку.'); assert.equal(r.json.time_of_day, 'unknown');
  r = await handle(mkDeps({ gemini: () => ok({ safe: false }) }).deps, uid, { action: 'describe_photos', images: [{ mime: 'image/jpeg', data: JPEG }] });
  assert.equal(r.json.code, 'unsafe');
  r = await handle(mkDeps({ gemini: () => ok({ songs: [{ artist: 'A', title: 'B', year: 1966, why: 'x' }, { title: 'без артиста' }] }) }).deps, uid, { action: 'suggest_music', text: 'дождь' });
  assert.equal(r.json.songs.length, 1);
  r = await handle(mkDeps({ gemini: () => ok({ bpm: 900, energy: 0.2, mode: 'minor', confidence: 0.8 }) }).deps, uid, { action: 'song_features', title: 'x', artist: 'y' });
  assert.equal(r.json.bpm, 200); assert.equal(r.json.estimate, true);
}

// 10. judge_text: «справка» выдаётся только если не спам
{
  resetPausedForTests();
  let m = mkDeps({ gemini: () => ok({ spam: false, reason: 'обычная запись' }) });
  await handle(m.deps, uid, { action: 'judge_text', text: ' купил хлеб ' });
  assert.ok(m.calls.rpc.some(([n, a]) => n === 'grant_text_clearance' && a.p_text === 'купил хлеб'));
  m = mkDeps({ gemini: () => ok({ spam: true }) });
  await handle(m.deps, uid, { action: 'judge_text', text: 'купи тут' });
  assert.ok(!m.calls.rpc.some(([n]) => n === 'grant_text_clearance'));
}

// 11. ключ не задан
{
  resetPausedForTests();
  const m = mkDeps({ gemini: () => ok({}) });
  m.deps.env = () => undefined;
  const r = await handle(m.deps, uid, { action: 'analyze_day', text: 'привет' });
  assert.equal(r.status, 503);
}

console.log('Edge Function: всё прошло');
