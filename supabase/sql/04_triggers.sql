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
