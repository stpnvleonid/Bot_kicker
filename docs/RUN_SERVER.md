# Сервер: запуск и обновление

Целевая схема: Ubuntu + Docker Compose, деплой из ветки `main`.

## 1) Первый запуск на сервере

```bash
cd /opt/bot-kicker/Bot_kicker
cp .env.example .env
mkdir -p secrets data
```

Положи на сервер:

- `.env`
- `secrets/calendar-service-account.json` (если используешь Google API)
- `data/bot.sqlite` (если переносишь существующую БД)

Права:

```bash
chmod 600 .env
chmod 600 secrets/calendar-service-account.json
```

Запуск:

```bash
docker compose build
docker compose up -d
docker compose logs bot --tail 80
```

## 2) Плановое обновление с GitHub

```bash
cd /opt/bot-kicker/Bot_kicker
git fetch origin
git checkout main
git pull origin main
docker compose build
docker compose up -d
docker compose logs bot --tail 80
```

## 3) Откат к предыдущему коммиту

```bash
cd /opt/bot-kicker/Bot_kicker
git log --oneline -n 10
git checkout <commit_sha>
docker compose build
docker compose up -d
```

## 4) Полезные команды эксплуатации

```bash
docker compose ps
docker compose logs -f bot
docker compose restart bot
docker compose down
```

## 5) Частые проблемы

- Бот не отвечает: проверь `BOT_TOKEN`, сетевой доступ к `api.telegram.org`, и startup-логи.
- Ошибка `127.0.0.1:1080` в Docker: для SOCKS укажи внешний адрес прокси, не loopback.
- Нет прав на `data/bot.sqlite`: проверь владельца файла и права.
