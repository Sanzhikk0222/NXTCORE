-- NXTCORE: полная схема базы (собрано scripts/build-sql.sh). Выполняйте один раз на чистом проекте.

-- ===== 01_schema.sql =====
-- ============================================================================
-- NXTCORE · 01 · Схема: таблицы, индексы, нормализация текста
-- Запускать в Supabase → SQL Editor целиком (или по порядку 01 → 07).
-- Скрипт можно запускать повторно: везде create ... if not exists / or replace.
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

-- ----------------------------------------------------------------------------
-- Нормализация текста для проверки на запрещённые слова.
-- Одни и те же шаги реализованы в js/moderation/text.js, поэтому клиент и база
-- считают одинаково (это проверяется тестом tests/parity.mjs).
--   1. нижний регистр
--   2. казахские буквы приводятся к русским (ә→а, қ→к ...), й→и, ь убирается
--   3. цифры-«хакерские» заменяются: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s
--   4. латинские двойники превращаются в кириллические (a→а, x→х, p→р ...)
--   5. повторы букв схлопываются: «хуууй» → «хуй»
-- ----------------------------------------------------------------------------
create or replace function public.nx_norm(t text)
returns text
language sql
immutable
parallel safe
as $$
  select regexp_replace(
    translate(
      translate(
        translate(
          lower(coalesce(t, '')),
          U&'\0451\0439\04D9\0493\049B\04A3\04E9\04B1\04AF\04BB\0456\044C',
          U&'\0435\0438\0430\0433\043A\043D\043E\0443\0443\0445\0438'
        ),
        '0134@5$7',
        'oieaasst'
      ),
      'abcehkmoptxyi',
      U&'\0430\0432\0441\0435\043D\043A\043C\043E\0440\0442\0445\0443\0438'
    ),
    '(.)\1+', '\1', 'g'
  )
$$;

-- Слова текста после нормализации (разделители — всё, кроме букв и цифр).
create or replace function public.nx_tokens(t text)
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(
    array_remove(regexp_split_to_array(public.nx_norm(t), E'[^a-zа-я0-9]+'), ''),
    '{}'::text[]
  )
$$;

-- Строка без разделителей: для проверки ников («a.d.m.i.n» → «admin»).
create or replace function public.nx_squash(t text)
returns text
language sql
immutable
parallel safe
as $$
  select regexp_replace(
    regexp_replace(public.nx_norm(t), E'[^a-zа-я0-9]+', '', 'g'),
    '(.)\1+', '\1', 'g'
  )
$$;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  username            text not null,
  display_name        text not null default '',
  bio                 text not null default '',
  avatar_url          text,
  is_banned           boolean not null default false,
  ban_reason          text,
  ban_until           timestamptz,                -- null при is_banned = навсегда
  strikes             int not null default 0,
  muted_until         timestamptz,                -- мут: нельзя публиковать и комментировать
  privacy_accepted_at timestamptz,
  needs_setup         boolean not null default false,  -- вошёл через Google, ник ещё не выбран
  settings            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  constraint profiles_username_key unique (username),
  constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (char_length(display_name) <= 40),
  constraint profiles_bio_len check (char_length(bio) <= 150),
  constraint profiles_settings_size check (octet_length(settings::text) <= 2000)
);

create index if not exists profiles_username_trgm on public.profiles using gin (username extensions.gin_trgm_ops);
create index if not exists profiles_display_trgm  on public.profiles using gin (display_name extensions.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- posts: одна запись = один день
-- ----------------------------------------------------------------------------
create table if not exists public.posts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  title           text,                                   -- название «папки дня», 3–7 слов
  text            text not null default '',
  photos          jsonb not null default '[]'::jsonb,     -- [{path, w, h}]
  cover_path      text,                                   -- готовое воспоминание (картинка)
  mood            text,
  visibility      text not null default 'private',
  day_date        date not null default current_date,
  memory          jsonb not null default '{}'::jsonb,     -- параметры визуальной системы
  music           jsonb,
  voice           jsonb,
  weather         jsonb,
  ai              jsonb,
  is_hidden       boolean not null default false,         -- скрыт после 3 жалоб
  likes_count     int not null default 0,
  comments_count  int not null default 0,
  edited_at       timestamptz,
  created_at      timestamptz not null default now(),
  constraint posts_text_len     check (char_length(text) <= 1000),
  constraint posts_title_len    check (title is null or char_length(title) <= 80),
  constraint posts_photos_array check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 6),
  constraint posts_mood_values  check (mood is null or mood in ('warm', 'cold', 'energetic')),
  constraint posts_visibility   check (visibility in ('public', 'private')),
  constraint posts_not_empty    check (char_length(text) > 0 or jsonb_array_length(photos) > 0),
  constraint posts_json_size    check (
    octet_length(memory::text) <= 20000
    and coalesce(octet_length(music::text), 0) <= 4000
    and coalesce(octet_length(voice::text), 0) <= 1000
    and coalesce(octet_length(weather::text), 0) <= 1000
    and coalesce(octet_length(ai::text), 0) <= 8000
  )
);

create index if not exists posts_user_created   on public.posts (user_id, created_at desc);
create index if not exists posts_user_day       on public.posts (user_id, day_date desc, created_at desc);
create index if not exists posts_public_created on public.posts (created_at desc) where visibility = 'public' and not is_hidden;
create index if not exists posts_text_trgm      on public.posts using gin (text extensions.gin_trgm_ops);
create index if not exists posts_title_trgm     on public.posts using gin (title extensions.gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- likes, comments, follows
-- ----------------------------------------------------------------------------
create table if not exists public.likes (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
create index if not exists likes_post_created on public.likes (post_id, created_at desc);

create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  text       text not null,
  created_at timestamptz not null default now(),
  constraint comments_text_len check (char_length(text) between 1 and 300)
);
create index if not exists comments_post_created on public.comments (post_id, created_at);

create table if not exists public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  followee_id uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint follows_not_self check (follower_id <> followee_id)
);
create index if not exists follows_followee on public.follows (followee_id);

-- ----------------------------------------------------------------------------
-- notifications, reports
-- ----------------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,  -- кому
  actor_id   uuid not null references public.profiles (id) on delete cascade,  -- от кого
  type       text not null,
  post_id    uuid references public.posts (id) on delete cascade,
  comment_id uuid references public.comments (id) on delete cascade,
  read       boolean not null default false,
  created_at timestamptz not null default now(),
  constraint notifications_type check (type in ('like', 'comment', 'follow'))
);
create index if not exists notifications_user_created on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread on public.notifications (user_id) where not read;
create unique index if not exists notifications_like_once
  on public.notifications (user_id, actor_id, post_id) where type = 'like';
create unique index if not exists notifications_follow_once
  on public.notifications (user_id, actor_id) where type = 'follow';

create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_type text not null,
  target_id   uuid not null,
  reason      text not null,
  details     text,
  created_at  timestamptz not null default now(),
  constraint reports_target_type check (target_type in ('post', 'user')),
  constraint reports_reason check (reason in ('spam', 'insult', 'nsfw', 'other')),
  constraint reports_details_len check (details is null or char_length(details) <= 500),
  constraint reports_once unique (reporter_id, target_type, target_id)
);
create index if not exists reports_target on public.reports (target_type, target_id);

-- ----------------------------------------------------------------------------
-- Справочник запрещённых слов и служебные таблицы модерации
-- ----------------------------------------------------------------------------
create table if not exists public.banned_words (
  id         bigint generated always as identity primary key,
  word       text not null,
  language   text not null,            -- ru | kk | en
  category   text not null default 'profanity',  -- profanity | insult | slur | spam | reserved
  severity   text not null default 'block',      -- block: сразу блок; soft: подозрение на спам
  match_type text not null default 'token',      -- token: слово целиком; prefix: начало слова; substr: внутри слова
  word_norm  text generated always as (public.nx_norm(word)) stored,
  constraint banned_words_language check (language in ('ru', 'kk', 'en')),
  constraint banned_words_category check (category in ('profanity', 'insult', 'slur', 'spam', 'reserved')),
  constraint banned_words_severity check (severity in ('block', 'soft')),
  constraint banned_words_match check (match_type in ('token', 'prefix', 'substr')),
  constraint banned_words_unique unique (word, language)
);

-- журнал нарушений (видят только админы через service role)
create table if not exists public.violations (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null,            -- text | image | comment | profile
  reason     text,
  strike_no  int not null,
  action     text not null,            -- warning | mute | ban
  created_at timestamptz not null default now()
);
create index if not exists violations_user on public.violations (user_id, created_at desc);

-- «справка» от ИИ: текст со спорным словом признан нормальным
create table if not exists public.text_clearances (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  text_hash  bytea not null,
  expires_at timestamptz not null default now() + interval '15 minutes',
  primary key (user_id, text_hash)
);

-- счётчик вызовов ИИ для лимитов
create table if not exists public.ai_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  action     text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_time on public.ai_usage (user_id, created_at desc);

-- ===== 02_moderation.sql =====
-- ============================================================================
-- NXTCORE · 02 · Модерация: проверка текста и ников, страйки, баны
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Хелперы статуса пользователя
-- ----------------------------------------------------------------------------
create or replace function public.user_is_banned(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select pr.is_banned and (pr.ban_until is null or pr.ban_until > now())
    from public.profiles pr where pr.id = p_user
  ), false)
$$;

create or replace function public.user_is_muted(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select pr.muted_until is not null and pr.muted_until > now()
    from public.profiles pr where pr.id = p_user
  ), false)
$$;

