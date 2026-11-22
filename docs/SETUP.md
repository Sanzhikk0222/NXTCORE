# Настройка NXTCORE

Займёт около получаса. Понадобятся аккаунты Supabase, Google, GitHub и Vercel. Всё бесплатное.

## 1. Supabase: проект и база

1. На supabase.com создайте проект. Запомните пароль базы, он нужен только для прямого подключения.
2. Откройте **SQL Editor**, вставьте весь файл `supabase/all.sql` и нажмите **Run**. Он создаёт таблицы, политики доступа, триггеры, функции, хранилища и список стоп-слов. Выполнять нужно один раз на пустом проекте.
3. Если правите `data/banned-words.json`, запустите `npm run sql`, чтобы пересобрать `all.sql` и `js/moderation/words.js`.
4. В **Project Settings → API** скопируйте **Project URL** и ключ **anon public**.

Хранилища `avatars` (публичное), `photos` и `audio` (приватные) создаёт сам SQL. Проверьте во вкладке **Storage**, что все три на месте.

## 2. Ключи в config.js

Откройте `js/config.js` и впишите:

```js
SUPABASE_URL: 'https://ВАШ-ПРОЕКТ.supabase.co',
SUPABASE_ANON_KEY: 'публичный anon-ключ',
SUPPORT_EMAIL: 'ваша-почта@example.com',
```

Anon-ключ рассчитан на браузер. Ключ `service_role` сюда не вставляйте никогда.

## 3. Вход по почте

**Authentication → Providers → Email**: включите. Подтверждение почты можно оставить включённым: после регистрации человеку придёт письмо, сайт покажет подсказку. Для быстрой демонстрации на хакатоне подтверждение можно выключить.

**Authentication → URL Configuration**:

- Site URL: адрес сайта на Vercel (на время разработки `http://localhost:5173`).
- Redirect URLs: добавьте оба адреса, и локальный, и боевой.

В **Authentication → Policies** (или Sign In / Providers → Password) поставьте минимальную длину пароля 8.

## 4. Вход через Google

1. В Google Cloud Console откройте **APIs & Services → Credentials → Create credentials → OAuth client ID**, тип **Web application**. Если просит, сначала настройте экран согласия (**OAuth consent screen**): название NXTCORE, ваша почта.
2. В **Authorized redirect URIs** добавьте `https://ВАШ-ПРОЕКТ.supabase.co/auth/v1/callback`.
3. Скопируйте Client ID и Client secret.
4. В Supabase: **Authentication → Providers → Google**, включите, вставьте оба значения, сохраните.

Человек, вошедший через Google впервые, попадёт на экран «Почти готово»: он выберет никнейм и примет политику. Пока он этого не сделал, писать и читать записи нельзя.

## 5. Gemini и Edge Function

1. На aistudio.google.com/apikey создайте ключ.
2. Установите Supabase CLI и войдите: `supabase login`, затем `supabase link --project-ref ВАШ-ПРОЕКТ` в папке проекта.
3. Задайте секреты:

```
supabase secrets set GEMINI_API_KEY=ваш-ключ
supabase secrets set ALLOWED_ORIGIN=https://ваш-сайт.vercel.app
```

Необязательно: `GEMINI_MODELS` (список моделей через запятую, по порядку попыток) и `MODERATION_FAIL_OPEN`.

4. Задеплойте функцию: `supabase functions deploy ai`. Параметр `verify_jwt` уже включён в `supabase/config.toml`: вызывать функцию могут только вошедшие пользователи.

Если модель в цепочке недоступна или упёрлась в лимит, функция сама переходит к следующей. Фото при полном отказе ИИ не сохраняются, пока вы не включите `MODERATION_FAIL_OPEN=true`.

## 6. Запуск локально

```
node scripts/dev-server.mjs
```

Откройте http://localhost:5173. Сервер отдаёт `index.html` на любые пути без расширения, как это делает Vercel.

## 7. GitHub и Vercel

1. Создайте репозиторий на GitHub и загрузите содержимое папки проекта.
2. На vercel.com выберите **Add New → Project**, импортируйте репозиторий. Framework Preset: **Other**. Build Command и Output Directory оставьте пустыми.
3. После деплоя скопируйте адрес сайта в Supabase (Site URL и Redirect URLs) и в секрет `ALLOWED_ORIGIN`.
4. Заголовки безопасности и CSP лежат в `vercel.json`. Если подключите другой домен для Supabase или музыкальных плееров, поправьте `connect-src` и `frame-src`.

## 8. Модерация вручную

В SQL Editor работают функции для администратора (клиентам они недоступны):

```sql
-- забанить навсегда или до даты
select admin_ban('UUID-пользователя', 'Причина', null);
select admin_ban('UUID-пользователя', 'Причина', now() + interval '7 days');
-- снять бан
select admin_unban('UUID-пользователя');
-- скрыть или вернуть запись
select admin_set_hidden('UUID-записи', true);
-- что накопилось по жалобам
select target_type, target_id, count(*) from reports group by 1, 2 order by 3 desc;
```

Узнать UUID можно в таблице `profiles` по никнейму.

## 9. Что проверено и как

| Часть | Как проверена |
|---|---|
| SQL: схема, RLS, страйки, бан, лента по 100, триггеры, поиск, удаление аккаунта | на локальном Postgres 16 с имитацией Supabase, 15 сценариев |
| Edge Function: выбор модели, пауза при 401/429, проверка фото до сохранения, лимиты | на подмене Gemini и Storage |
| Движок воспоминаний | 20 проверок на семи тестовых днях |
| Интерфейс | headless Chrome, supabase-js заменён подделкой, 60+ проверок |
| Настоящий Supabase, Google OAuth, Gemini, Vercel | **вручную не прогонялись**: пройдите регистрацию, Google, загрузку фото, кнопки ИИ и бан один раз до сдачи |

## 10. Перед сдачей

- В `js/config.js` стоят ваши значения, а не заглушки.
- В Supabase указаны Site URL и Redirect URLs боевого адреса.
- Создан тестовый аккаунт, записано несколько дней с разным настроением и фото, чтобы жюри видело серию.
- Политика конфиденциальности открывается по `/privacy`, адрес поддержки настоящий.
- Если Gemini упёрся в лимит бесплатного тарифа, фото не будут сохраняться. Включите платный тариф или временно `MODERATION_FAIL_OPEN=true` на время демонстрации.
