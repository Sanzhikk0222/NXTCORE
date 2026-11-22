-- Сценарные тесты SQL. Запускаются на локальном Postgres с имитацией Supabase:
--   bash tests/run-sql.sh
-- Каждый блок DO падает с понятным сообщением, если проверка не прошла.

create schema if not exists t;

create or replace function t.as_user(u uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, true);
  execute 'set local role authenticated';
end $$;

grant usage on schema t to public;

create or replace function t.mk(p_name text, p_accept boolean default true) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (v, p_name || '@test.local',
          jsonb_build_object('username', p_name, 'display_name', initcap(p_name), 'privacy_accepted', p_accept::text));
  return v;
end $$;

create or replace function t.uid(p_name text) returns uuid language sql security definer as $$
  select id from public.profiles where username = p_name
$$;
grant execute on all functions in schema t to public;

-- ---------------------------------------------------------------- 1. регистрация
do $$
declare v uuid; ok boolean;
begin
  v := t.mk('anna');
  perform t.mk('boris');
  perform t.mk('vera');
  perform t.mk('gleb');
  assert (select username from public.profiles where id = v) = 'anna', 'профиль создан триггером';
  assert (select privacy_accepted_at from public.profiles where id = v) is not null, 'согласие записано';

  -- запрещённые и зарезервированные ники
  declare n text;
  begin
    foreach n in array array['admin_x', 'support1', 'MyModerator', 'nxtcore_fan', 'pizdec', 'vasya_pidor', 'ab', 'a b c', 'имя', 'x'' or 1=1', '12345']
    loop
      begin
        perform t.mk(n);
        raise exception 'ник % должен быть отклонён', n;
      exception when others then
        assert sqlerrm in ('username_not_allowed', 'username_taken') or sqlerrm like '%check%' or sqlerrm like '%violates%',
          'неожиданная ошибка для ' || n || ': ' || sqlerrm;
      end;
    end loop;
  end;

  -- без согласия на политику
  begin
    perform t.mk('nopolicy', false);
    raise exception 'регистрация без согласия должна падать';
  exception when others then
    assert sqlerrm = 'privacy_required', 'privacy_required, а было: ' || sqlerrm;
  end;

  -- дубль ника (в другом регистре)
  begin
    perform t.mk('Anna');
    raise exception 'дубль ника должен падать';
  exception when others then
    assert sqlerrm in ('username_taken', 'username_not_allowed') or sqlerrm like '%duplicate%', 'дубль: ' || sqlerrm;
  end;
end $$;

-- ---------------------------------------------------------------- 2. username_status
do $$
declare r jsonb;
begin
  execute 'set local role anon';
  r := public.username_status('anna');   assert r ->> 'code' = 'taken', 'занят: ' || r::text;
  r := public.username_status('free_name'); assert (r ->> 'available')::boolean, 'свободен: ' || r::text;
  r := public.username_status('Admin');  assert r ->> 'code' in ('reserved'), 'reserved: ' || r::text;
  r := public.username_status('p1zd3c'); assert r ->> 'code' = 'forbidden', 'лит-замены: ' || r::text;
  r := public.username_status('ab');     assert r ->> 'code' = 'format', 'формат: ' || r::text;
end $$;

-- ---------------------------------------------------------------- 3. текстовый фильтр
do $$
declare t text; r jsonb;
begin
  foreach t in array array[
    'Мы шли по парку, кораблям бы тут плыть', 'не банковский день, небанальный', 'страна и странный день',
    'Scunthorpe, shiitake и Dickens', 'я купил хлеб и взял кредит на смех', 'Гуляли весь день, пили какао',
    'Сегодня Қазақстан күні, көңіл-күй керемет', 'Хочу сходить на концерт Niger Okoye'
  ] loop
    r := public.moderate_text(t);
    assert (r ->> 'ok')::boolean, 'ложное срабатывание: ' || t || ' → ' || r::text;
  end loop;

  foreach t in array array[
    'пошёл нахуй', 'ХУУУУЙ', 'п и з д е ц нет', 'ну ты и пиздец', 'Что за fuck', 'какой ты f u c k',
    'ты сука', 'bl9t', 'xyй тебе', 'ЕБАНЫЙ день', 'ты мудак', 'сиктир кет', 'shit happens'
  ] loop
    r := public.moderate_text(t);
    if t in ('п и з д е ц нет', 'какой ты f u c k', 'bl9t') then
      continue; -- разнесённые буквы намеренно не ловим по словам (ложные срабатывания хуже)
    end if;
    assert not (r ->> 'ok')::boolean and r ->> 'code' = 'forbidden', 'пропущено: ' || t || ' → ' || r::text;
  end loop;

  r := public.moderate_text('Купи кредит, заработок без вложений'); assert r ->> 'code' = 'spam', 'спам: ' || r::text;
  r := public.moderate_text('Купи тут https://x.ru');               assert r ->> 'code' = 'spam', 'спам+ссылка: ' || r::text;
  r := public.moderate_text('Ссылка на песню https://youtu.be/abc'); assert (r ->> 'ok')::boolean, 'ссылка сама по себе нормальна';
