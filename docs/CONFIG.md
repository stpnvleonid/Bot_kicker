# Настройка (`.env`) и интеграции

## Базовые переменные

```env
BOT_TOKEN=...
DATABASE_URL=file:./data/bot.sqlite
TZ=Europe/Moscow
DEBUG=0
```

## Google API (календарь/таблицы)

```env
GOOGLE_APPLICATION_CREDENTIALS=./secrets/calendar-service-account.json
PLANNER_SHEET_ID=...
PLANNER_SHEET_RANGE=Sheet1!A:D
```

Для долгов из вкладки посещаемости (опционально, иначе fallback на `PLANNER_SHEET_ID`):

```env
ATTENDANCE_SHEET_ID=...
ATTENDANCE_SHEET_TAB=Посещаемость
```

## Telegram SOCKS (опционально)

Локально:

```env
TELEGRAM_SOCKS_PROXY_ENABLED=1
TELEGRAM_SOCKS_PROXY_URLS=socks5h://127.0.0.1:1080
```

На сервере (Docker): указывай внешний SOCKS, не `127.0.0.1`.

```env
TELEGRAM_SOCKS_PROXY_ENABLED=1
TELEGRAM_SOCKS_PROXY_URLS=socks5h://USER:PASSWORD@HOST:443
```

Дополнительно:

- `TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL=1` — локальный дефолт `127.0.0.1:1080`
- `TELEGRAM_SOCKS_ALLOW_LOOPBACK=1` — разрешить loopback в особых схемах

## Предметы

Ключи предметов:

- `math`, `math_profile`, `math_base`
- `informatics`
- `physics`
- `society`
- `russian`
- `english`

Эти ключи используются для:

- `/subjects`
- маршрутизации уведомлений
- выборок `/select G=<subject>`
- долгов `/debts <subject>`

## Безопасность

- Не коммить `.env`, `secrets/*`, `data/*`
- Для прода держи секреты только на сервере
