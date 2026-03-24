# Удалённый SOCKS5 для Telegram (когда прямой доступ к `api.telegram.org` не работает)

## Важно про код

- Раньше SOCKS применялся только к **`global fetch`**. **Telegraf** ходит в API через **node-fetch** с полем **`telegram.agent`** — без него прокси к `getMe` **не использовался**.
- Сейчас при `TELEGRAM_SOCKS_PROXY_ENABLED=1` и заданных URL создаются **SOCKS-агенты** и передаются в Telegraf.
- На старте (`getMe`) бот перебирает прокси в порядке из `TELEGRAM_SOCKS_PROXY_URLS` (1, 2, 3, ...), поэтому при падении первого может подняться через следующий.
- Для `global fetch` остаётся отдельный fallback-механизм (`proxy -> direct`) только для `api.telegram.org`.

## Ошибка `ECONNREFUSED 127.0.0.1:1080`

В контейнере **`127.0.0.1` — это сам контейнер**, не VPS и не прокси на хосте. Раньше при `TELEGRAM_SOCKS_PROXY_ENABLED=1` **без** `TELEGRAM_SOCKS_PROXY_URLS` подставлялся `127.0.0.1:1080` — это неверно для Docker.

Сейчас нужно **явно** указать URL удалённого SOCKS5, например:

```env
TELEGRAM_SOCKS_PROXY_ENABLED=1
TELEGRAM_SOCKS_PROXY_URLS=socks5h://USER:PASSWORD@YOUR_PROXY_HOST:443
```

Локальная разработка на своём ПК с прокси на `127.0.0.1:1080`: задайте `TELEGRAM_SOCKS_PROXY_URLS=socks5h://127.0.0.1:1080` или `TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL=1`.

При старте бот **откажется** использовать `127.0.0.1` / `localhost` в `TELEGRAM_SOCKS_PROXY_URLS` (чтобы не повторять ошибку Docker). Для особых схем (прокси в другом контейнере в той же сети — тогда лучше имя сервиса compose, не 127.0.0.1): `TELEGRAM_SOCKS_ALLOW_LOOPBACK=1`.

## Формат URL

Поддерживается **SOCKS5** (часто на порту 443). Пример в `.env` на сервере:

```env
TELEGRAM_SOCKS_PROXY_ENABLED=1
# Один URL; логин/пароль — как выдал провайдер прокси (спецсимволы в пароле — URL-encode или заключите весь URL в кавычки в shell при ручном экспорте)
TELEGRAM_SOCKS_PROXY_URLS=socks5h://USER:PASSWORD@HOST:443
```

Если есть только **пароль** (без логина):

```env
TELEGRAM_SOCKS_PROXY_URLS=socks5h://:PASSWORD@HOST:443
```

`HOST` — IP или DNS; `socks5h` — DNS резолвится **через** прокси (предпочтительно для Telegram).

## Если не заработало

1. **Уточните тип прокси у провайдера.**  
   **MTProto / V2Ray / Trojan / только OpenVPN** — это **не** обычный SOCKS5; строка `socks5h://...` к ним не подойдёт без отдельного клиента/конвертера.
2. Проверьте с VPS (с установленным `curl` и поддержкой socks5h, или через контейнер с `curl`):

   ```bash
   curl -v --socks5-hostname HOST:443 "https://api.telegram.org"
   ```

   Должен быть TLS-handshake к Telegram, не обязательно HTTP 200 на корень.

3. После правок `.env`:

   ```bash
   docker compose up -d --force-recreate
   docker compose logs bot --tail 40
   ```

   Ожидается: `Telegraf: SOCKS agents attached (priority order)` → `getMe via SOCKS 1/N` (или 2/N, если первый упал) → `Telegram OK @your_bot`.

## Ошибка `FetchError: network timeout` / `request-timeout` к `api.telegram.org`

Это **не токен**: до Telegram просто **не доходит TCP/TLS** (блокировка датацентра, фильтр, нет маршрута). Нужен **рабочий SOCKS5** (или другой VPS/регион).

В логах при старте будет **`Telegram API: direct`** — значит в контейнере **не включён** SOCKS для Telegram.

### Что сделать на сервере

1. Откройте `.env` **в каталоге, где лежит `docker-compose.yml`** (часто `/opt/bot-kicker/Bot_kicker/.env`).
2. Добавьте (подставьте свои данные от провайдера SOCKS5):

   ```env
   TELEGRAM_SOCKS_PROXY_ENABLED=1
   TELEGRAM_SOCKS_PROXY_URLS=socks5h://USER:PASSWORD@HOST:443
   ```

3. Пересоздайте контейнер, чтобы подтянулся `.env`:

   ```bash
   docker compose up -d --force-recreate
   ```

4. Убедитесь, что переменные **попали в контейнер**:

   ```bash
   docker compose exec bot env | grep TELEGRAM
   ```

   Должны быть строки `TELEGRAM_SOCKS_PROXY_ENABLED=1` и `TELEGRAM_SOCKS_PROXY_URLS=...`.  
   Если пусто — не тот файл `.env`, нет `env_file: .env` в compose, или опечатка в имени переменной.

5. В логах после успеха: **`Telegraf: SOCKS agent attached`** и **`Telegram OK @...`**.

## Секреты

Пароли и ключи **не коммитьте** в git; при утечке в чат — **смените ключ у провайдера**.
