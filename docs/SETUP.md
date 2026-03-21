## Разработка и продакшен

Документ объединяет инструкции по разработке и продакшен-запуску.

---

## Требования

- Node.js 18+
- npm
- (Опционально) SQLite-клиент для просмотра `data/bot.sqlite`
- Токен бота (`BOT_TOKEN`) из BotFather

---

## Минимальная настройка `.env`

Пример (минимально необходимое):

```env
BOT_TOKEN=...                      # токен бота из BotFather
DATABASE_URL=file:./data/bot.sqlite
GOOGLE_APPLICATION_CREDENTIALS=./secrets/calendar-service-account.json
PLANNER_SHEET_ID=...              # если нужна выгрузка планера в Google Sheets
TZ=Europe/Moscow
```

### Telegram SOCKS5 (опционально)

По умолчанию бот ходит в **Telegram API напрямую** (без SOCKS). Локальный прокси из папки `proxy` включается так:

```env
TELEGRAM_SOCKS_PROXY_ENABLED=1
TELEGRAM_SOCKS_PROXY_URLS=socks5h://127.0.0.1:1080
```

Или достаточно задать только `TELEGRAM_SOCKS_PROXY_URLS` — прокси считается включённым. Несколько URL: через запятую/точку с запятой/перенос строки. В Docker без прокси в контейнере **не** указывайте `127.0.0.1` на хост (см. `docs/TROUBLESHOOTING_BOT.md`).

---

## Запуск в dev-режиме

```bash
npm install
cp .env.example .env
npm run migrate:dev
npm run dev
```

После запуска:
- бот работает через `ts-node` из `src/index.ts`;
- активны все cron-джобы и воркер очереди;
- база создаётся и мигрируется автоматически.

---

## Запуск в продакшене

### Вариант 1: без PM2

```bash
set NODE_ENV=production
npm start   # запускает node dist/index.js
```

Остановить:

```bash
npm stop
```

### Вариант 2: с PM2 (рекомендуется)

Первый запуск:

```bash
cd C:\Users\User\Desktop\Bot_kicker
npm run build
pm2 start dist/index.js --name bot-kicker --node-args="--max_old_space_size=512" --env production
pm2 save
```

Остановить / запустить снова:

```bash
pm2 stop bot-kicker
pm2 start bot-kicker
pm2 save
```

Обновление кода в проде:

```bash
pm2 stop bot-kicker
npm install
npm run build
npm run migrate
pm2 start bot-kicker --env production
pm2 save
```

Автозапуск PM2 после перезагрузки (Windows):

1. `pm2 save`
2. Создать задачу в Планировщике заданий Windows: запуск `pm2.cmd` с аргументом `resurrect`

---

## Миграции при обновлении кода

Запускайте `npm run migrate` (или `migrate:dev`) после `git pull` / выкладки новой версии: подхватятся все неприменённые `.sql` из `migrations/` по порядку (в т.ч. одноразовые правки схемы, например снятие legacy-колонок).

---

## Полезные команды

- `npm run dev` — запуск в dev-режиме (TypeScript напрямую)
- `npm run migrate:dev` — применить миграции к dev-БД
- `npm run build` — собрать TypeScript в `dist/`
- `npm start` — запуск собранного JS (используется в проде)
- `npm run debug-planner-export` — ручной экспорт планера (см. `docs/PLANNER.md`)