-- ----------------------------------------------------------------------------
-- Проверка текста (посты, комментарии, био, имя).
--   ok = false, code = 'forbidden' — найден запрещённый корень/слово (блок + страйк)
--   ok = false, code = 'spam'      — спам-паттерн (блок без страйка, ИИ может снять)
-- Проверка идёт по словам, а не по всей строке: «корабля» не срабатывает на «бля».
-- ----------------------------------------------------------------------------
create or replace function public.moderate_text(p_text text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tokens text[] := public.nx_tokens(p_text);
  v_hits   text[];
  v_soft   int;
  v_lower  text := lower(coalesce(p_text, ''));
  v_link   boolean;
begin
  if array_length(v_tokens, 1) is null then
    return jsonb_build_object('ok', true);
  end if;

  select coalesce(array_agg(distinct w.word), '{}') into v_hits
  from public.banned_words w
  where w.severity = 'block'
    and w.category <> 'reserved'
    and exists (
      select 1 from unnest(v_tokens) t
      where (w.match_type = 'token'  and t = w.word_norm)
         or (w.match_type = 'prefix' and left(t, char_length(w.word_norm)) = w.word_norm)
         or (w.match_type = 'substr' and position(w.word_norm in t) > 0)
    );

  if array_length(v_hits, 1) is not null then
    return jsonb_build_object('ok', false, 'code', 'forbidden', 'words', to_jsonb(v_hits));
  end if;

  select count(distinct w.id) into v_soft
  from public.banned_words w
  where w.severity = 'soft'
    and exists (
      select 1 from unnest(v_tokens) t
      where (w.match_type = 'token'  and t = w.word_norm)
         or (w.match_type = 'prefix' and left(t, char_length(w.word_norm)) = w.word_norm)
         or (w.match_type = 'substr' and position(w.word_norm in t) > 0)
    );

  v_link := v_lower ~ '(https?://|www\.|t\.me/|wa\.me/)'
         or v_lower ~ '\+?\d[\d\s\-()]{8,}\d';

  -- спам: два и больше «рекламных» слова, либо рекламное слово рядом со ссылкой или телефоном
  if v_soft >= 2 or (v_soft >= 1 and v_link) then
    return jsonb_build_object('ok', false, 'code', 'spam');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- Проверка ника: формат, запрещённые и зарезервированные слова.
-- Возвращает {ok, code}: format | forbidden | reserved
-- ----------------------------------------------------------------------------
create or replace function public.moderate_username(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name   text := lower(coalesce(p_username, ''));
  v_tokens text[];
  v_squash text;
  v_code   text;
begin
  if v_name !~ '^[a-z0-9_]{3,20}$' or v_name !~ '[a-z]' then
    return jsonb_build_object('ok', false, 'code', 'format');
  end if;

  v_tokens := public.nx_tokens(v_name);
  v_squash := public.nx_squash(v_name);

  select case when w.category = 'reserved' then 'reserved' else 'forbidden' end into v_code
  from public.banned_words w
  where w.severity = 'block'
    and (
         (w.category = 'reserved' and (position(w.word_norm in v_squash) > 0))
      or (w.category <> 'reserved' and (
            (w.match_type = 'token'  and w.word_norm = any (v_tokens))
         or (w.match_type = 'prefix' and exists (select 1 from unnest(v_tokens) t where left(t, char_length(w.word_norm)) = w.word_norm))
         or (w.match_type = 'substr' and position(w.word_norm in v_squash) > 0)
      ))
    )
  order by (w.category = 'reserved') desc
  limit 1;

  if v_code is not null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Имя и био: те же правила, что для текста, плюс зарезервированные слова в имени.
create or replace function public.moderate_display_name(p_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_res    jsonb := public.moderate_text(p_name);
  v_squash text  := public.nx_squash(p_name);
begin
  if not (v_res ->> 'ok')::boolean and v_res ->> 'code' = 'forbidden' then
    return v_res;
  end if;
  if exists (
    select 1 from public.banned_words w
    where w.category = 'reserved' and position(w.word_norm in v_squash) > 0
  ) then
    return jsonb_build_object('ok', false, 'code', 'reserved');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- Страйки.
--   1-е нарушение: страйк +1, предупреждение
--   2-е нарушение: страйк +1, мут на 24 часа
--   3-е нарушение: автобан (навсегда), все сессии закрываются
-- Внутренняя функция: клиентам не выдаётся (см. 03_rls.sql).
-- ----------------------------------------------------------------------------
create or replace function public.apply_violation(p_user uuid, p_kind text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_strikes int;
  v_action  text;
  v_muted   timestamptz;
begin
  update public.profiles
     set strikes = strikes + 1
   where id = p_user
   returning strikes into v_strikes;

  if v_strikes is null then
    return jsonb_build_object('strikes', 0, 'action', 'none');
  end if;

  if v_strikes >= 3 then
    v_action := 'ban';
    update public.profiles
       set is_banned = true,
           ban_reason = 'Повторные нарушения правил сообщества',
           ban_until = null
     where id = p_user;
    -- закрываем все сессии: refresh-токен перестаёт работать
    begin
      delete from auth.sessions where user_id = p_user;
    exception when others then
      null;
    end;
  elsif v_strikes = 2 then
    v_action := 'mute';
    v_muted := now() + interval '24 hours';
    update public.profiles set muted_until = v_muted where id = p_user;
  else
    v_action := 'warning';
  end if;

  insert into public.violations (user_id, kind, reason, strike_no, action)
  values (p_user, p_kind, left(coalesce(p_reason, ''), 300), v_strikes, v_action);

  return jsonb_build_object(
    'strikes', v_strikes,
    'action', v_action,
    'muted_until', v_muted
  );
end;
$$;

-- Вызывается только из Edge Function (service role): фото не прошло проверку.
create or replace function public.register_violation_for(p_user uuid, p_kind text, p_reason text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.apply_violation(p_user, p_kind, p_reason)
$$;

-- Состояние пользователя для Edge Function.
create or replace function public.nx_user_state(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'exists', exists (select 1 from public.profiles where id = p_user),
    'banned', public.user_is_banned(p_user),
    'muted',  public.user_is_muted(p_user)
  )
$$;

-- Лимит вызовов ИИ: true, если можно продолжать (и записывает вызов).
create or replace function public.ai_rate_ok(p_user uuid, p_action text, p_limit int, p_window interval)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.ai_usage
  where user_id = p_user and created_at > now() - p_window;

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.ai_usage (user_id, action) values (p_user, p_action);

  if random() < 0.02 then
    delete from public.ai_usage where created_at < now() - interval '2 days';
    delete from public.text_clearances where expires_at < now();
  end if;
  return true;
end;
$$;

-- ИИ решил, что слово в тексте употреблено нормально: выдаём «справку» на 15 минут.
create or replace function public.grant_text_clearance(p_user uuid, p_text text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.text_clearances (user_id, text_hash)
  values (p_user, sha256(convert_to(coalesce(p_text, ''), 'UTF8')))
  on conflict (user_id, text_hash) do update set expires_at = now() + interval '15 minutes'
$$;

create or replace function public.has_text_clearance(p_user uuid, p_text text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.text_clearances c
    where c.user_id = p_user
      and c.text_hash = sha256(convert_to(coalesce(p_text, ''), 'UTF8'))
      and c.expires_at > now()
  )
$$;

-- Единая точка проверки перед записью: возвращает null, если всё в порядке,
-- иначе jsonb-ответ для клиента (со страйком, если он положен).
create or replace function public.nx_gate_text(p_user uuid, p_text text, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb := public.moderate_text(p_text);
begin
  if (v_res ->> 'ok')::boolean then
    return null;
  end if;

  if v_res ->> 'code' = 'forbidden' then
    return jsonb_build_object(
      'ok', false,
      'code', 'forbidden_text',
      'violation', public.apply_violation(p_user, p_kind, 'Запрещённые слова')
    );
  end if;

  if v_res ->> 'code' = 'spam' and not public.has_text_clearance(p_user, p_text) then
    return jsonb_build_object('ok', false, 'code', 'spam_text');
  end if;

  return null;
end;
$$;

-- ===== 03_rls.sql =====
-- ============================================================================
-- NXTCORE · 03 · RLS-политики и права доступа
-- Принцип: записи постов, комментариев и профиля идут только через RPC
-- (05_rpc.sql), где работает модерация. Прямые INSERT/UPDATE закрыты.
-- Прямой доступ оставлен там, где модерировать нечего: лайки, подписки,
-- жалобы, отметка «прочитано», удаление своих записей.
-- ============================================================================

alter table public.profiles        enable row level security;
alter table public.posts           enable row level security;
alter table public.likes           enable row level security;
alter table public.comments        enable row level security;
alter table public.follows         enable row level security;
alter table public.notifications   enable row level security;
alter table public.reports         enable row level security;
alter table public.banned_words    enable row level security;
alter table public.violations      enable row level security;
alter table public.text_clearances enable row level security;
alter table public.ai_usage        enable row level security;

-- Сначала забираем всё, потом выдаём только нужное.
revoke all on public.profiles, public.posts, public.likes, public.comments, public.follows,
              public.notifications, public.reports, public.banned_words, public.violations,
              public.text_clearances, public.ai_usage
  from anon, authenticated;

-- ---------------------------------------------------------------- profiles
-- Чужие профили видны, пока человек не забанен. Служебные колонки (страйки,
-- причина бана, мут) закрыты на уровне колонок: свои читаются через my_profile().
grant select (id, username, display_name, bio, avatar_url, created_at)
  on public.profiles to authenticated;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or not public.user_is_banned(id));

-- ------------------------------------------------------------------- posts
grant select, delete on public.posts to authenticated;

drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (visibility = 'public' and not is_hidden and not public.user_is_banned(user_id))
  );

drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ------------------------------------------------------------------- likes
grant select, insert, delete on public.likes to authenticated;

drop policy if exists likes_select on public.likes;
create policy likes_select on public.likes
  for select to authenticated
  using (exists (select 1 from public.posts p where p.id = likes.post_id));

drop policy if exists likes_insert on public.likes;
create policy likes_insert on public.likes
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and not public.user_is_banned(user_id)
    and exists (select 1 from public.posts p where p.id = likes.post_id)
  );

drop policy if exists likes_delete on public.likes;
create policy likes_delete on public.likes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- comments
grant select, delete on public.comments to authenticated;

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated
  using (
    exists (select 1 from public.posts p where p.id = comments.post_id)
    and not public.user_is_banned(user_id)
  );

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.posts p where p.id = comments.post_id and p.user_id = (select auth.uid()))
  );

-- ----------------------------------------------------------------- follows
grant select, insert, delete on public.follows to authenticated;

drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows
  for select to authenticated
  using (follower_id = (select auth.uid()) or followee_id = (select auth.uid()));

drop policy if exists follows_insert on public.follows;
create policy follows_insert on public.follows
  for insert to authenticated
  with check (
    follower_id = (select auth.uid())
    and follower_id <> followee_id
    and not public.user_is_banned(follower_id)
    and not public.user_is_banned(followee_id)
  );

drop policy if exists follows_delete on public.follows;
create policy follows_delete on public.follows
  for delete to authenticated
  using (follower_id = (select auth.uid()));

-- ----------------------------------------------------------- notifications
grant select, delete on public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------- reports
-- Жалобу можно отправить, читать их может только модератор (service role).
grant insert on public.reports to authenticated;

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and not public.user_is_banned(reporter_id)
    and (
      (target_type = 'post' and exists (select 1 from public.posts p where p.id = target_id and p.user_id <> reporter_id))
      or (target_type = 'user' and target_id <> reporter_id and exists (select 1 from public.profiles u where u.id = target_id))
    )
  );

-- banned_words, violations, text_clearances, ai_usage: политик нет, значит
-- клиентам доступа нет. Работает только service role и функции security definer.

-- ------------------------------------------------- права на функции (RPC)
-- По умолчанию Postgres выдаёт EXECUTE всем. Закрываем служебные функции.
revoke execute on function public.apply_violation(uuid, text, text)       from public, anon, authenticated;
revoke execute on function public.register_violation_for(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.nx_user_state(uuid)                     from public, anon, authenticated;
revoke execute on function public.ai_rate_ok(uuid, text, int, interval)   from public, anon, authenticated;
revoke execute on function public.grant_text_clearance(uuid, text)        from public, anon, authenticated;
revoke execute on function public.has_text_clearance(uuid, text)          from public, anon, authenticated;
revoke execute on function public.nx_gate_text(uuid, text, text)          from public, anon, authenticated;
revoke execute on function public.moderate_text(text)                     from public, anon;
revoke execute on function public.moderate_display_name(text)             from public, anon;

grant execute on function public.register_violation_for(uuid, text, text) to service_role;
grant execute on function public.nx_user_state(uuid)                      to service_role;
grant execute on function public.ai_rate_ok(uuid, text, int, interval)    to service_role;
grant execute on function public.grant_text_clearance(uuid, text)         to service_role;
grant execute on function public.has_text_clearance(uuid, text)           to service_role;
-- Эти функции безопасны для клиента: они только читают и ничего не меняют.
grant execute on function public.moderate_text(text)           to authenticated;
grant execute on function public.moderate_display_name(text)   to authenticated;
grant execute on function public.moderate_username(text)       to anon, authenticated;
grant execute on function public.user_is_banned(uuid)          to authenticated;
grant execute on function public.user_is_muted(uuid)           to authenticated;

-- ===== 04_triggers.sql =====
-- ============================================================================
-- NXTCORE · 04 · Триггеры: новый пользователь, счётчики, уведомления, жалобы
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Новый пользователь auth.users → строка в profiles.
-- Регистрация по email передаёт username, display_name и privacy_accepted
-- в raw_user_meta_data. Вход через Google приходит без ника: ставим временный
-- и просим выбрать настоящий (needs_setup = true).
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_username text  := lower(nullif(trim(v_meta ->> 'username'), ''));
  v_display  text  := left(coalesce(nullif(trim(v_meta ->> 'display_name'), ''), v_username, ''), 40);
  v_accepted boolean := coalesce(v_meta ->> 'privacy_accepted', 'false') = 'true';
  v_setup    boolean := false;
  v_check    jsonb;
begin
  if v_username is null then
    -- OAuth: ник выберет сам при первом входе
    v_username := 'user_' || substr(md5(new.id::text || clock_timestamp()::text), 1, 10);
    v_setup := true;
    v_display := left(coalesce(nullif(trim(v_meta ->> 'full_name'), ''), nullif(trim(v_meta ->> 'name'), ''), ''), 40);
    -- имя из Google тоже проходит проверку
    if not (public.moderate_display_name(v_display) ->> 'ok')::boolean then
      v_display := '';
    end if;
  else
    v_check := public.moderate_username(v_username);
    if not (v_check ->> 'ok')::boolean then
      raise exception 'username_not_allowed' using errcode = 'P0001';
    end if;
    if not v_accepted then
      raise exception 'privacy_required' using errcode = 'P0001';
    end if;
    if not (public.moderate_display_name(v_display) ->> 'ok')::boolean then
      v_display := v_username;
    end if;
  end if;

  insert into public.profiles (id, username, display_name, privacy_accepted_at, needs_setup)
  values (new.id, v_username, v_display, case when v_accepted then now() end, v_setup);

  return new;
exception
  when unique_violation then
    raise exception 'username_taken' using errcode = 'P0001';
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- Лайки: счётчик + уведомление автору
-- ----------------------------------------------------------------------------
create or replace function public.on_like_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'INSERT' then
    update public.posts set likes_count = likes_count + 1
     where id = new.post_id
     returning user_id into v_owner;

    if v_owner is not null and v_owner <> new.user_id then
      insert into public.notifications (user_id, actor_id, type, post_id)
      values (v_owner, new.user_id, 'like', new.post_id)
      on conflict do nothing;
    end if;
    return new;
  else
    update public.posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
    delete from public.notifications
     where type = 'like' and actor_id = old.user_id and post_id = old.post_id;
    return old;
  end if;
end;
$$;

drop trigger if exists likes_after_change on public.likes;
create trigger likes_after_change
  after insert or delete on public.likes
  for each row execute function public.on_like_change();

-- ----------------------------------------------------------------------------
-- Комментарии: счётчик + уведомление автору записи
-- ----------------------------------------------------------------------------
create or replace function public.on_comment_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'INSERT' then
    update public.posts set comments_count = comments_count + 1
     where id = new.post_id
     returning user_id into v_owner;

    if v_owner is not null and v_owner <> new.user_id then
      insert into public.notifications (user_id, actor_id, type, post_id, comment_id)
      values (v_owner, new.user_id, 'comment', new.post_id, new.id);
    end if;
    return new;
  else
    update public.posts set comments_count = greatest(comments_count - 1, 0) where id = old.post_id;
    return old;
  end if;
end;
$$;

drop trigger if exists comments_after_change on public.comments;
create trigger comments_after_change
  after insert or delete on public.comments
  for each row execute function public.on_comment_change();

-- ----------------------------------------------------------------------------
-- Подписки: уведомление
-- ----------------------------------------------------------------------------
create or replace function public.on_follow_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, actor_id, type)
    values (new.followee_id, new.follower_id, 'follow')
    on conflict do nothing;
    return new;
  else
    delete from public.notifications
     where type = 'follow' and actor_id = old.follower_id and user_id = old.followee_id;
    return old;
  end if;
end;
$$;

drop trigger if exists follows_after_change on public.follows;
create trigger follows_after_change
  after insert or delete on public.follows
  for each row execute function public.on_follow_change();

-- ----------------------------------------------------------------------------
-- Жалобы: от трёх разных людей запись скрывается до проверки.
-- ----------------------------------------------------------------------------
create or replace function public.on_report_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_type = 'post' then
    if (select count(distinct reporter_id) from public.reports
         where target_type = 'post' and target_id = new.target_id) >= 3 then
      update public.posts set is_hidden = true where id = new.target_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists reports_after_insert on public.reports;
create trigger reports_after_insert
  after insert on public.reports
  for each row execute function public.on_report_insert();

-- ----------------------------------------------------------------------------
-- Realtime для уведомлений (бейдж в шапке обновляется сам)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
     ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- ===== 05_rpc.sql =====
-- ============================================================================
-- NXTCORE · 05 · RPC: все записи через модерацию, все чтения через фильтры
-- Каждая функция работает от имени владельца (security definer), но сама
-- проверяет auth.uid(), бан, мут и видимость записей.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Вспомогательные функции
-- ----------------------------------------------------------------------------

-- Может ли человек писать: вошёл, не забанен, принял политику, не в муте.
create or replace function public.nx_write_guard(p_user uuid, p_allow_muted boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_pr public.profiles;
begin
  if p_user is null then
    return jsonb_build_object('ok', false, 'code', 'auth');
  end if;
  select * into v_pr from public.profiles where id = p_user;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'auth');
  end if;
  if v_pr.is_banned and (v_pr.ban_until is null or v_pr.ban_until > now()) then
    return jsonb_build_object('ok', false, 'code', 'banned', 'reason', v_pr.ban_reason, 'until', v_pr.ban_until);
  end if;
  if v_pr.privacy_accepted_at is null then
    return jsonb_build_object('ok', false, 'code', 'privacy_required');
  end if;
  if not p_allow_muted and v_pr.muted_until is not null and v_pr.muted_until > now() then
    return jsonb_build_object('ok', false, 'code', 'muted', 'until', v_pr.muted_until);
  end if;
  return null;
end;
$$;

-- Запись в виде jsonb вместе с автором и «лайкнул ли я».
create or replace function public.nx_post_json(p public.posts, v uuid, p_full boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id,
    'user_id', p.user_id,
    'title', p.title,
    'text', p.text,
    'photos', p.photos,
    'cover_path', p.cover_path,
    'mood', p.mood,
    'visibility', p.visibility,
    'day_date', p.day_date,
    'memory', p.memory,
    'music', p.music,
    'voice', p.voice,
    'weather', p.weather,
    'ai', case when p_full then p.ai end,
    'is_hidden', p.is_hidden,
    'likes_count', p.likes_count,
    'comments_count', p.comments_count,
    'edited_at', p.edited_at,
    'created_at', p.created_at,
    'liked_by_me', exists (select 1 from public.likes l where l.post_id = p.id and l.user_id = v),
    'author', jsonb_build_object(
      'id', a.id,
      'username', a.username,
      'display_name', a.display_name,
      'avatar_url', a.avatar_url
    )
  )
  from public.profiles a
  where a.id = p.user_id
$$;

-- Фото и обложка принадлежат этому человеку и этой записи и реально лежат в Storage
-- (то есть загружены через Edge Function после проверки).
create or replace function public.nx_check_media(p_user uuid, p_post uuid, p_photos jsonb, p_cover text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_prefix text := p_user::text || '/' || p_post::text || '/';
  v_item   jsonb;
  v_path   text;
begin
  if jsonb_typeof(p_photos) <> 'array' or jsonb_array_length(p_photos) > 6 then
    return false;
  end if;
  for v_item in select * from jsonb_array_elements(p_photos) loop
    if jsonb_typeof(v_item) <> 'object' then return false; end if;
    v_path := v_item ->> 'path';
    if v_path is null or left(v_path, char_length(v_prefix)) <> v_prefix then return false; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'photos' and o.name = v_path) then
      return false;
    end if;
  end loop;
  if p_cover is not null then
    if left(p_cover, char_length(v_prefix)) <> v_prefix then return false; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'photos' and o.name = p_cover) then
      return false;
    end if;
  end if;
  return true;
