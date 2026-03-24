# Эксплуатация и архитектура (кратко)

## Что запускается

Один процесс бота поднимает:

- Telegram polling (Telegraf)
- cron-задачи (sync, planner, уведомления)
- воркер очереди отправки
- миграции БД при старте

## База данных

- SQLite (`data/bot.sqlite`)
- WAL-файлы `-wal` и `-shm` — нормальны при работе SQLite
- Миграции лежат в `migrations/*.sql`, применяются автоматически

Ручной запуск миграций:

```bash
npm run migrate
```

или в Docker:

```bash
docker compose run --rm bot node dist/db/migrate.js
```

## Диагностика

Основная проверка состояния:

```bash
docker compose logs bot --tail 80
```

Ожидаемый startup-порядок:

1. `Bot version`
2. `Telegram API: ...`
3. `Connecting to Telegram (getMe)...`
4. `Telegram OK @...`
5. `Bot started (polling) — registering background jobs...`
6. `Starting long polling...`

## Важные админ-команды

- `/status` — общее состояние
- `/sync_now` — ручной sync календаря
- `/events` — список событий
- `/select ...` + `/push ...` — выборка и рассылка
- `/debts <предмет>` — долги по «Посещаемости»; в `/help` у админа раздел «Долги» с кнопками предметов
- `/planner_export_now [YYYY-MM-DD]` — форс-экспорт планера

## Принцип документации

Документы в `docs/` intentionally короткие и операционные.  
Исторические детали и расширенные обсуждения — только в истории git.
