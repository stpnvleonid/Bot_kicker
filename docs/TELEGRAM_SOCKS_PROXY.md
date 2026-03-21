# Удалённый SOCKS5 для Telegram (когда прямой доступ к `api.telegram.org` не работает)

## Важно про код

- Раньше SOCKS применялся только к **`global fetch`**. **Telegraf** ходит в API через **node-fetch** с полем **`telegram.agent`** — без него прокси к `getMe` **не использовался**.
- Сейчас при `TELEGRAM_SOCKS_PROXY_ENABLED=1` и заданных URL создаётся **SOCKS-агент и передаётся в Telegraf**.

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

   Ожидается: `Telegraf: SOCKS agent attached` → `Telegram OK @your_bot`.

## Секреты

Пароли и ключи **не коммитьте** в git; при утечке в чат — **смените ключ у провайдера**.
