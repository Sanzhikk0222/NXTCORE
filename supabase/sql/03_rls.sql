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
