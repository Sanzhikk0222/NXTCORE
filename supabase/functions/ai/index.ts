// Edge Function `ai`: Gemini для NXTCORE. Ключ GEMINI_API_KEY живёт только здесь.
// Деплой: supabase functions deploy ai
// Ключ:   supabase secrets set GEMINI_API_KEY=...
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle, type Deps } from './handlers.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

function serviceKey(): string {
  const direct = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    return keys.default ?? Object.values(keys)[0] as string;
  } catch {
    return '';
  }
}

const admin = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false } });

// Укажите адрес сайта в ALLOWED_ORIGIN (например https://nxtcore.vercel.app), иначе будет *
const origin = Deno.env.get('ALLOWED_ORIGIN') || '*';
const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const deps: Deps = {
  fetch,
  env: (k) => Deno.env.get(k),
  rpc: async (name, args) => {
    const { data, error } = await admin.rpc(name, args);
    return { data, error };
  },
  upload: async (bucket, path, bytes, contentType) => {
    const { error } = await admin.storage.from(bucket).upload(path, bytes, { contentType, upsert: true });
    return { error };
  },
  publicUrl: (bucket, path) => admin.storage.from(bucket).getPublicUrl(path).data.publicUrl,
  log: (...a) => console.log('[ai]', ...a),
  now: () => Date.now(),
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { ok: false, code: 'bad_request' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { ok: false, code: 'auth' });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json(401, { ok: false, code: 'auth' });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, code: 'bad_request' });
  }

  try {
    const res = await handle(deps, data.user.id, body);
    return json(res.status, res.json);
  } catch (e) {
    console.error('[ai] unhandled', e instanceof Error ? e.message : e);
    return json(500, { ok: false, code: 'server_error' });
  }
});
