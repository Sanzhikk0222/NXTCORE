// Единственное место с настройками. Сюда нужно вписать адрес проекта Supabase и публичный (anon) ключ.
// Anon-ключ предназначен для браузера: доступ ограничивают политики RLS из supabase/sql.
// Секретные ключи (service_role, Gemini) сюда не кладите никогда: они живут только в Supabase (Edge Function).
export const CONFIG = {
  SUPABASE_URL: 'https://bmneusjjyehnqampgmji.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_FOyNmha3hGj53LnizssGQA_BgF4oFYx',
  SUPPORT_EMAIL: 'nxtcoresup@mail.ru',
  SITE_NAME: 'NXTCORE',
};

export const isConfigured = () =>
  /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(CONFIG.SUPABASE_URL) &&
  !/YOUR-/i.test(CONFIG.SUPABASE_URL) &&
  CONFIG.SUPABASE_ANON_KEY.length > 20 &&
  !/YOUR-/i.test(CONFIG.SUPABASE_ANON_KEY);
