# Бот «не отвечает» в Telegram

## 1. Логи контейнера

```bash
cd /path/to/Bot_kicker   # каталог с docker-compose.yml
docker compose logs bot --tail 80
```

**Ожидаемый порядок:** `Bot version` → `Telegram API: direct` (или SOCKS) → `Connecting to Telegram` → **`Bot started (polling)`**.  
Если после `Connecting to Telegram` тишина минутами — часто **зависший коннект через SOCKS** на `127.0.0.1` внутри контейнера; с версией кода SOCKS по умолчанию **выключен** (прямой доступ). Обновите образ и пересоздайте контейнер.  
Если вместо успеха — **`Fatal: cannot launch bot after retries`** — сеть/токен/прокси.

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

См. также: [DEPLOY_DOCKER_GITHUB.md](DEPLOY_DOCKER_GITHUB.md).
