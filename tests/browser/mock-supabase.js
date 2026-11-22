// Подмена supabase-js для проверки интерфейса без настоящего проекта. Хранит всё в памяти страницы.
const W = window;
const uid = () => crypto.randomUUID();
const saved = (() => { try { return JSON.parse(sessionStorage.getItem('mock_db')); } catch { return null; } })();
const db = (W.__db ||= saved || {
  users: { 'me@test.kz': { id: 'u-me', password: 'password1', username: 'aian', display_name: 'Аян', bio: '', settings: {}, privacy_accepted_at: '2026-11-01', needs_setup: false, is_banned: false },
           'bad@test.kz': { id: 'u-bad', password: 'password1', username: 'badguy', display_name: 'Bad', settings: {}, privacy_accepted_at: '2026-11-01', is_banned: true, ban_reason: 'Спам и оскорбления', ban_until: null },
           'other@test.kz': { id: 'u-other', password: 'password1', username: 'dina', display_name: 'Дина', bio: 'Люблю дождь', settings: {}, privacy_accepted_at: '2026-11-01' } },
  posts: [], likes: [], files: {}, notifs: [], follows: [], calls: [], seedOther: !!W.__seedOther,
});
let session = (() => { try { return JSON.parse(sessionStorage.getItem('mock_session')); } catch { return null; } })();
const persist = () => { try { sessionStorage.setItem('mock_db', JSON.stringify(db)); sessionStorage.setItem('mock_session', JSON.stringify(session)); } catch { /* ничего */ } };
const listeners = new Set();
const me = () => Object.values(db.users).find((u) => u.id === session?.user.id);
const author = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, avatar_url: null });
const byId = (id) => Object.values(db.users).find((u) => u.id === id);
const postJson = (p) => ({ ...p, liked_by_me: db.likes.some((l) => l.post_id === p.id && l.user_id === session?.user.id), author: author(byId(p.user_id)) });

const RPC = {
  my_profile: () => { const u = me(); return u ? { ...u, id: u.id, strikes: u.strikes || 0, is_banned: !!u.is_banned } : null; },
  username_status: ({ p_username: n }) => /admin|support/.test(n) ? { available: false, allowed: false, code: 'reserved' } : Object.values(db.users).some((u) => u.username === n) ? { available: false, allowed: true, code: 'taken' } : { available: true, allowed: true },
  unread_count: () => db.notifs.filter((n) => !n.read && n.user_id === session?.user.id).length,
  get_feed: ({ p_exclude }) => db.posts.filter((p) => p.visibility === 'public' && p.user_id !== session.user.id && !p_exclude.includes(p.id)).map(postJson),
  get_archive: () => db.posts.filter((p) => p.user_id === session.user.id).map(postJson),
  get_user_posts: ({ p_username }) => db.posts.filter((p) => byId(p.user_id).username === p_username && (p.user_id === session.user.id || p.visibility === 'public')).map(postJson),
  get_post: ({ p_id }) => { const p = db.posts.find((x) => x.id === p_id); return p ? postJson(p) : null; },
  get_comments: ({ p_post }) => (db.comments || []).filter((c) => c.post_id === p_post),
  get_likers: () => [],
  get_profile: ({ p_username }) => { const u = Object.values(db.users).find((x) => x.username === p_username); if (!u) return null; const ps = db.posts.filter((p) => p.user_id === u.id); return { profile: { id: u.id, username: u.username, display_name: u.display_name, bio: u.bio, avatar_url: null, created_at: '2026-10-01T10:00:00Z' }, stats: { posts: ps.length, likes: ps.reduce((a, p) => a + p.likes_count, 0), followers: 0, following: 0 }, is_me: u.id === session.user.id, is_following: false }; },
  get_notifications: () => db.notifs.filter((n) => n.user_id === session.user.id),
  mark_notifications_read: () => { db.notifs.forEach((n) => (n.read = true)); return null; },
  search_users: ({ p_q }) => Object.values(db.users).filter((u) => u.username.includes(p_q.toLowerCase())).map((u) => ({ ...author(u), bio: u.bio })),
  search_posts: ({ p_q }) => db.posts.filter((p) => (p.text || '').toLowerCase().includes(p_q.toLowerCase())).map(postJson),
  update_profile: ({ p_settings, p_display_name, p_bio }) => { const u = me(); if (p_settings) u.settings = { ...u.settings, ...p_settings }; if (p_display_name != null) u.display_name = p_display_name; if (p_bio != null) u.bio = p_bio; return { ok: true, profile: RPC.my_profile() }; },
  accept_privacy: () => { me().privacy_accepted_at = 'now'; me().needs_setup = false; return { ok: true, profile: RPC.my_profile() }; },
  create_post: ({ p }) => {
    if (/казино/i.test(p.text)) return { ok: false, code: 'forbidden_text', violation: { strikes: 1, action: 'warning' } };
    const row = { ...p, user_id: session.user.id, likes_count: 0, comments_count: 0, is_hidden: false, created_at: new Date().toISOString(), edited_at: null };
    db.posts.unshift(row); return { ok: true, post: postJson(row) };
  },
  update_post: ({ p_id, p }) => { const i = db.posts.findIndex((x) => x.id === p_id); db.posts[i] = { ...db.posts[i], ...p, edited_at: new Date().toISOString() }; return { ok: true, post: postJson(db.posts[i]), removed_paths: [] }; },
  delete_post: ({ p_id }) => { db.posts = db.posts.filter((x) => x.id !== p_id); return { ok: true, paths: [] }; },
  create_comment: ({ p_post, p_text }) => { db.comments ||= []; const c = { id: uid(), post_id: p_post, text: p_text, created_at: new Date().toISOString(), author: author(me()) }; db.comments.push(c); return { ok: true, comment: c }; },
};