end;
$$;

-- Проверка служебных json-блоков (память, музыка, голос, ИИ): только запрещённые слова.
create or replace function public.nx_gate_blob(p_user uuid, p_blob text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb := public.moderate_text(p_blob);
begin
  if v_res ->> 'code' = 'forbidden' then
    return jsonb_build_object(
      'ok', false,
      'code', 'forbidden_text',
      'violation', public.apply_violation(p_user, 'text', 'Запрещённые слова')
    );
  end if;
  return null;
end;
$$;

revoke execute on function public.nx_write_guard(uuid, boolean)                from public, anon, authenticated;
revoke execute on function public.nx_post_json(public.posts, uuid, boolean)    from public, anon, authenticated;
revoke execute on function public.nx_check_media(uuid, uuid, jsonb, text)      from public, anon, authenticated;
revoke execute on function public.nx_gate_blob(uuid, text)                     from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Профиль
-- ----------------------------------------------------------------------------
create or replace function public.username_status(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name text := lower(coalesce(p_username, ''));
  v_mod  jsonb := public.moderate_username(v_name);
begin
  if not (v_mod ->> 'ok')::boolean then
    return jsonb_build_object('available', false, 'allowed', false, 'code', v_mod ->> 'code');
  end if;
  if exists (select 1 from public.profiles where username = v_name) then
    return jsonb_build_object('available', false, 'allowed', true, 'code', 'taken');
  end if;
  return jsonb_build_object('available', true, 'allowed', true);
end;
$$;

create or replace function public.my_profile()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id,
    'username', p.username,
    'display_name', p.display_name,
    'bio', p.bio,
    'avatar_url', p.avatar_url,
    'is_banned', (p.is_banned and (p.ban_until is null or p.ban_until > now())),
    'ban_reason', p.ban_reason,
    'ban_until', p.ban_until,
    'strikes', p.strikes,
    'muted_until', case when p.muted_until > now() then p.muted_until end,
    'privacy_accepted_at', p.privacy_accepted_at,
    'needs_setup', p.needs_setup,
    'settings', p.settings,
    'created_at', p.created_at
  )
  from public.profiles p
  where p.id = auth.uid()
$$;

-- Допустимые настройки. Всё остальное отбрасывается.
create or replace function public.nx_clean_settings(p jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_strip_nulls(jsonb_build_object(
    'lang',               case when p ->> 'lang' in ('ru', 'kk') then p ->> 'lang' end,
    'theme',              case when p ->> 'theme' in ('light', 'dark', 'system') then p ->> 'theme' end,
    'default_visibility', case when p ->> 'default_visibility' in ('public', 'private') then p ->> 'default_visibility' end,
    'reduce_motion',      case when jsonb_typeof(p -> 'reduce_motion') = 'boolean' then p -> 'reduce_motion' end,
    'voice',              case when jsonb_typeof(p -> 'voice') = 'boolean' then p -> 'voice' end,
    'weather',            case when jsonb_typeof(p -> 'weather') = 'boolean' then p -> 'weather' end,
    'use_ai',             case when jsonb_typeof(p -> 'use_ai') = 'boolean' then p -> 'use_ai' end
  )), '{}'::jsonb)
$$;

create or replace function public.update_profile(
  p_display_name text default null,
  p_bio          text default null,
  p_avatar_url   text default null,
  p_settings     jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v       uuid := auth.uid();
  v_err   jsonb := public.nx_write_guard(v, true);
  v_mod   jsonb;
  v_gate  jsonb;
  v_name  text;
  v_obj   text;
begin
  if v_err is not null then return v_err; end if;

  if p_display_name is not null then
    p_display_name := btrim(p_display_name);
    if char_length(p_display_name) > 40 then
      return jsonb_build_object('ok', false, 'code', 'too_long');
    end if;
    v_mod := public.moderate_display_name(p_display_name);
    if not (v_mod ->> 'ok')::boolean then
      if v_mod ->> 'code' = 'reserved' then
        return jsonb_build_object('ok', false, 'code', 'reserved_name');
      elsif v_mod ->> 'code' = 'forbidden' then
        return jsonb_build_object('ok', false, 'code', 'forbidden_text',
          'violation', public.apply_violation(v, 'profile', 'Запрещённые слова в имени'));
      end if;
    end if;
  end if;

  if p_bio is not null then
    p_bio := btrim(p_bio);
    if char_length(p_bio) > 150 then
      return jsonb_build_object('ok', false, 'code', 'too_long');
    end if;
    v_gate := public.nx_gate_text(v, p_bio, 'profile');
    if v_gate is not null then return v_gate; end if;
  end if;

  if p_avatar_url is not null and p_avatar_url <> '' then
    v_obj := split_part(substring(p_avatar_url from '/avatars/(.+)$'), '?', 1);
    if v_obj is null or left(v_obj, char_length(v::text) + 1) <> v::text || '/' then
      return jsonb_build_object('ok', false, 'code', 'bad_avatar');
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'avatars' and o.name = v_obj) then
      return jsonb_build_object('ok', false, 'code', 'bad_avatar');
    end if;
  end if;

  update public.profiles
     set display_name = coalesce(p_display_name, display_name),
         bio          = coalesce(p_bio, bio),
         avatar_url   = case when p_avatar_url is null then avatar_url
                             when p_avatar_url = '' then null
                             else p_avatar_url end,
         settings     = case when p_settings is null then settings
                             else settings || public.nx_clean_settings(p_settings) end
   where id = v;

  return jsonb_build_object('ok', true, 'profile', public.my_profile());
end;
$$;

create or replace function public.change_username(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v      uuid := auth.uid();
  v_err  jsonb := public.nx_write_guard(v, true);
  v_name text := lower(btrim(coalesce(p_username, '')));
  v_st   jsonb;
begin
  if v_err is not null then return v_err; end if;
  v_st := public.username_status(v_name);
  if not (v_st ->> 'available')::boolean then
    return jsonb_build_object('ok', false, 'code', v_st ->> 'code');
  end if;
  update public.profiles set username = v_name, needs_setup = false where id = v;
  return jsonb_build_object('ok', true, 'profile', public.my_profile());
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'taken');
end;
$$;

-- Первый вход через Google: выбрать ник и принять политику.
create or replace function public.accept_privacy(p_username text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v      uuid := auth.uid();
  v_pr   public.profiles;
  v_st   jsonb;
  v_name text := lower(btrim(coalesce(p_username, '')));
begin
  select * into v_pr from public.profiles where id = v;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'auth');
  end if;
  if v_pr.is_banned and (v_pr.ban_until is null or v_pr.ban_until > now()) then
    return jsonb_build_object('ok', false, 'code', 'banned');
  end if;

  if v_pr.needs_setup then
    v_st := public.username_status(v_name);
    if not (v_st ->> 'available')::boolean then
      return jsonb_build_object('ok', false, 'code', v_st ->> 'code');
    end if;
    update public.profiles
       set username = v_name,
           needs_setup = false,
           display_name = case when display_name = '' then v_name else display_name end
     where id = v;
  end if;

  update public.profiles set privacy_accepted_at = coalesce(privacy_accepted_at, now()) where id = v;
  return jsonb_build_object('ok', true, 'profile', public.my_profile());
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'taken');
end;
$$;