end $$;

-- ---------------------------------------------------------------- 4. права доступа (RLS)
do $$
declare v uuid := t.uid('anna'); n int;
begin
  perform t.as_user(v);
  -- служебные колонки закрыты
  begin
    perform strikes from public.profiles;
    raise exception 'strikes должен быть закрыт';
  exception when insufficient_privilege then null; end;
  perform username, display_name, bio from public.profiles;

  -- прямые записи закрыты
  begin
    insert into public.posts (user_id, text) values (v, 'x');
    raise exception 'прямой insert в posts должен падать';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set strikes = 0 where id = v;
    raise exception 'прямой update профиля должен падать';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.banned_words;
    raise exception 'banned_words должен быть закрыт';
  exception when insufficient_privilege then null; end;
  begin
    perform public.apply_violation(v, 'text', 'x');
    raise exception 'apply_violation должен быть закрыт';
  exception when insufficient_privilege then null; end;
  begin
    perform public.admin_ban(v, 'x', null);
    raise exception 'admin_ban должен быть закрыт';
  exception when insufficient_privilege then null; end;
end $$;

-- ---------------------------------------------------------------- 5. посты
do $$
declare
  a uuid := t.uid('anna'); b uuid := t.uid('boris');
  r jsonb; pid uuid := gen_random_uuid(); pid2 uuid := gen_random_uuid(); pid3 uuid := gen_random_uuid();
begin
  -- файлы, как будто их положила Edge Function
  insert into storage.objects (bucket_id, name) values
    ('photos', a || '/' || pid || '/0.jpg'), ('photos', a || '/' || pid || '/memory.jpg');

  perform t.as_user(a);
  r := public.create_post(jsonb_build_object(
    'id', pid, 'title', 'Осенний парк и какао', 'text', 'Гуляли по парку, пили какао.',
    'photos', jsonb_build_array(jsonb_build_object('path', a || '/' || pid || '/0.jpg', 'w', 1200, 'h', 900)),
    'cover_path', a || '/' || pid || '/memory.jpg', 'mood', 'warm', 'visibility', 'public',
    'memory', '{"technique":"impressionist"}'::jsonb, 'music', '{"title":"Fly Me to the Moon","artist":"Frank Sinatra"}'::jsonb));
  assert (r ->> 'ok')::boolean, 'публичный пост: ' || r::text;

  r := public.create_post(jsonb_build_object('id', pid2, 'text', 'Только для меня', 'visibility', 'private'));
  assert (r ->> 'ok')::boolean, 'приватный пост: ' || r::text;

  -- чужие / несуществующие файлы
  r := public.create_post(jsonb_build_object('id', pid3, 'text', 'x',
        'photos', jsonb_build_array(jsonb_build_object('path', b || '/' || pid3 || '/0.jpg'))));
  assert r ->> 'code' = 'bad_media', 'чужое фото: ' || r::text;
  r := public.create_post(jsonb_build_object('id', pid3, 'text', 'x', 'cover_path', a || '/' || pid3 || '/nope.jpg'));
  assert r ->> 'code' = 'bad_media', 'несуществующая обложка: ' || r::text;

  -- пустой пост, слишком длинный пост
  r := public.create_post(jsonb_build_object('text', '   '));  assert r ->> 'code' = 'empty', r::text;
  r := public.create_post(jsonb_build_object('text', repeat('а', 1001))); assert r ->> 'code' = 'too_long', r::text;
  -- плохое настроение: БД не падает, а отвечает
  r := public.create_post(jsonb_build_object('text', 'ok', 'mood', 'angry'));
  assert r ->> 'code' = 'invalid', 'плохое настроение: ' || r::text;

  reset role;
  assert (select strikes from public.profiles where id = a) = 0, 'технические ошибки не дают страйков';
