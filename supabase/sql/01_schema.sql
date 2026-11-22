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
