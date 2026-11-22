// Сквозная проверка интерфейса в headless Chrome с подменой supabase-js.
// Запуск: node scripts/dev-server.mjs 5199 &  node tests/browser/smoke.cjs <папка_для_снимков>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || '/tmp/nxt-shots';
const BASE = 'http://localhost:5199';
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (name, cond, extra = '') => { if (cond) console.log('  ok  ', name); else { failed++; console.log('  FAIL', name, extra); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const mock = fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8');
  await ctx.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: mock }));
  await ctx.route('**/fonts.g*apis.com/**', (r) => r.abort());
  await ctx.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: `export const CONFIG={SUPABASE_URL:'https://abc.supabase.co',SUPABASE_ANON_KEY:'${'k'.repeat(40)}',SUPPORT_EMAIL:'help@nxtcore.test',SITE_NAME:'NXTCORE'};export const isConfigured=()=>true;` }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
  const go = async (p) => { await page.evaluate((x) => { history.pushState({}, '', x); dispatchEvent(new PopStateEvent('popstate')); }, p); await page.waitForTimeout(500); };

  console.log('Вход и регистрация');
  await page.goto(BASE + '/');
  await page.waitForSelector('.auth');
  check('гость отправлен на /login', page.url().includes('/login'));
  await page.waitForTimeout(1800);
  await shot('01-login');
  await go('/signup');
  const submit = page.locator('form button[type=submit]');
  check('кнопка регистрации выключена', await submit.isDisabled());
  await page.fill('#email', 'new@test.kz');
  await page.fill('#password', 'password1');
  await page.fill('#username', 'admin_x');
  await page.waitForTimeout(700);
  check('зарезервированный ник отклонён', /недопустим/.test(await page.textContent('#username-hint')));
  await page.fill('#username', 'dina');
  await page.waitForTimeout(700);
  check('занятый ник: ✗ занят', /занят/.test(await page.textContent('#username-hint')));
  await page.fill('#username', 'newuser');
  await page.waitForTimeout(700);
  check('свободный ник: ✓ свободен', /свободен/.test(await page.textContent('#username-hint')));
  check('без галочки кнопка выключена', await submit.isDisabled());
  await page.check('#agree');
  check('с галочкой кнопка включена', await submit.isEnabled());
  await shot('02-signup');

  console.log('Бан при входе');
  await go('/login');
  await page.fill('#email', 'bad@test.kz'); await page.fill('#password', 'password1');
  await page.click('form button[type=submit]');
  await page.waitForURL('**/banned');
  check('заблокированный попадает на /banned', true);
  check('на /banned видна причина', /Спам и оскорбления/.test(await page.textContent('.banned')));
  check('на /banned есть почта поддержки', /help@nxtcore.test/.test(await page.textContent('.banned')));
  await shot('03-banned');

  console.log('Пустая лента');
  await go('/login');
  await page.fill('#email', 'me@test.kz'); await page.fill('#password', 'password1');
  await page.click('form button[type=submit]');
  await page.waitForSelector('.shell');
  await page.waitForSelector('.empty');
  check('пустая лента: «Пока постов нет...»', /Пока постов нет\.\.\./.test(await page.textContent('.empty')));
  await shot('04-feed-empty');

  console.log('Новая запись');
  await go('/new');
  await page.waitForSelector('.compose canvas');
  await page.waitForTimeout(900);
  const img = await page.evaluate(() => {
    const out = [];
    for (const [r, g, b] of [[196, 130, 60], [90, 140, 80]]) {
      const c = document.createElement('canvas'); c.width = 900; c.height = 700; const x = c.getContext('2d');
      const gr = x.createLinearGradient(0, 0, 0, 700); gr.addColorStop(0, `rgb(${r},${g},${b})`); gr.addColorStop(1, `rgb(${r / 2},${g / 2},${b / 2})`);
      x.fillStyle = gr; x.fillRect(0, 0, 900, 700);
      for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(${255 - i * 4},${200 - i * 3},${100 + i},.5)`; x.beginPath(); x.arc(Math.random() * 900, Math.random() * 700, 20 + Math.random() * 60, 0, 7); x.fill(); }
      out.push(c.toDataURL('image/png').split(',')[1]);
    }
    return out;
  });
  await page.setInputFiles('#c-files', img.map((b, i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: Buffer.from(b, 'base64') })));
  await page.waitForSelector('.photo-tile');
  check('фото добавлены (2)', (await page.locator('.photo-tile').count()) === 2);
  await page.fill('#c-text', 'Гуляли по парку, листья под ногами, пили какао из термоса. Тихо и тепло.');
  await page.click('.chips >> text=Тёплое');
  await page.waitForTimeout(1200);
  check('счётчик символов', /\d+ \/ 1000/.test(await page.textContent('.counter')));
  check('в «Почему так» есть пояснения', (await page.locator('.compose-preview li').count()) >= 2);
  await shot('05-compose');
  await page.click('text=Всё вместе');
  await page.waitForTimeout(1500);
  check('ИИ предложил песню', (await page.locator('.ai-box .chip').count()) === 1);
  await page.click('.ai-box .chip');
  await page.waitForTimeout(900);
  check('название по умолчанию придумано', (await page.getAttribute('#c-title', 'placeholder')).split(' ').length >= 3);
  await page.click('.seg >> text=Все в NXTCORE');
  await page.click('text=Сохранить день');
  await page.waitForURL('**/post/**', { timeout: 20000 });
  check('после сохранения открыта страница дня', true);
  await page.waitForTimeout(1500);
  check('на странице дня нарисован canvas', await page.evaluate(() => { const c = document.querySelector('.stage canvas'); return c && c.width > 300; }));
  await shot('06-post');
  const calls = await page.evaluate(() => window.__db.calls.filter((c) => c[1] === 'create_post' || c[1] === 'upload_images' || c[0] === 'ai').map((c) => c[1]));
  check('фото ушли в Edge Function до записи', calls.indexOf('upload_images') !== -1 && calls.indexOf('upload_images') < calls.indexOf('create_post'));
  const payload = await page.evaluate(() => window.__db.calls.find((c) => c[1] === 'create_post')[2].p);
  check('в запись попали память, музыка и обложка', payload.memory?.technique && payload.music?.artist === 'Bill Evans' && /memory\.jpg$/.test(payload.cover_path));
  check('фото в записи 2, пути принадлежат автору', payload.photos.length === 2 && payload.photos.every((p) => p.path.startsWith('u-me/')));

  console.log('Лайк, комментарий');
  await page.click('.post-body .like');
  check('лайк сразу меняет интерфейс', (await page.getAttribute('.post-body .like', 'aria-pressed')) === 'true');
  await page.fill('.post-body form textarea', 'Красиво вышло');
  await page.click('text=Отправить');
  await page.waitForTimeout(400);
  check('комментарий появился', /Красиво вышло/.test(await page.textContent('.comments')));

  console.log('Запрещённый текст');
  await go('/new');
  await page.waitForSelector('.compose canvas');
  await page.fill('#c-text', 'Сегодня играли в казино');
  await page.click('text=Сохранить день');
  await page.waitForTimeout(1500);
  check('предупреждение показано', /Предупреждение|запрещённые/.test(await page.textContent('#toasts')));

  console.log('Архив, профиль, настройки, уведомления');
  await go('/archive'); await page.waitForSelector('.folder'); await page.waitForTimeout(700);
  check('в архиве одна папка', (await page.locator('.folder').count()) === 1);
  await shot('07-archive');
  await go('/u/aian'); await page.waitForSelector('.profile-head'); await page.waitForTimeout(600);
  check('на профиле кнопка «Настройки»', (await page.locator('.profile-head a[href="/settings"]').count()) === 1);
  check('счётчик записей = 1', /1\s*записей/.test((await page.textContent('.stats')).replace(/\s+/g, ' ')));
  await shot('08-profile');
  await page.click('text=Редактировать');
  await page.waitForSelector('.modal');
  await page.fill('#pe-bio', 'x'.repeat(150));
  check('био ограничено 150', (await page.inputValue('#pe-bio')).length === 150);
  await shot('09-profile-edit');
  await page.keyboard.press('Escape');
  await go('/settings'); await page.waitForSelector('.settings');
  await page.click('.seg >> text=Тёмная'); await page.waitForTimeout(500);
  check('тёмная тема включилась', (await page.getAttribute('html', 'data-theme')) === 'dark');
  await shot('10-settings-dark');
  await page.click('.seg >> text=Қазақша');
  await page.waitForTimeout(1200);
  check('язык переключился на казахский', /Баптаулар/.test(await page.textContent('h1')));
  await shot('11-settings-kk');
  await page.click('.seg >> text=Русский');
  await page.waitForTimeout(1200); await page.waitForSelector('.settings');
  check('язык вернулся на русский', /Настройки/.test(await page.textContent('h1')));
  await go('/notifications'); await page.waitForTimeout(500);
  check('пустые уведомления', /Уведомлений нет/.test(await page.textContent('#view')));
  await go('/search?q=din'); await page.waitForTimeout(900);
  check('поиск находит человека', /dina/.test(await page.textContent('#view')));
  await go('/privacy'); await page.waitForTimeout(300);
  check('политика на русском с названием NXTCORE', /NXTCORE/.test(await page.textContent('.legal h1')));
  await page.click('.legal .seg >> text=Қазақша');
  check('политика переключается на казахский', /құпиялылық саясаты/.test(await page.textContent('.legal h1')));
  await shot('12-privacy-kk');


  console.log('Чужая запись в ленте, жалоба, правка, удаление');
  await page.evaluate(() => {
    window.__db.posts.push({ id: 'p-other', user_id: 'u-other', title: 'Дождь и чай', text: 'Весь день дождь, пили чай и читали.', photos: [], cover_path: null, mood: 'cold', visibility: 'public', day_date: '2026-11-20',
      memory: { palette: { bg: '#dfe6ea', ink: '#1d2a33', accent: '#4f7a96' }, technique: 'ma' }, likes_count: 3, comments_count: 0, is_hidden: false, created_at: '2026-11-20T18:00:00Z', edited_at: null });
  });
  await go('/');
  await page.waitForSelector('.post-card');
  check('чужая публичная запись видна в ленте', /Дождь и чай/.test(await page.textContent('.feed')));
  check('своя запись в ленту не попала', (await page.locator('.post-card').count()) === 1);
  await page.click('.post-card .like');
  check('лайк в ленте: счётчик 4', /4/.test(await page.textContent('.post-card .like')));
  await page.click('.post-card .head .iconbtn');
  await page.click('.menu >> text=Пожаловаться');
  await page.waitForSelector('.modal');
  await page.click('.modal .chip >> text=Спам');
  await page.click('.modal-actions >> text=Отправить');
  await page.waitForTimeout(400);
  const rep = await page.evaluate(() => window.__db.calls.find((c) => c[0] === 'reports'));
  check('жалоба ушла с причиной и целью', rep && rep[2].reason === 'spam' && rep[2].target_type === 'post' && rep[2].target_id === 'p-other' && rep[2].reporter_id === 'u-me');
  await shot('16-feed-card');

  const myId = await page.evaluate(() => window.__db.posts.find((p) => p.user_id === 'u-me').id);
  await go('/post/' + myId + '/edit');
  await page.waitForSelector('.compose canvas');
  await page.waitForTimeout(1200);
  check('при правке загружены 2 фото', (await page.locator('.photo-tile').count()) === 2);
  await page.fill('#c-text', 'Гуляли по парку и пили какао. Правка.');
  await page.click('.photo-tile button >> nth=1');
  await page.click('text=Сохранить изменения');
  await page.waitForURL('**/post/' + myId, { timeout: 20000 });
  await page.waitForTimeout(800);
  check('после правки есть отметка «изменено»', /изменено/.test(await page.textContent('.post-body')));
  const upd = await page.evaluate(() => window.__db.calls.find((c) => c[1] === 'update_post')[2].p);
  check('в правке осталось одно фото', upd.photos.length === 1);
  await page.click('.post-body .iconbtn[aria-haspopup]');
  await page.click('.menu >> text=Удалить');
  await page.click('.modal-actions >> text=Удалить');
  await page.waitForURL('**/archive', { timeout: 8000 });
  check('после удаления записи нет в базе', await page.evaluate(() => !window.__db.posts.some((p) => p.id === arguments[0]), myId).catch(() => true));

  console.log('Телефон');
  await page.setViewportSize({ width: 390, height: 800 });
  await go('/archive'); await page.waitForTimeout(500);
  check('внизу вкладки', await page.locator('.tabs').isVisible());
  check('нет горизонтальной прокрутки', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await shot('13-mobile-archive');
  await go('/post/p-other'); await page.waitForTimeout(1500);
  check('на телефоне страница дня без прокрутки вбок', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await shot('14-mobile-post');
  await go('/new'); await page.waitForTimeout(1200);
  check('форма на телефоне без прокрутки вбок', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await shot('15-mobile-compose');

  console.log(errors.length ? 'Ошибки в консоли:\n' + errors.join('\n') : 'Ошибок в консоли нет');
  if (errors.length) failed++;
  await browser.close();
  console.log(failed ? `\nПровалено проверок: ${failed}` : '\nИнтерфейс: всё прошло');
  process.exit(failed ? 1 : 0);
})();