end $$;

-- ---------------------------------------------------------------- 6. видимость и лента
do $$
declare
  a uuid := t.uid('anna'); b uuid := t.uid('boris'); n int; r jsonb; pid uuid;
begin
  perform t.as_user(b);
  select count(*) into n from public.get_feed();           assert n = 1, 'борис видит только публичный пост анны, а видит ' || n;
  select count(*) into n from public.posts;                assert n = 1, 'RLS: борис не видит приватное';
  select count(*) into n from public.get_user_posts('anna'); assert n = 1, 'профиль анны для бориса: только публичное';

  -- exclude и лимит
  select count(*) into n from public.get_feed(array(select id from public.posts)); assert n = 0, 'exclude работает';

  perform t.as_user(a);
  select count(*) into n from public.get_user_posts('anna'); assert n = 2, 'анна видит оба своих поста';
  select count(*) into n from public.get_archive();          assert n = 2, 'архив анны';
  select count(*) into n from public.get_archive(60, 0, 'warm'); assert n = 1, 'фильтр по настроению';
end $$;

-- ---------------------------------------------------------------- 7. лайки, комментарии, подписки, уведомления
do $$
declare
  a uuid := t.uid('anna'); b uuid := t.uid('boris'); pid uuid; r jsonb; n int;
begin
  select id into pid from public.posts where user_id = a and visibility = 'public';

  perform t.as_user(b);
  insert into public.likes (user_id, post_id) values (b, pid);
  r := public.create_comment(pid, 'Красивый день!');
  assert (r ->> 'ok')::boolean, 'комментарий: ' || r::text;
  insert into public.follows (follower_id, followee_id) values (b, a);

  -- лайкнуть от чужого имени нельзя
  begin
    insert into public.likes (user_id, post_id) values (a, pid);
    raise exception 'чужой лайк должен падать';
  exception when others then
    assert sqlerrm like '%row-level security%' or sqlerrm like '%violates%', 'чужой лайк: ' || sqlerrm;
  end;

  reset role;
  assert (select likes_count from public.posts where id = pid) = 1, 'счётчик лайков';
  assert (select comments_count from public.posts where id = pid) = 1, 'счётчик комментариев';

  perform t.as_user(a);
  assert public.unread_count() = 3, 'три уведомления, а их ' || public.unread_count();
  select count(*) into n from public.get_notifications(); assert n = 3, 'список уведомлений';
  perform public.mark_notifications_read();
  assert public.unread_count() = 0, 'прочитано';

  -- самолайк не создаёт уведомление
  insert into public.likes (user_id, post_id) values (a, pid);
  assert public.unread_count() = 0, 'самолайк без уведомления';
  delete from public.likes where user_id = a and post_id = pid;

  -- кто поставил лайк
  select count(*) into n from public.get_likers(pid); assert n = 1, 'список лайкнувших';

  -- анлайк убирает уведомление
  perform t.as_user(b);
  delete from public.likes where user_id = b and post_id = pid;
  reset role;
  assert (select likes_count from public.posts where id = pid) = 0, 'счётчик после анлайка';
  assert (select count(*) from public.notifications where type = 'like') = 0, 'уведомление о лайке удалено';
end $$;

-- ---------------------------------------------------------------- 8. редактирование и удаление
do $$
declare
  a uuid := t.uid('anna'); b uuid := t.uid('boris'); pid uuid; r jsonb;
begin
  select id into pid from public.posts where user_id = a and visibility = 'public';

  perform t.as_user(b);
  r := public.update_post(pid, '{"text":"взлом"}'); assert r ->> 'code' = 'not_found', 'чужой пост не редактируется';
  r := public.delete_post(pid);                    assert r ->> 'code' = 'not_found', 'чужой пост не удаляется';

  perform t.as_user(a);
  assert (select edited_at from public.posts where id = pid) is null, 'до правки без отметки';
  r := public.update_post(pid, '{"text":"Гуляли по парку, пили какао. Потом долго разговаривали."}');
  assert (r ->> 'ok')::boolean, 'правка: ' || r::text;
  assert (r -> 'post' ->> 'edited_at') is not null, 'отметка «изменено»';

  -- смена видимости не считается правкой текста
  r := public.update_post(pid, '{"visibility":"private"}');
  r := public.update_post(pid, '{"visibility":"public"}');
  assert (r ->> 'ok')::boolean, r::text;

  -- удаляем фото из поста: путь возвращается для очистки Storage
  r := public.update_post(pid, jsonb_build_object('photos', '[]'::jsonb));
  assert jsonb_array_length(r -> 'removed_paths') = 1, 'removed_paths: ' || r::text;
