import { sb } from './supabase.js';
import { state, emit } from './state.js';
import { setLang, detectLang } from '../i18n/index.js';

export const BAN_KEY = 'nx_ban';

export function applyTheme(pref) {
  const p = ['light', 'dark', 'system'].includes(pref) ? pref : 'system';
  try { localStorage.setItem('nx_theme', p); } catch { /* ничего */ }
  const dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#131a26' : '#faf7f2');
  emit('theme', p);
}
export const themePref = () => { try { return localStorage.getItem('nx_theme') || 'system'; } catch { return 'system'; } };

export function applySettings(s = {}) {
  if (s.lang) setLang(s.lang);
  if (s.theme) applyTheme(s.theme);
  document.documentElement.dataset.reduce = s.reduce_motion ? '1' : '0';
}

export async function loadProfile() {
  if (!sb) return null;
  const { data, error } = await sb.rpc('my_profile');
  if (error) { console.warn('my_profile', error.message); return null; }
  state.profile = data;
  if (data) applySettings(data.settings);
  emit('profile', data);
  return data;
}

// Запоминаем причину блокировки, чтобы показать её на /banned даже после выхода из аккаунта
export async function enforceBan(profile) {
  if (!profile?.is_banned) return false;
  try { sessionStorage.setItem(BAN_KEY, JSON.stringify({ reason: profile.ban_reason || '', until: profile.ban_until || null })); } catch { /* ничего */ }
  await sb.auth.signOut().catch(() => {});
  state.session = null;
  state.profile = null;
  emit('profile', null);
  return true;
}

export async function signOut() {
  await sb?.auth.signOut().catch(() => {});
  state.session = null;
  state.profile = null;
  state.unread = 0;
  emit('profile', null);
}

export function initLangFromEnv() { setLang(detectLang()); }
