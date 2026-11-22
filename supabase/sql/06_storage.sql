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