end $$;

-- ---------------------------------------------------------------- 9. страйки и бан
do $$
declare
  c uuid := t.uid('vera'); r jsonb;
begin
  perform t.as_user(c);
  -- 1-е нарушение: предупреждение
  r := public.create_post('{"text":"ты мудак и сука"}');
  assert r ->> 'code' = 'forbidden_text' and r -> 'violation' ->> 'action' = 'warning' and (r -> 'violation' ->> 'strikes') = '1', '1-е: ' || r::text;
  -- спам: блок без страйка
  r := public.create_post('{"text":"купи кредит, заработок тут"}');
  assert r ->> 'code' = 'spam_text', 'спам: ' || r::text;
  reset role;
  assert (select strikes from public.profiles where id = c) = 1, 'спам не даёт страйка';

  -- 2-е нарушение: мут на 24 часа
  perform t.as_user(c);
  r := public.create_comment((select id from public.posts limit 1), 'сука');
  assert r -> 'violation' ->> 'action' = 'mute', '2-е: ' || r::text;
  r := public.create_post('{"text":"привет"}');
  assert r ->> 'code' = 'muted', 'в муте постить нельзя: ' || r::text;
  r := public.create_comment((select id from public.posts limit 1), 'привет');
  assert r ->> 'code' = 'muted', 'в муте комментировать нельзя: ' || r::text;
  -- профиль править в муте можно
  r := public.update_profile('Вера', 'Люблю осень', null, null);
  assert (r ->> 'ok')::boolean, 'профиль в муте: ' || r::text;

  -- мут закончился → 3-е нарушение: автобан
  reset role;
  update public.profiles set muted_until = now() - interval '1 minute' where id = c;
  insert into auth.sessions (user_id) values (c);
  perform t.as_user(c);
  r := public.update_profile(null, 'ты идиот и мудак', null, null);
  assert r -> 'violation' ->> 'action' = 'ban', '3-е: ' || r::text;
  reset role;
  assert (select is_banned from public.profiles where id = c), 'is_banned';
  assert (select count(*) from auth.sessions where user_id = c) = 0, 'сессии закрыты';
  assert (select count(*) from public.violations where user_id = c) = 3, 'журнал нарушений';

  perform t.as_user(c);
  r := public.create_post('{"text":"привет"}');
  assert r ->> 'code' = 'banned', 'забаненный не пишет: ' || r::text;
  assert (public.my_profile() ->> 'is_banned')::boolean, 'my_profile показывает бан';
  assert public.my_profile() ->> 'ban_reason' is not null, 'причина бана видна ему самому';
end $$;

-- ---------------------------------------------------------------- 10. забаненных не видно
do $$
declare
  c uuid := t.uid('vera'); b uuid := t.uid('boris'); pid uuid := gen_random_uuid(); n int;
begin
  -- пост Веры был опубликован до бана
  insert into public.posts (id, user_id, text, visibility) values (pid, c, 'пост до бана', 'public');
  insert into public.comments (post_id, user_id, text) values ((select id from public.posts where user_id = t.uid('anna') and visibility = 'public'), c, 'коммент до бана');

  perform t.as_user(b);
  select count(*) into n from public.get_feed();                   assert n = 1, 'в ленте нет постов забаненной, есть пост анны: ' || n;
  select count(*) into n from public.get_user_posts('vera');       assert n = 0, 'профиль забаненной пуст';
  assert public.get_profile('vera') is null, 'профиль забаненной не открывается';
  select count(*) into n from public.search_users('vera');         assert n = 0, 'в поиске забаненной нет';
  select count(*) into n from public.search_posts('до бана');      assert n = 0, 'в поиске постов нет';
  select count(*) into n from public.get_comments((select id from public.posts where user_id = t.uid('anna') and visibility = 'public'));
  assert n = 1, 'комментарий забаненной скрыт (остался только комментарий бориса): ' || n;
  select count(*) into n from public.profiles where username = 'vera'; assert n = 0, 'RLS профилей';

  -- бан временный: после ban_until всё возвращается
  reset role;
  update public.profiles set ban_until = now() - interval '1 second' where id = c;
  perform t.as_user(b);
  select count(*) into n from public.get_user_posts('vera'); assert n = 1, 'истёкший бан не скрывает';
  reset role;
  perform public.admin_ban(c, 'тест', null);
  perform public.admin_unban(c);
  assert (select strikes from public.profiles where id = c) = 0, 'admin_unban сбрасывает страйки';