-- Удаление аккаунта. Файлы из Storage клиент удаляет до вызова.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'auth';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

-- ----------------------------------------------------------------------------
-- Записи
-- ----------------------------------------------------------------------------
create or replace function public.create_post(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v       uuid := auth.uid();
  v_err   jsonb := public.nx_write_guard(v);
  v_id    uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  v_title text := nullif(btrim(coalesce(p ->> 'title', '')), '');
  v_text  text := btrim(coalesce(p ->> 'text', ''));
  v_photos jsonb := coalesce(p -> 'photos', '[]'::jsonb);
  v_cover text := nullif(p ->> 'cover_path', '');
  v_gate  jsonb;
  v_row   public.posts;
begin
  if v_err is not null then return v_err; end if;

  if char_length(v_text) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'too_long');
  end if;
  if v_text = '' and jsonb_array_length(v_photos) = 0 then
    return jsonb_build_object('ok', false, 'code', 'empty');
  end if;
  if (select count(*) from public.posts where user_id = v and created_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('ok', false, 'code', 'rate_limit');
  end if;

  v_gate := public.nx_gate_text(v, coalesce(v_title, '') || E'\n' || v_text, 'text');
  if v_gate is not null then return v_gate; end if;
  v_gate := public.nx_gate_blob(v, concat_ws(' ', p -> 'music' ->> 'title', p -> 'music' ->> 'artist',
                                              (p -> 'memory')::text, (p -> 'ai')::text, (p -> 'voice')::text));
  if v_gate is not null then return v_gate; end if;

  if not public.nx_check_media(v, v_id, v_photos, v_cover) then
    return jsonb_build_object('ok', false, 'code', 'bad_media');
  end if;

  insert into public.posts (id, user_id, title, text, photos, cover_path, mood, visibility, day_date,
                            memory, music, voice, weather, ai)
  values (
    v_id, v, v_title, v_text, v_photos, v_cover,
    nullif(p ->> 'mood', ''),
    coalesce(nullif(p ->> 'visibility', ''), 'private'),
    coalesce(nullif(p ->> 'day_date', '')::date, current_date),
    coalesce(p -> 'memory', '{}'::jsonb),
    nullif(p -> 'music', 'null'::jsonb),
    nullif(p -> 'voice', 'null'::jsonb),
    nullif(p -> 'weather', 'null'::jsonb),
    nullif(p -> 'ai', 'null'::jsonb)
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'post', public.nx_post_json(v_row, v, true));
exception
  when check_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'exists');
