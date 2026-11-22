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
