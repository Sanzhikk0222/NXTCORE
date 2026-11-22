// Общее состояние приложения и простая шина событий.
const listeners = new Map();
export const on = (ev, fn) => { (listeners.get(ev) || listeners.set(ev, new Set()).get(ev)).add(fn); return () => listeners.get(ev)?.delete(fn); };
export const emit = (ev, data) => listeners.get(ev)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

export const state = {
  session: null,
  profile: null,   // результат my_profile()
  unread: 0,
  lang: 'ru',
};

export const isAuthed = () => !!state.session && !!state.profile;
export const settings = () => state.profile?.settings || {};