end;
$$;

create or replace function public.update_post(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v        uuid := auth.uid();
  v_err    jsonb := public.nx_write_guard(v);
  v_old    public.posts;
  v_row    public.posts;
  v_title  text;
  v_text   text;
  v_photos jsonb;
  v_cover  text;
  v_gate   jsonb;
  v_removed jsonb;
  v_changed boolean;
begin
  if v_err is not null then return v_err; end if;

  select * into v_old from public.posts where id = p_id and user_id = v for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  v_title  := case when p ? 'title' then nullif(btrim(coalesce(p ->> 'title', '')), '') else v_old.title end;
  v_text   := case when p ? 'text' then btrim(coalesce(p ->> 'text', '')) else v_old.text end;
  v_photos := case when p ? 'photos' then coalesce(p -> 'photos', '[]'::jsonb) else v_old.photos end;
  v_cover  := case when p ? 'cover_path' then nullif(p ->> 'cover_path', '') else v_old.cover_path end;

  if char_length(v_text) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'too_long');
  end if;
  if v_text = '' and jsonb_array_length(v_photos) = 0 then
    return jsonb_build_object('ok', false, 'code', 'empty');
  end if;

  v_gate := public.nx_gate_text(v, coalesce(v_title, '') || E'\n' || v_text, 'text');
  if v_gate is not null then return v_gate; end if;
  v_gate := public.nx_gate_blob(v, concat_ws(' ', p -> 'music' ->> 'title', p -> 'music' ->> 'artist',
                                              (p -> 'memory')::text, (p -> 'ai')::text, (p -> 'voice')::text));
  if v_gate is not null then return v_gate; end if;

  if not public.nx_check_media(v, p_id, v_photos, v_cover) then
    return jsonb_build_object('ok', false, 'code', 'bad_media');
  end if;

  v_changed := v_title is distinct from v_old.title
            or v_text is distinct from v_old.text
            or v_photos is distinct from v_old.photos;

  -- пути, которые больше не используются: клиент удалит их из Storage
  select coalesce(jsonb_agg(x.path), '[]'::jsonb) into v_removed
  from (
    select e ->> 'path' as path from jsonb_array_elements(v_old.photos) e
    union
    select v_old.cover_path where v_old.cover_path is not null
  ) x
  where x.path is not null
    and x.path is distinct from v_cover
    and not exists (select 1 from jsonb_array_elements(v_photos) n where n ->> 'path' = x.path);

  update public.posts set
    title      = v_title,
    text       = v_text,
    photos     = v_photos,
    cover_path = v_cover,
    mood       = case when p ? 'mood' then nullif(p ->> 'mood', '') else mood end,
    visibility = case when p ? 'visibility' then coalesce(nullif(p ->> 'visibility', ''), visibility) else visibility end,
    day_date   = case when p ? 'day_date' then coalesce(nullif(p ->> 'day_date', '')::date, day_date) else day_date end,
    memory     = case when p ? 'memory' then coalesce(p -> 'memory', '{}'::jsonb) else memory end,
    music      = case when p ? 'music' then nullif(p -> 'music', 'null'::jsonb) else music end,
    voice      = case when p ? 'voice' then nullif(p -> 'voice', 'null'::jsonb) else voice end,
    weather    = case when p ? 'weather' then nullif(p -> 'weather', 'null'::jsonb) else weather end,
    ai         = case when p ? 'ai' then nullif(p -> 'ai', 'null'::jsonb) else ai end,
    edited_at  = case when v_changed then now() else edited_at end
  where id = p_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'post', public.nx_post_json(v_row, v, true), 'removed_paths', v_removed);
exception
  when check_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'code', 'invalid');
end;
$$;