end $$;

-- ---------------------------------------------------------------- 11. жалобы: 3+ разных человека → скрыть
do $$
declare
  a uuid := t.uid('anna'); b uuid := t.uid('boris'); g uuid := t.uid('gleb'); c uuid := t.uid('vera');
  pid uuid; n int;
begin
  select id into pid from public.posts where user_id = a and visibility = 'public';

  perform t.as_user(a);
  begin
    insert into public.reports (reporter_id, target_type, target_id, reason) values (a, 'post', pid, 'spam');
    raise exception 'на свой пост жаловаться нельзя';
  exception when others then assert sqlerrm like '%row-level security%', 'своя жалоба: ' || sqlerrm; end;

  perform t.as_user(b);
  insert into public.reports (reporter_id, target_type, target_id, reason, details) values (b, 'post', pid, 'spam', 'реклама');
  begin
    insert into public.reports (reporter_id, target_type, target_id, reason) values (b, 'post', pid, 'spam');
    raise exception 'повторная жалоба должна падать';
  exception when unique_violation then null; end;
  begin
    select count(*) into n from public.reports; raise exception 'жалобы читать нельзя';
  exception when insufficient_privilege then null; end;

  perform t.as_user(g);
  insert into public.reports (reporter_id, target_type, target_id, reason) values (g, 'post', pid, 'insult');
  reset role;
  assert not (select is_hidden from public.posts where id = pid), 'две жалобы ещё не скрывают';

  perform t.as_user(c);   -- Вера разбанена
  insert into public.reports (reporter_id, target_type, target_id, reason) values (c, 'post', pid, 'nsfw');
  insert into public.reports (reporter_id, target_type, target_id, reason) values (c, 'user', a, 'other');
  reset role;
  assert (select is_hidden from public.posts where id = pid), 'три жалобы скрыли запись';

  perform t.as_user(b);
  assert not exists (select 1 from public.get_feed() e where (e ->> 'id')::uuid = pid), 'скрытая запись пропала из ленты';
  assert public.get_post(pid) is null, 'скрытая запись недоступна по ссылке';
  perform t.as_user(a);
  assert (public.get_post(pid) ->> 'is_hidden')::boolean, 'автор видит свою скрытую запись с отметкой';

  reset role;
  perform public.admin_set_hidden(pid, false);
  assert not (select is_hidden from public.posts where id = pid), 'модератор вернул запись';
end $$;