const ok = (data) => Promise.resolve({ data, error: null });
const chain = (table, op, row) => {
  const q = { eq() { return q; }, then(res) { db.calls.push([table, op, row]); if (op === 'insert' && table === 'likes') db.likes.push(row); return res({ data: null, error: null }); } };
  return q;
};

export function createClient() {
  return {
    auth: {
      getSession: () => ok({ session }),
      onAuthStateChange: (cb) => { listeners.add(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: async ({ email, password }) => {
        const u = db.users[email];
        if (!u || u.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
        session = { user: { id: u.id } }; persist(); listeners.forEach((l) => l('SIGNED_IN', session));
        return { data: { session }, error: null };
      },
      signUp: async ({ email, password, options }) => {
        if (db.users[email]) return { data: {}, error: { message: 'User already registered' } };
        db.users[email] = { id: uid(), password, username: options.data.username, display_name: options.data.display_name, settings: {}, privacy_accepted_at: 'now' };
        session = { user: { id: db.users[email].id } };
        return { data: { session }, error: null };
      },
      signOut: async () => { session = null; persist(); listeners.forEach((l) => l('SIGNED_OUT', null)); return { error: null }; },
      signInWithOAuth: async () => ({ error: null }),
      updateUser: async () => ({ error: null }),
    },
    rpc: async (name, args) => {
      db.calls.push(['rpc', name, args]); setTimeout(persist, 0);
      const f = RPC[name];
      if (!f) return { data: null, error: { message: 'no rpc ' + name } };
      try { return { data: f(args || {}), error: null }; } catch (e) { return { data: null, error: { message: String(e) } }; }
    },
    from: (table) => ({ insert: (row) => chain(table, 'insert', row), delete: () => chain(table, 'delete') }),
    storage: {
      from: (bucket) => ({
        createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: db.files[p] || null })), error: null }),
        remove: async () => ({ error: null }),
        list: async () => ({ data: [], error: null }),
        upload: async (path, file) => { db.files[path] = 'x'; return { error: null }; },
      }),
    },
    functions: {
      invoke: async (_, { body }) => {
        db.calls.push(['ai', body.action]); setTimeout(persist, 0);
        if (body.action === 'upload_images') {
          const files = body.items.map((it) => {
            const path = body.kind === 'avatar' ? `u-me/avatar-1.jpg` : `${session.user.id}/${body.post_id}/${it.name}.jpg`;
            db.files[path] = `data:${it.mime};base64,${it.data}`;
            return { name: it.name, path, url: db.files[path] };
          });
          return { data: { ok: true, files }, error: null };
        }
        if (body.action === 'describe_photos') return { data: { ok: true, description: 'Я иду по осеннему парку, листья под ногами, тёплый свет.', scene: 'парк', time_of_day: 'evening', season: 'autumn', weather: 'clear', tags: [] }, error: null };
        if (body.action === 'analyze_day') return { data: { ok: true, title: 'Осенний парк и тёплый вечер', valence: 0.5, arousal: 0.3, warmth: 0.8, nostalgia: 0.5, tension: 0.1, social: 0.2, time_of_day: 'evening', season: 'autumn', weather: 'clear', places: [], people: [], activities: [] }, error: null };
        if (body.action === 'suggest_music') return { data: { ok: true, songs: [{ artist: 'Bill Evans', title: 'Waltz for Debby', genre: 'jazz', year: 1961, why: 'мягко и неспешно' }] }, error: null };
        if (body.action === 'song_features') return { data: { ok: true, estimate: true, bpm: 90, energy: 0.3, valence: 0.5, mode: 'major', genre: 'jazz', year: 1961, confidence: 0.6 }, error: null };
        return { data: { ok: true }, error: null };
      },
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
  };
}
