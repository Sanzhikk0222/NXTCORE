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