-- Удаляет запись и возвращает пути файлов, которые нужно убрать из Storage.
create or replace function public.delete_post(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v     uuid := auth.uid();
  v_old public.posts;
  v_paths jsonb;
begin
  if v is null then
    return jsonb_build_object('ok', false, 'code', 'auth');
  end if;
  select * into v_old from public.posts where id = p_id and user_id = v;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select coalesce(jsonb_agg(path), '[]'::jsonb) into v_paths from (
    select e ->> 'path' as path from jsonb_array_elements(v_old.photos) e
    union
    select v_old.cover_path where v_old.cover_path is not null
  ) x where path is not null;
  delete from public.posts where id = p_id;
  return jsonb_build_object('ok', true, 'paths', v_paths);
end;
$$;

-- ----------------------------------------------------------------------------
-- Комментарии
-- ----------------------------------------------------------------------------
create or replace function public.create_comment(p_post uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v      uuid := auth.uid();
  v_err  jsonb := public.nx_write_guard(v);
  v_text text := btrim(coalesce(p_text, ''));
  v_gate jsonb;
  v_id   uuid;
begin
  if v_err is not null then return v_err; end if;
  if v_text = '' then
    return jsonb_build_object('ok', false, 'code', 'empty');
  end if;
  if char_length(v_text) > 300 then
    return jsonb_build_object('ok', false, 'code', 'too_long');
  end if;
  if not exists (
    select 1 from public.posts p
     where p.id = p_post
       and (p.user_id = v or (p.visibility = 'public' and not p.is_hidden and not public.user_is_banned(p.user_id)))
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if (select count(*) from public.comments where user_id = v and created_at > now() - interval '1 minute') >= 10 then
    return jsonb_build_object('ok', false, 'code', 'rate_limit');
  end if;

  v_gate := public.nx_gate_text(v, v_text, 'comment');
  if v_gate is not null then return v_gate; end if;

  insert into public.comments (post_id, user_id, text) values (p_post, v, v_text) returning id into v_id;

  return jsonb_build_object('ok', true, 'comment', (
    select jsonb_build_object(
      'id', c.id, 'post_id', c.post_id, 'text', c.text, 'created_at', c.created_at,
      'author', jsonb_build_object('id', a.id, 'username', a.username, 'display_name', a.display_name, 'avatar_url', a.avatar_url)
    )
    from public.comments c join public.profiles a on a.id = c.user_id
    where c.id = v_id
  ));
end;
$$;

create or replace function public.get_comments(p_post uuid, p_limit int default 100)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v uuid := auth.uid();
begin
  if v is null or not exists (
    select 1 from public.posts p
     where p.id = p_post
       and (p.user_id = v or (p.visibility = 'public' and not p.is_hidden and not public.user_is_banned(p.user_id)))
  ) then
    return;
  end if;
  return query
    select jsonb_build_object(
      'id', c.id, 'post_id', c.post_id, 'text', c.text, 'created_at', c.created_at,
      'author', jsonb_build_object('id', a.id, 'username', a.username, 'display_name', a.display_name, 'avatar_url', a.avatar_url)
    )
    from public.comments c
    join public.profiles a on a.id = c.user_id
    where c.post_id = p_post
      and not (a.is_banned and (a.ban_until is null or a.ban_until > now()))
    order by c.created_at asc
    limit least(greatest(p_limit, 1), 200);
end;
$$;

-- Кто поставил лайк (и когда)
create or replace function public.get_likers(p_post uuid, p_limit int default 100)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v uuid := auth.uid();
begin
  if v is null or not exists (
    select 1 from public.posts p
     where p.id = p_post
       and (p.user_id = v or (p.visibility = 'public' and not p.is_hidden and not public.user_is_banned(p.user_id)))
  ) then
    return;
  end if;
  return query
    select jsonb_build_object(
      'created_at', l.created_at,
      'user', jsonb_build_object('id', a.id, 'username', a.username, 'display_name', a.display_name, 'avatar_url', a.avatar_url)
    )
    from public.likes l
    join public.profiles a on a.id = l.user_id
    where l.post_id = p_post
      and not (a.is_banned and (a.ban_until is null or a.ban_until > now()))
    order by l.created_at desc
    limit least(greatest(p_limit, 1), 200);
end;
$$;

-- ----------------------------------------------------------------------------
-- Лента рекомендаций.
-- Каждый вызов собирает новую подборку до 100 записей (p_limit) из публичных
-- записей людей, которые не забанены, и сортирует её от новых к старым.
-- Баллы: подписка (+3), совпадение настроения с вашими последними днями (+0.8),
-- лайки (+0.7·ln), свежесть (до +2.5, затухает за ~4 дня) и небольшая случайность
-- от p_salt, чтобы подборка не повторялась.
-- Клиент передаёт p_exclude со списком уже показанных записей, поэтому после
-- каждых 100 записей подборка пересобирается без повторов.
-- ----------------------------------------------------------------------------
create or replace function public.get_feed(
  p_exclude uuid[] default '{}',
  p_limit   int default 100,
  p_salt    int default 0
)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v      uuid := auth.uid();
  v_mood text;
begin
  if v is null or public.user_is_banned(v) then
    return;
  end if;

  select mood into v_mood
  from public.posts
  where user_id = v and mood is not null and created_at > now() - interval '30 days'
  group by mood order by count(*) desc limit 1;

  return query
  with ranked as (
    select p.id,
      (case when f.followee_id is not null then 3.0 else 0 end)
      + (case when v_mood is not null and p.mood = v_mood then 0.8 else 0 end)
      + ln(1 + p.likes_count) * 0.7
      + 2.5 * exp(- extract(epoch from (now() - p.created_at)) / 3600.0 / 96.0)
      + (abs(hashtext(p.id::text || v::text || p_salt::text)) % 1000) / 1000.0 * 1.3 as score
    from public.posts p
    join public.profiles a on a.id = p.user_id
    left join public.follows f on f.follower_id = v and f.followee_id = p.user_id
    where p.visibility = 'public'
      and not p.is_hidden
      and not (a.is_banned and (a.ban_until is null or a.ban_until > now()))
      and not (p.id = any (coalesce(p_exclude, '{}')))
    order by score desc
    limit least(greatest(p_limit, 1), 100)
  )
  select public.nx_post_json(p, v)
  from ranked r
  join public.posts p on p.id = r.id
  order by p.created_at desc;
end;
$$;

create or replace function public.get_post(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v   uuid := auth.uid();
  v_p public.posts;
begin
  if v is null then return null; end if;
  select * into v_p from public.posts p
   where p.id = p_id
     and (p.user_id = v or (p.visibility = 'public' and not p.is_hidden and not public.user_is_banned(p.user_id)));
  if not found then return null; end if;
  return public.nx_post_json(v_p, v, true);
end;
$$;

-- Записи одного человека. Себе показываются все (включая приватные и скрытые).
create or replace function public.get_user_posts(p_username text, p_limit int default 20, p_before timestamptz default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v      uuid := auth.uid();
  v_user uuid;
begin
  if v is null then return; end if;
  select id into v_user from public.profiles where username = lower(p_username);
  if v_user is null then return; end if;
  if v_user <> v and public.user_is_banned(v_user) then return; end if;

  return query
    select public.nx_post_json(p, v)
    from public.posts p
    where p.user_id = v_user
      and (v_user = v or (p.visibility = 'public' and not p.is_hidden))
      and (p_before is null or p.created_at < p_before)
    order by p.created_at desc
    limit least(greatest(p_limit, 1), 50);
end;
$$;

-- Архив дней: свои записи по дате дня, новые сверху.
create or replace function public.get_archive(p_limit int default 60, p_offset int default 0, p_mood text default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v uuid := auth.uid();
begin
  if v is null then return; end if;
  return query
    select public.nx_post_json(p, v)
    from public.posts p
    where p.user_id = v
      and (p_mood is null or p.mood = p_mood)
    order by p.day_date desc, p.created_at desc
    limit least(greatest(p_limit, 1), 100)
    offset greatest(p_offset, 0);
end;
$$;

-- ----------------------------------------------------------------------------
-- Профили и поиск
-- ----------------------------------------------------------------------------
create or replace function public.get_profile(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v    uuid := auth.uid();
  v_pr public.profiles;
  v_me boolean;
begin
  if v is null then return null; end if;
  select * into v_pr from public.profiles where username = lower(p_username);
  if not found then return null; end if;
  v_me := v_pr.id = v;
  if not v_me and public.user_is_banned(v_pr.id) then return null; end if;

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_pr.id, 'username', v_pr.username, 'display_name', v_pr.display_name,
      'bio', v_pr.bio, 'avatar_url', v_pr.avatar_url, 'created_at', v_pr.created_at
    ),
    'stats', jsonb_build_object(
      'posts', (select count(*) from public.posts p
                 where p.user_id = v_pr.id and (v_me or (p.visibility = 'public' and not p.is_hidden))),
      'likes', (select coalesce(sum(p.likes_count), 0) from public.posts p
                 where p.user_id = v_pr.id and (v_me or (p.visibility = 'public' and not p.is_hidden))),
      'followers', (select count(*) from public.follows f where f.followee_id = v_pr.id),
      'following', (select count(*) from public.follows f where f.follower_id = v_pr.id)
    ),
    'is_me', v_me,
    'is_following', exists (select 1 from public.follows f where f.follower_id = v and f.followee_id = v_pr.id)
  );
end;
$$;

create or replace function public.nx_like_escape(p text)
returns text
language sql
immutable
as $$
  select replace(replace(replace(coalesce(p, ''), '\', '\\'), '%', '\%'), '_', '\_')
$$;

create or replace function public.search_users(p_q text, p_limit int default 20)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v   uuid := auth.uid();
  v_q text := btrim(coalesce(p_q, ''));
  v_e text;
begin
  if v is null or char_length(v_q) < 2 then return; end if;
  v_e := public.nx_like_escape(left(v_q, 40));
  return query
    select jsonb_build_object(
      'id', a.id, 'username', a.username, 'display_name', a.display_name,
      'avatar_url', a.avatar_url, 'bio', a.bio
    )
    from public.profiles a
    where not (a.is_banned and (a.ban_until is null or a.ban_until > now()))
      and a.privacy_accepted_at is not null
      and (a.username ilike '%' || v_e || '%' or a.display_name ilike '%' || v_e || '%')
    order by (a.username ilike v_e || '%') desc, (a.display_name ilike v_e || '%') desc, a.username
    limit least(greatest(p_limit, 1), 50);
end;
$$;

create or replace function public.search_posts(p_q text, p_limit int default 30)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v   uuid := auth.uid();
  v_q text := btrim(coalesce(p_q, ''));
  v_e text;
begin
  if v is null or char_length(v_q) < 2 then return; end if;
  v_e := public.nx_like_escape(left(v_q, 60));
  return query
    select public.nx_post_json(p, v)
    from public.posts p
    join public.profiles a on a.id = p.user_id
    where (p.text ilike '%' || v_e || '%' or p.title ilike '%' || v_e || '%')
      and (p.user_id = v or (
            p.visibility = 'public' and not p.is_hidden
            and not (a.is_banned and (a.ban_until is null or a.ban_until > now()))))
    order by p.created_at desc
    limit least(greatest(p_limit, 1), 50);
end;
$$;

-- ----------------------------------------------------------------------------
-- Уведомления
-- ----------------------------------------------------------------------------
create or replace function public.get_notifications(p_limit int default 40, p_before timestamptz default null)
returns setof jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v uuid := auth.uid();
begin
  if v is null then return; end if;
  return query
    select jsonb_build_object(
      'id', n.id, 'type', n.type, 'read', n.read, 'created_at', n.created_at,
      'post_id', n.post_id,
      'post_title', p.title,
      'post_excerpt', left(p.text, 90),
      'actor', jsonb_build_object('id', a.id, 'username', a.username, 'display_name', a.display_name, 'avatar_url', a.avatar_url)
    )
    from public.notifications n
    join public.profiles a on a.id = n.actor_id
    left join public.posts p on p.id = n.post_id
    where n.user_id = v
      and not (a.is_banned and (a.ban_until is null or a.ban_until > now()))
      and (p_before is null or n.created_at < p_before)
    order by n.created_at desc
    limit least(greatest(p_limit, 1), 100);
end;
$$;

create or replace function public.unread_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.notifications n
  join public.profiles a on a.id = n.actor_id
  where n.user_id = auth.uid()
    and not n.read
    and not (a.is_banned and (a.ban_until is null or a.ban_until > now()))
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications
     set read = true
   where user_id = auth.uid()
     and not read
     and (p_ids is null or id = any (p_ids))
$$;

-- ----------------------------------------------------------------------------
-- Для модераторов. Выполнять в SQL Editor (там вы работаете как владелец).
--   select public.admin_ban('<uuid>', 'причина', null);          -- навсегда
--   select public.admin_ban('<uuid>', 'причина', now() + '7 days');
--   select public.admin_unban('<uuid>');
--   select public.admin_set_hidden('<post uuid>', false);        -- вернуть запись в ленту
--   select * from public.reports order by created_at desc;
-- ----------------------------------------------------------------------------
create or replace function public.admin_ban(p_user uuid, p_reason text, p_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set is_banned = true, ban_reason = p_reason, ban_until = p_until
   where id = p_user;
  begin
    delete from auth.sessions where user_id = p_user;
  exception when others then
    null;
  end;
end;
$$;

create or replace function public.admin_unban(p_user uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set is_banned = false, ban_reason = null, ban_until = null, strikes = 0, muted_until = null
   where id = p_user
$$;

create or replace function public.admin_set_hidden(p_post uuid, p_hidden boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.posts set is_hidden = p_hidden where id = p_post
$$;

revoke execute on function public.admin_ban(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.admin_unban(uuid)                  from public, anon, authenticated;
revoke execute on function public.admin_set_hidden(uuid, boolean)    from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Что доступно клиенту
-- ----------------------------------------------------------------------------
revoke execute on function public.username_status(text)                       from public;
revoke execute on function public.my_profile()                                from public, anon;
revoke execute on function public.update_profile(text, text, text, jsonb)     from public, anon;
revoke execute on function public.change_username(text)                       from public, anon;
revoke execute on function public.accept_privacy(text)                        from public, anon;
revoke execute on function public.delete_my_account()                         from public, anon;
revoke execute on function public.create_post(jsonb)                          from public, anon;
revoke execute on function public.update_post(uuid, jsonb)                    from public, anon;
revoke execute on function public.delete_post(uuid)                           from public, anon;
revoke execute on function public.create_comment(uuid, text)                  from public, anon;
revoke execute on function public.get_comments(uuid, int)                     from public, anon;
revoke execute on function public.get_likers(uuid, int)                       from public, anon;
revoke execute on function public.get_feed(uuid[], int, int)                  from public, anon;
revoke execute on function public.get_post(uuid)                              from public, anon;
revoke execute on function public.get_user_posts(text, int, timestamptz)      from public, anon;
revoke execute on function public.get_archive(int, int, text)                 from public, anon;
revoke execute on function public.get_profile(text)                           from public, anon;
revoke execute on function public.search_users(text, int)                     from public, anon;
revoke execute on function public.search_posts(text, int)                     from public, anon;
revoke execute on function public.get_notifications(int, timestamptz)         from public, anon;
revoke execute on function public.unread_count()                              from public, anon;
revoke execute on function public.mark_notifications_read(uuid[])             from public, anon;
revoke execute on function public.nx_clean_settings(jsonb)                    from public, anon, authenticated;
revoke execute on function public.nx_like_escape(text)                        from public, anon, authenticated;

grant execute on function public.username_status(text)                    to anon, authenticated;
grant execute on function public.my_profile()                             to authenticated;
grant execute on function public.update_profile(text, text, text, jsonb)  to authenticated;
grant execute on function public.change_username(text)                    to authenticated;
grant execute on function public.accept_privacy(text)                     to authenticated;
grant execute on function public.delete_my_account()                      to authenticated;
grant execute on function public.create_post(jsonb)                       to authenticated;
grant execute on function public.update_post(uuid, jsonb)                 to authenticated;
grant execute on function public.delete_post(uuid)                        to authenticated;
grant execute on function public.create_comment(uuid, text)               to authenticated;
grant execute on function public.get_comments(uuid, int)                  to authenticated;
grant execute on function public.get_likers(uuid, int)                    to authenticated;
grant execute on function public.get_feed(uuid[], int, int)               to authenticated;
grant execute on function public.get_post(uuid)                           to authenticated;
grant execute on function public.get_user_posts(text, int, timestamptz)   to authenticated;
grant execute on function public.get_archive(int, int, text)              to authenticated;
grant execute on function public.get_profile(text)                        to authenticated;
grant execute on function public.search_users(text, int)                  to authenticated;
grant execute on function public.search_posts(text, int)                  to authenticated;
grant execute on function public.get_notifications(int, timestamptz)      to authenticated;
grant execute on function public.unread_count()                           to authenticated;
grant execute on function public.mark_notifications_read(uuid[])          to authenticated;

-- ===== 06_storage.sql =====
-- ============================================================================
-- NXTCORE · 06 · Storage: бакеты и политики
--   avatars — публичный, ссылки открываются без входа. Загрузка идёт только
--             через Edge Function `ai` после проверки фото.
--   photos  — приватный: фото записей и готовые «воспоминания». Видны автору
--             и всем, если запись публичная. Загрузка только через Edge Function.
--   audio   — приватный: свои аудиофайлы человека. Видны только ему.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true,  2097152,  array['image/jpeg', 'image/png', 'image/webp']),
  ('photos',  'photos',  false, 6291456,  array['image/jpeg', 'image/png', 'image/webp']),
  ('audio',   'audio',   false, 15728640, array['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav',
                                                 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/flac'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Фото видно, если оно твоё или запись публичная, не скрыта, автор не забанен.
-- Путь файла: <user_id>/<post_id>/<имя>
create or replace function public.nx_photo_visible(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select split_part(p_name, '/', 1) = auth.uid()::text
      or exists (
        select 1 from public.posts p
         where p.id::text = split_part(p_name, '/', 2)
           and p.user_id::text = split_part(p_name, '/', 1)
           and p.visibility = 'public'
           and not p.is_hidden
           and not public.user_is_banned(p.user_id)
      )
$$;

revoke execute on function public.nx_photo_visible(text) from public, anon;
grant  execute on function public.nx_photo_visible(text) to authenticated;

-- photos: читать по правилам видимости, удалять только своё. Вставки нет:
-- файлы кладёт Edge Function с ключом service role.
drop policy if exists nx_photos_read   on storage.objects;
drop policy if exists nx_photos_delete on storage.objects;

create policy nx_photos_read on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.nx_photo_visible(name));

create policy nx_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and split_part(name, '/', 1) = (select auth.uid())::text);

-- avatars: удалять только своё (старые аватарки)
drop policy if exists nx_avatars_delete on storage.objects;
create policy nx_avatars_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text);

-- audio: всё только в своей папке
drop policy if exists nx_audio_all on storage.objects;
create policy nx_audio_all on storage.objects
  for all to authenticated
  using (bucket_id = 'audio' and split_part(name, '/', 1) = (select auth.uid())::text)
  with check (bucket_id = 'audio' and split_part(name, '/', 1) = (select auth.uid())::text);

-- ===== 07_banned_words_seed.sql =====
-- ============================================================================
-- NXTCORE · 07 · Начальный список запрещённых слов
-- Сгенерировано из data/banned-words.json (node scripts/gen-words.mjs).
-- Свои слова добавляйте так:
--   insert into public.banned_words (word, language, category, severity, match_type)
--   values ('слово', 'ru', 'profanity', 'block', 'token');
-- Типы совпадения: token = слово целиком, prefix = начало слова, substr = внутри слова.
-- ============================================================================

insert into public.banned_words (word, language, category, severity, match_type)
values
  ('хуй', 'ru', 'profanity', 'block', 'substr'),
  ('хуе', 'ru', 'profanity', 'block', 'substr'),
  ('хуя', 'ru', 'profanity', 'block', 'substr'),
  ('хули', 'ru', 'profanity', 'block', 'token'),
  ('пизд', 'ru', 'profanity', 'block', 'substr'),
  ('пезд', 'ru', 'profanity', 'block', 'substr'),
  ('бляд', 'ru', 'profanity', 'block', 'substr'),
  ('блят', 'ru', 'profanity', 'block', 'substr'),
  ('бля', 'ru', 'profanity', 'block', 'token'),
  ('ебан', 'ru', 'profanity', 'block', 'prefix'),
  ('ебат', 'ru', 'profanity', 'block', 'prefix'),
  ('ебал', 'ru', 'profanity', 'block', 'prefix'),
  ('еблан', 'ru', 'profanity', 'block', 'prefix'),
  ('ебаш', 'ru', 'profanity', 'block', 'prefix'),
  ('ебну', 'ru', 'profanity', 'block', 'prefix'),
  ('ебис', 'ru', 'profanity', 'block', 'prefix'),
  ('ебло', 'ru', 'profanity', 'block', 'prefix'),
  ('ебуч', 'ru', 'profanity', 'block', 'prefix'),
  ('ебыр', 'ru', 'profanity', 'block', 'prefix'),
  ('заеб', 'ru', 'profanity', 'block', 'prefix'),
  ('наеб', 'ru', 'profanity', 'block', 'prefix'),
  ('уеб', 'ru', 'profanity', 'block', 'prefix'),
  ('выеб', 'ru', 'profanity', 'block', 'prefix'),
  ('поеб', 'ru', 'profanity', 'block', 'prefix'),
  ('проеб', 'ru', 'profanity', 'block', 'prefix'),
  ('съеб', 'ru', 'profanity', 'block', 'prefix'),
  ('отъеб', 'ru', 'profanity', 'block', 'prefix'),
  ('разъеб', 'ru', 'profanity', 'block', 'prefix'),
  ('объеб', 'ru', 'profanity', 'block', 'prefix'),
  ('доеб', 'ru', 'profanity', 'block', 'prefix'),
  ('приеб', 'ru', 'profanity', 'block', 'prefix'),
  ('подъеб', 'ru', 'profanity', 'block', 'prefix'),
  ('долбоеб', 'ru', 'profanity', 'block', 'substr'),
  ('долбаеб', 'ru', 'profanity', 'block', 'substr'),
  ('мудак', 'ru', 'profanity', 'block', 'prefix'),
  ('мудил', 'ru', 'profanity', 'block', 'prefix'),
  ('мудозвон', 'ru', 'profanity', 'block', 'prefix'),
  ('гандон', 'ru', 'profanity', 'block', 'prefix'),
  ('гондон', 'ru', 'profanity', 'block', 'prefix'),
  ('залуп', 'ru', 'profanity', 'block', 'prefix'),
  ('шлюх', 'ru', 'profanity', 'block', 'prefix'),
  ('манда', 'ru', 'profanity', 'block', 'token'),
  ('мандавошк', 'ru', 'profanity', 'block', 'prefix'),
  ('дроч', 'ru', 'profanity', 'block', 'prefix'),
  ('жоп', 'ru', 'profanity', 'block', 'prefix'),
  ('сука', 'ru', 'profanity', 'block', 'token'),
  ('суки', 'ru', 'profanity', 'block', 'token'),
  ('суку', 'ru', 'profanity', 'block', 'token'),
  ('сукой', 'ru', 'profanity', 'block', 'token'),
  ('суке', 'ru', 'profanity', 'block', 'token'),
  ('сучар', 'ru', 'profanity', 'block', 'prefix'),
  ('пидор', 'ru', 'slur', 'block', 'prefix'),
  ('пидар', 'ru', 'slur', 'block', 'prefix'),
  ('пидр', 'ru', 'slur', 'block', 'prefix'),
  ('педик', 'ru', 'slur', 'block', 'token'),
  ('педики', 'ru', 'slur', 'block', 'token'),
  ('чурк', 'ru', 'slur', 'block', 'prefix'),
  ('черножоп', 'ru', 'slur', 'block', 'prefix'),
  ('хач', 'ru', 'slur', 'block', 'token'),
  ('хачи', 'ru', 'slur', 'block', 'token'),
  ('жид', 'ru', 'slur', 'block', 'token'),
  ('жиды', 'ru', 'slur', 'block', 'token'),
  ('жидов', 'ru', 'slur', 'block', 'token'),
  ('пиндос', 'ru', 'slur', 'block', 'prefix'),
  ('нигер', 'ru', 'slur', 'block', 'token'),
  ('нигеры', 'ru', 'slur', 'block', 'token'),
  ('ублюд', 'ru', 'insult', 'block', 'prefix'),
  ('мраз', 'ru', 'insult', 'block', 'prefix'),
  ('тварь', 'ru', 'insult', 'block', 'token'),
  ('твари', 'ru', 'insult', 'block', 'token'),
  ('урод', 'ru', 'insult', 'block', 'token'),
  ('уроды', 'ru', 'insult', 'block', 'token'),
  ('уродка', 'ru', 'insult', 'block', 'token'),
  ('вырод', 'ru', 'insult', 'block', 'prefix'),
  ('дебил', 'ru', 'insult', 'block', 'prefix'),
  ('идиот', 'ru', 'insult', 'block', 'prefix'),
  ('кретин', 'ru', 'insult', 'block', 'prefix'),
  ('говн', 'ru', 'insult', 'block', 'prefix'),
  ('сран', 'ru', 'insult', 'block', 'prefix'),
  ('сдохн', 'ru', 'insult', 'block', 'prefix'),
  ('чмо', 'ru', 'insult', 'block', 'token'),
  ('сиктир', 'kk', 'profanity', 'block', 'prefix'),
  ('сик', 'kk', 'profanity', 'block', 'token'),
  ('қотақ', 'kk', 'profanity', 'block', 'prefix'),
  ('көтеншек', 'kk', 'profanity', 'block', 'prefix'),
  ('жезөкше', 'kk', 'slur', 'block', 'prefix'),
  ('қаншық', 'kk', 'insult', 'block', 'prefix'),
  ('итбала', 'kk', 'insult', 'block', 'prefix'),
  ('шошқа', 'kk', 'insult', 'block', 'token'),
  ('fuck', 'en', 'profanity', 'block', 'substr'),
  ('fck', 'en', 'profanity', 'block', 'token'),
  ('fuk', 'en', 'profanity', 'block', 'token'),
  ('shit', 'en', 'profanity', 'block', 'token'),
  ('shitty', 'en', 'profanity', 'block', 'token'),
  ('bullshit', 'en', 'profanity', 'block', 'token'),
  ('bitch', 'en', 'insult', 'block', 'substr'),
  ('cunt', 'en', 'profanity', 'block', 'token'),
  ('cunts', 'en', 'profanity', 'block', 'token'),
  ('dick', 'en', 'profanity', 'block', 'token'),
  ('dicks', 'en', 'profanity', 'block', 'token'),
  ('dickhead', 'en', 'insult', 'block', 'prefix'),
  ('asshole', 'en', 'insult', 'block', 'substr'),
  ('bastard', 'en', 'insult', 'block', 'token'),
  ('whore', 'en', 'insult', 'block', 'token'),
  ('slut', 'en', 'insult', 'block', 'token'),
  ('pussy', 'en', 'profanity', 'block', 'token'),
  ('cock', 'en', 'profanity', 'block', 'token'),
  ('cocksucker', 'en', 'profanity', 'block', 'substr'),
  ('faggot', 'en', 'slur', 'block', 'substr'),
  ('fag', 'en', 'slur', 'block', 'token'),
  ('nigga', 'en', 'slur', 'block', 'token'),
  ('niggas', 'en', 'slur', 'block', 'token'),
  ('retard', 'en', 'slur', 'block', 'token'),
  ('retarded', 'en', 'slur', 'block', 'token'),
  ('porn', 'en', 'profanity', 'block', 'token'),
  ('porno', 'en', 'profanity', 'block', 'token'),
  ('nudes', 'en', 'profanity', 'block', 'token'),
  ('kys', 'en', 'insult', 'block', 'token'),
  ('pizd', 'en', 'profanity', 'block', 'substr'),
  ('pidor', 'en', 'slur', 'block', 'prefix'),
  ('pidar', 'en', 'slur', 'block', 'prefix'),
  ('blyat', 'en', 'profanity', 'block', 'prefix'),
  ('blyad', 'en', 'profanity', 'block', 'prefix'),
  ('blya', 'en', 'profanity', 'block', 'token'),
  ('suka', 'en', 'profanity', 'block', 'token'),
  ('ebat', 'en', 'profanity', 'block', 'prefix'),
  ('ebal', 'en', 'profanity', 'block', 'prefix'),
  ('zaeb', 'en', 'profanity', 'block', 'prefix'),
  ('nahuy', 'en', 'profanity', 'block', 'token'),
  ('nahui', 'en', 'profanity', 'block', 'token'),
  ('xuy', 'en', 'profanity', 'block', 'token'),
  ('huyn', 'en', 'profanity', 'block', 'prefix'),
  ('admin', 'en', 'reserved', 'block', 'substr'),
  ('support', 'en', 'reserved', 'block', 'substr'),
  ('moderator', 'en', 'reserved', 'block', 'substr'),
  ('official', 'en', 'reserved', 'block', 'substr'),
  ('nxtcore', 'en', 'reserved', 'block', 'substr'),
  ('staff', 'en', 'reserved', 'block', 'substr'),
  ('админ', 'ru', 'reserved', 'block', 'substr'),
  ('модератор', 'ru', 'reserved', 'block', 'substr'),
  ('официальн', 'ru', 'reserved', 'block', 'substr'),
  ('купи', 'ru', 'spam', 'soft', 'token'),
  ('купите', 'ru', 'spam', 'soft', 'token'),
  ('кредит', 'ru', 'spam', 'soft', 'prefix'),
  ('займ', 'ru', 'spam', 'soft', 'token'),
  ('заработок', 'ru', 'spam', 'soft', 'token'),
  ('заработай', 'ru', 'spam', 'soft', 'prefix'),
  ('казино', 'ru', 'spam', 'soft', 'token'),
  ('букмекер', 'ru', 'spam', 'soft', 'prefix'),
  ('подписывайся', 'ru', 'spam', 'soft', 'token'),
  ('скидк', 'ru', 'spam', 'soft', 'prefix'),
  ('инвестиц', 'ru', 'spam', 'soft', 'prefix'),
  ('крипт', 'ru', 'spam', 'soft', 'prefix'),
  ('сатып', 'kk', 'spam', 'soft', 'token'),
  ('несие', 'kk', 'spam', 'soft', 'token'),
  ('табыс', 'kk', 'spam', 'soft', 'prefix'),
  ('buy', 'en', 'spam', 'soft', 'token'),
  ('loan', 'en', 'spam', 'soft', 'token'),
  ('casino', 'en', 'spam', 'soft', 'token'),
  ('crypto', 'en', 'spam', 'soft', 'token'),
  ('bitcoin', 'en', 'spam', 'soft', 'token'),
  ('forex', 'en', 'spam', 'soft', 'token'),
  ('giveaway', 'en', 'spam', 'soft', 'token'),
  ('discount', 'en', 'spam', 'soft', 'token')
on conflict (word, language) do update
  set category = excluded.category,
      severity = excluded.severity,
      match_type = excluded.match_type;
