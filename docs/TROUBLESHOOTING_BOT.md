# Бот «не отвечает» в Telegram

## 1. Логи контейнера

```bash
cd /path/to/Bot_kicker   # каталог с docker-compose.yml
docker compose logs bot --tail 80
```

**Ожидаемый порядок:** `Bot version` → `Telegram API: direct` (или SOCKS) → `Connecting to Telegram (getMe)...` → **`Telegram OK @your_bot`** → **`Bot started (polling) — registering background jobs...`** → строки `Cron: Job2...` / `Worker: Job3...` → `Starting long polling...`.

В Telegraf 4 **`await bot.launch()` при long polling никогда не завершается** (внутри бесконечный `getUpdates`). В этом проекте после проверки токена (`getMe`) регистрируются cron/воркер, затем `launch()` запускается без `await`. Если после `getMe` тишина — сеть/токен; если есть `Telegram OK`, но нет cron — смотрите актуальный код `src/index.ts`.

Если после `Connecting to Telegram` тишина минутами — часто **зависший коннект** (SOCKS на `127.0.0.1` внутри контейнера или блокировка `api.telegram.org` на хосте). SOCKS по умолчанию **выключен**; обновите образ и пересоздайте контейнер.  
Если вместо успеха — **`Fatal: cannot connect to Telegram after retries`** — сеть/токен/прокси.

## 2. Токен

- В `.env` на сервере **`BOT_TOKEN`** тот же, что в [@BotFather](https://t.me/BotFather).
- Два процесса с одним токеном не работают одновременно — останови локальный бот / второй контейнер.

Проверка из контейнера (токен уже в окружении из `env_file`):

```bash
docker compose exec bot node -e "fetch('https://api.telegram.org/bot'+process.env.BOT_TOKEN+'/getMe').then(r=>r.json()).then(console.log).catch(console.error)"
```

В ответе должно быть `"ok":true` и `username` бота.

## 3. Сеть из контейнера

```bash
docker compose exec bot node -e "fetch('https://api.telegram.org').then(r=>console.log('ok',r.status)).catch(e=>console.error(e))"
```

Если ошибка — исходящий HTTPS с сервера/VPS блокируется или нет DNS.

## 4. SOCKS и Docker

Если в `.env` есть **`TELEGRAM_SOCKS_PROXY_URLS=socks5h://127.0.0.1:...`**, внутри контейнера **`127.0.0.1` — не хост-машина**. Поставь **`TELEGRAM_SOCKS_PROXY_ENABLED=0`** для прямого доступа к Telegram (см. `.env.example`).

## 5. Секреты и пути

Каталог **`secrets/`** с `calendar-service-account.json` должен лежать **рядом с `docker-compose.yml`**, не уровнем выше. Иначе в контейнере `/app/secrets` пусто — страдают календарь/Sheets, но не обязательно сам polling (если токен верный).

## 6. После исправления

```bash
docker compose up -d --force-recreate
docker compose logs -f bot
```

См. также: [DEPLOY_DOCKER_GITHUB.md](DEPLOY_DOCKER_GITHUB.md), [SOCKS5 для Telegram](TELEGRAM_SOCKS_PROXY.md) (Telegraf использует отдельный HTTP-агент, не только `fetch`).