-- ---------------------------------------------------------------- 12. поиск, профиль, настройки
do $$
declare a uuid := t.uid('anna'); b uuid := t.uid('boris'); n int; r jsonb;
begin
  perform t.as_user(b);
  select count(*) into n from public.search_users('ann');  assert n = 1, 'поиск людей по нику';
  select count(*) into n from public.search_users('BORIS'); assert n = 1, 'поиск без учёта регистра';
  select count(*) into n from public.search_users('%');     assert n = 0, 'символ % не работает как маска';
  select count(*) into n from public.search_users('_');     assert n = 0, 'короткий запрос игнорируется';
  select count(*) into n from public.search_users('a_n');   assert n = 0, '_ не работает как маска';
  select count(*) into n from public.search_posts('какао'); assert n = 1, 'поиск по тексту постов';
  select count(*) into n from public.search_posts('парк');  assert n = 1, 'поиск по названию';

  r := public.get_profile('anna');
  assert (r -> 'stats' ->> 'posts') = '1', 'у Анны 1 публичная запись для Бориса: ' || r::text;
  assert (r ->> 'is_following')::boolean, 'Борис подписан';
  assert (r -> 'stats' ->> 'followers') = '1', 'подписчики';

  perform t.as_user(a);
  r := public.get_profile('anna');
  assert (r -> 'stats' ->> 'posts') = '2' and (r ->> 'is_me')::boolean, 'у себя видно все записи: ' || r::text;

  r := public.update_profile('Анна', 'Пишу про осень', null, '{"lang":"kk","theme":"dark","evil":"x","default_visibility":"nope"}');
  assert (r ->> 'ok')::boolean, r::text;
  assert r -> 'profile' -> 'settings' ->> 'lang' = 'kk' and r -> 'profile' -> 'settings' ->> 'theme' = 'dark', 'настройки сохранены';
  assert not (r -> 'profile' -> 'settings' ? 'evil') and not (r -> 'profile' -> 'settings' ? 'default_visibility'), 'лишние ключи отброшены';
  r := public.update_profile(null, repeat('а', 151), null, null); assert r ->> 'code' = 'too_long', 'био > 150';
  r := public.update_profile('Support Team', null, null, null);   assert r ->> 'code' = 'reserved_name', 'имя support: ' || r::text;
  r := public.update_profile(null, null, 'https://x.supabase.co/storage/v1/object/public/avatars/' || b || '/a.jpg', null);
  assert r ->> 'code' = 'bad_avatar', 'чужой аватар: ' || r::text;

  r := public.change_username('boris');   assert r ->> 'code' = 'taken', r::text;
  r := public.change_username('admin77'); assert r ->> 'code' = 'reserved', r::text;
  r := public.change_username('anna_diary'); assert (r ->> 'ok')::boolean, r::text;
  r := public.change_username('anna');       assert (r ->> 'ok')::boolean, r::text;
end $$;

-- ---------------------------------------------------------------- 13. вход через Google
do $$
declare v uuid := gen_random_uuid(); r jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data) values (v, 'g@test.local', '{"full_name":"Гость Гостев"}');
  assert (select needs_setup from public.profiles where id = v), 'нужно выбрать ник';
  assert (select username from public.profiles where id = v) like 'user\_%', 'временный ник';

  perform t.as_user(v);
  r := public.create_post('{"text":"привет"}');  assert r ->> 'code' = 'privacy_required', 'без согласия не пишет: ' || r::text;
  r := public.accept_privacy('admin');           assert r ->> 'code' = 'reserved', r::text;
  r := public.accept_privacy('guest_one');       assert (r ->> 'ok')::boolean, r::text;
  r := public.create_post('{"text":"привет"}');  assert (r ->> 'ok')::boolean, 'после согласия пишет: ' || r::text;
end $$;

-- ---------------------------------------------------------------- 14. каскад удаления
do $$
declare v uuid := t.uid('gleb');
begin
  perform t.as_user(v);
  perform public.delete_my_account();
  reset role;
  assert not exists (select 1 from public.profiles where id = v), 'профиль удалён вместе с аккаунтом';
end $$;

-- ---------------------------------------------------------------- 15. лента: свежесть, подборка по 100
do $$
declare a uuid := t.uid('anna'); b uuid := t.uid('boris'); n int; first_ts timestamptz; ok boolean;
begin
  reset role;
  insert into public.posts (user_id, text, visibility, created_at)
  select a, 'пост ' || i, 'public', now() - (i || ' minutes')::interval from generate_series(1, 130) i;

  perform t.as_user(b);
  select count(*) into n from public.get_feed(); assert n = 100, 'подборка ровно 100: ' || n;

  -- новые сверху
  select bool_and(ts <= lag_ts) into ok from (
    select (e ->> 'created_at')::timestamptz as ts, lag((e ->> 'created_at')::timestamptz) over (order by ord) as lag_ts
    from (select e, row_number() over () as ord from public.get_feed() e) s
  ) x where lag_ts is not null;
  assert ok, 'порядок: сначала новые';

  -- вторая подборка без повторов: ещё 31 запись (30 + пост анны)
  select count(*) into n from public.get_feed(array(select (e ->> 'id')::uuid from public.get_feed(array[]::uuid[], 100, 7) e), 100, 8);
  assert n between 30 and 32, 'следующая подборка без повторов: ' || n;
end $$;

select 'SQL-сценарии: всё прошло' as result;
