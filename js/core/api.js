// Обёртки над RPC и Edge Function. Все записи идут через функции базы: там модерация, баны и лимиты.
import { sb } from './supabase.js';
import { state, emit } from './state.js';
import { toast } from './ui.js';
import { t, getLang } from '../i18n/index.js';
import { fmtDateTime } from './ui.js';
import { BAN_KEY, loadProfile, enforceBan } from './auth.js';

export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) {
    const e = new Error(error.message || 'rpc');
    e.code = error.code;
    throw e;
  }
  return data;
}

export async function callAi(action, body = {}) {
  const { data, error } = await sb.functions.invoke('ai', { body: { action, lang: getLang(), ...body } });
  if (!error) return data;
  let payload = null;
  try { payload = await error.context?.json?.(); } catch { /* тело не JSON */ }
  return payload && typeof payload === 'object' ? payload : { ok: false, code: 'network' };
}

// Разбор ответа вида {ok:false, code, violation?}. Возвращает true, если была ошибка.
export async function handleFail(res, { navigate } = {}) {
  if (res && res.ok !== false) return false;
  const code = res?.code || 'generic';

  if (res?.violation) await showViolation(res.violation, navigate);

  switch (code) {
    case 'forbidden_text':
      toast(t('err.forbidden_text'), 'error');
      break;
    case 'unsafe':
      toast(t('err.unsafe', { reason: res.reason || t('err.unsafe_default') }), 'error');
      break;
    case 'banned': {
      try { sessionStorage.setItem(BAN_KEY, JSON.stringify({ reason: res.reason || '', until: res.until || null })); } catch { /* ничего */ }
      await loadProfile().then(enforceBan);
      navigate?.('/banned', { replace: true });
      break;
    }
    case 'muted':
      toast(t('err.muted', { time: res.until ? fmtDateTime(res.until) : '' }), 'error');
      break;
    case 'privacy_required':
      navigate?.('/setup', { replace: true });
      break;
    case 'auth':
      toast(t('err.auth'), 'error');
      navigate?.('/login', { replace: true });
      break;
    default:
      toast(t(`err.${code}`) === `err.${code}` ? t('err.generic') : t(`err.${code}`), 'error');
  }
  return true;
}

export async function showViolation(v, navigate) {
  if (!v || !v.action || v.action === 'none') return;
  await loadProfile();
  if (v.action === 'warning') toast(t('strike.warning_text'), 'error', { title: t('strike.warning', { n: v.strikes }), ms: 8000 });
  else if (v.action === 'mute') toast(t('strike.mute_text'), 'error', { title: t('strike.mute', { n: v.strikes }), ms: 9000 });
  else if (v.action === 'ban') {
    emit('banned', null);
    navigate?.('/banned', { replace: true });
  }
}

// ---------- файлы
const signedCache = new Map();
export async function signedUrls(bucket, paths) {
  const need = [...new Set(paths.filter(Boolean))].filter((p) => {
    const c = signedCache.get(bucket + p);
    return !c || c.exp < Date.now() + 60_000;
  });
  if (need.length) {
    const { data } = await sb.storage.from(bucket).createSignedUrls(need, 3600);
    for (const row of data || []) if (row.signedUrl) signedCache.set(bucket + row.path, { url: row.signedUrl, exp: Date.now() + 3600_000 });
  }
  return Object.fromEntries(paths.filter(Boolean).map((p) => [p, signedCache.get(bucket + p)?.url || null]));
}

export async function removeFiles(bucket, paths) {
  const list = [...new Set((paths || []).filter(Boolean))];
  if (list.length) await sb.storage.from(bucket).remove(list).catch(() => {});
}

export function forgetSigned(bucket, paths) {
  for (const p of paths || []) signedCache.delete(bucket + p);
}
