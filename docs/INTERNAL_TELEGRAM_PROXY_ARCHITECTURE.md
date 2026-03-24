# Внутренний прокси Telegram: устройство и логика

Этот документ описывает, как в проекте устроено проксирование запросов к Telegram Bot API, какие переменные окружения на это влияют и как код выбирает маршрут.

## Где находится логика

- Основная реализация: `src/net/internal-proxy.ts`
- Подключение при старте бота: `src/index.ts`

## Зачем два механизма

В проекте используются два пути HTTP-запросов:

1. **Telegraf -> node-fetch** (основной канал для Bot API: `getMe`, `getUpdates`, отправка сообщений).
2. **Глобальный `fetch`** (другие сетевые вызовы в приложении, если они есть).

Поэтому прокси подключается в двух местах:

- через `telegram.agent` в конструкторе Telegraf;
- через обёртку `enableFetchProxyFallback()` для `globalThis.fetch`.

## Точка подключения в `index.ts`

```ts
// 1) Логируем текущий режим маршрутизации Telegram-трафика.
// Это сразу видно в startup-логах и помогает отличать direct от proxy.
console.log(
  '[Startup] Telegram API:',
  isTelegramProxyEnabled()
    ? 'SOCKS proxy enabled (see TELEGRAM_SOCKS_PROXY_*)'
    : 'direct (no SOCKS; set TELEGRAM_SOCKS_PROXY_ENABLED=1 to use local proxy)'
);
// 2) Рано валидируем env, чтобы упасть с понятной причиной,
// а не ловить неочевидные ошибки в сетевом стеке позже.
validateTelegramSocksProxyEnv();
// 3) Оборачиваем global fetch для Telegram-only fallback логики
// (proxy list -> direct), не затрагивая остальные хосты.
enableFetchProxyFallback();

// 4) Отдельно строим агент для Telegraf (он использует node-fetch, не global fetch).
const telegramHttpAgent = await getTelegramNodeFetchAgent();
// 5) Передаём агент в Telegraf только если он реально создан.
const bot = new Telegraf(
  config.BOT_TOKEN,
  telegramHttpAgent ? { telegram: { agent: telegramHttpAgent } } : {}
);
```

Что это даёт:

- ранняя валидация env (`validateTelegramSocksProxyEnv`);
- проксирование Telegraf-трафика через `telegram.agent`;
- дополнительный fallback для глобального `fetch`.

## Как включается / выключается SOCKS

Функция `isTelegramProxyEnabled()`:

```ts
export function isTelegramProxyEnabled(): boolean {
  // Legacy-флаг: принудительно выключить прокси.
  if (process.env.INTERNAL_SOCKS_PROXY_ENABLED === '0') return false;
  // Текущий флаг: принудительно выключить прокси.
  if (process.env.TELEGRAM_SOCKS_PROXY_ENABLED === '0') return false;
  // Текущий флаг: принудительно включить прокси.
  if (process.env.TELEGRAM_SOCKS_PROXY_ENABLED === '1') return true;
  // Legacy-флаг: принудительно включить прокси.
  if (process.env.INTERNAL_SOCKS_PROXY_ENABLED === '1') return true;
  // Если флагов нет — включаем прокси только при наличии явных URL.
  return hasExplicitTelegramProxyUrls();
}
```

Приоритет:

1. Явный `0` выключает.
2. Явный `1` включает.
3. Если флаги не заданы — включается, только если передан URL прокси.

## Откуда берутся URL прокси

`getTelegramSocksProxyUrls()` читает:

1. `TELEGRAM_SOCKS_PROXY_URLS` (список через `,`, `;`, перенос строки),
2. fallback: `INTERNAL_SOCKS_PROXY_URL`,
3. локальный dev fallback только при `TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL=1` -> `socks5h://127.0.0.1:1080`.

Нормализация:

- если задано `host:port`, код превращает в `socks5h://host:port`.

## Валидация env и защита от Docker-ошибок

`validateTelegramSocksProxyEnv()` делает две критичные проверки:

1. Если SOCKS включён, но URL нет -> `Fatal` и `process.exit(1)`.
2. Если процесс в Docker и URL указывает на loopback (`127.0.0.1`, `localhost`) -> `Fatal` и `process.exit(1)`, если не задано `TELEGRAM_SOCKS_ALLOW_LOOPBACK=1`.

Фрагмент:

```ts
if (host && isLoopbackHostname(host)) {
  // В Docker loopback указывает на контейнер, а не на хост/VPS.
  // Поэтому прерываем старт, чтобы не уходить в бесконечные ECONNREFUSED-ретраи.
  console.error(
    '[Startup] Fatal: TELEGRAM_SOCKS_PROXY_URLS указывает на loopback (...)'
  );
  // Явно завершаем процесс — orchestration (Docker/PM2) перезапустит при необходимости.
  process.exit(1);
}
```

Это защищает от частой ошибки: в контейнере `127.0.0.1` — это сам контейнер, а не хост/VPS-прокси.

## Создание SOCKS-агентов

Кэш агентов, чтобы не создавать их на каждый запрос:

```ts
// Ключ кэша зависит от набора URL (строго по порядку).
// Если URL не менялись — переиспользуем уже созданные объекты агентов.
let cachedTelegramProxyUrlsKey: string | undefined;
// Кэш инстансов SocksProxyAgent, чтобы не выделять их на каждый запрос.
let cachedTelegramProxyAgents: SocksProxyAgent[] | null = null;
```

Динамический импорт `socks-proxy-agent`:

```ts
// Динамически импортируем пакет (ESM-only), чтобы не ломать CJS-runtime.
const mod = await import('socks-proxy-agent');
// Берём конструктор агента из модуля.
const SocksProxyAgentCtor = mod.SocksProxyAgent as unknown as typeof SocksProxyAgent;
// Для каждого URL создаём отдельный агент (нужно для перебора proxy-list).
cachedTelegramProxyAgents = urls.map((u) => new (SocksProxyAgentCtor as any)(u));
```

## Проксирование Telegraf (основной канал)

`getTelegramNodeFetchAgent()` возвращает первый агент из списка и передаёт его в:

```ts
// Telegraf будет отправлять Telegram API вызовы через этот агент.
// Без этого трафик Telegraf идёт мимо global fetch wrapper.
new Telegraf(token, { telegram: { agent } })
```

Это ключевой момент: Telegraf использует **node-fetch**, а не `global fetch`.

## Проксирование глобального fetch + fallback

`enableFetchProxyFallback()` оборачивает `globalThis.fetch`:

- проксирует только URL с hostname `api.telegram.org`;
- перебирает список SOCKS-агентов по очереди;
- при сетевых/прокси-ошибках пробует следующий;
- если все прокси упали, делает direct-запрос без `agent`.

Фрагмент:

```ts
for (const agent of proxyAgents) {
  try {
    // Подставляем конкретный proxy-agent в текущую попытку.
    const attemptInit = { ...baseInit, agent };
    // Если запрос успешен — сразу возвращаем ответ и выходим из цикла.
    return await originalFetch(urlObj, attemptInit);
  } catch (err) {
    // Запоминаем последнюю ошибку прокси.
    lastErr = err;
    // Непрокси-ошибки считаем фатальными и не маскируем fallback-ом.
    if (!isLikelyProxyNetworkError(err)) throw err;
  }
}

// Все прокси недоступны -> пробуем прямой маршрут (без agent).
const directInit = { ...baseInit, agent: undefined };
return originalFetch(urlObj, directInit).catch((e) => {
  // Если direct тоже упал — выбрасываем исходную proxy-ошибку (она более показательная).
  throw lastErr ?? e;
});
```

## Какие ошибки считаются сетевыми для fallback

`isLikelyProxyNetworkError()` считает прокси-сбоями:

- `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`,
- `socket hang up`.

Для таких ошибок разрешён переход к следующему прокси или direct fallback.

## Переменные окружения (итог)

Основные:

- `TELEGRAM_SOCKS_PROXY_ENABLED=0|1`
- `TELEGRAM_SOCKS_PROXY_URLS=socks5h://user:pass@host:port`
- `INTERNAL_SOCKS_PROXY_URL=...` (legacy fallback)

Дополнительные:

- `TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL=1` — локальный fallback на `127.0.0.1:1080`
- `TELEGRAM_SOCKS_ALLOW_LOOPBACK=1` — разрешить loopback в Docker (исключение)

## Практические сценарии

1. **Обычный сервер без прокси**
   - `TELEGRAM_SOCKS_PROXY_ENABLED=0`
   - прямой трафик к `api.telegram.org`

2. **Сервер с удалённым SOCKS5**
   - `TELEGRAM_SOCKS_PROXY_ENABLED=1`
   - `TELEGRAM_SOCKS_PROXY_URLS=socks5h://USER:PASS@PROXY_HOST:443`

3. **Локальная разработка с локальным SOCKS**
   - `TELEGRAM_SOCKS_PROXY_URLS=socks5h://127.0.0.1:1080`
   - либо `TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL=1`

## Ограничения текущего решения

- Проверка `isRunningInDocker()` эвристическая (`/.dockerenv`, env-переменные).
- Для Telegraf берётся только первый прокси-агент (без ротации внутри Telegraf-канала).
- Direct fallback реализован только в обёртке глобального `fetch`, не в самом `telegram.agent` канале Telegraf.

## Перенос на Python (шпаргалка)

Ниже — эквивалент текущей логики в Python-терминах. Это не готовый модуль "как есть", а переносимый шаблон.

### 1) Соответствие ключевых функций

- `isTelegramProxyEnabled()` -> `is_telegram_proxy_enabled()`
- `getTelegramSocksProxyUrls()` -> `get_telegram_socks_proxy_urls()`
- `validateTelegramSocksProxyEnv()` -> `validate_telegram_socks_proxy_env()`
- `getTelegramNodeFetchAgent()` -> `build_requests_proxy_config()` или `build_aiohttp_connector()`
- `enableFetchProxyFallback()` -> `telegram_request_with_proxy_fallback(...)`

### 2) Python: включение/выключение и разбор env

```python
import os
from urllib.parse import urlparse


def normalize_socks_url(raw: str | None) -> str | None:
    # Пустое значение -> нет URL.
    if not raw:
        return None
    # Тримим пробелы, чтобы корректно обработать env с отступами.
    s = raw.strip()
    if not s:
        return None
    # Совместимость с коротким форматом host:port.
    # Преобразуем в полноценный socks URL.
    if "://" not in s and ":" in s:
        return f"socks5h://{s}"
    # Уже полноценный URL.
    return s


def parse_socks_url_list(value: str | None) -> list[str]:
    # Нет переменной -> пустой список.
    if not value:
        return []
    chunks = []
    # Поддерживаем разделители как в TS: ';', ',' и перенос строки.
    for part in value.replace(";", ",").replace("\n", ",").split(","):
        # Нормализуем каждый элемент и отбрасываем пустые.
        u = normalize_socks_url(part)
        if u:
            chunks.append(u)
    return chunks


def is_proxy_enabled() -> bool:
    # Явное отключение (legacy + current).
    if os.getenv("INTERNAL_SOCKS_PROXY_ENABLED") == "0":
        return False
    if os.getenv("TELEGRAM_SOCKS_PROXY_ENABLED") == "0":
        return False
    # Явное включение (current + legacy).
    if os.getenv("TELEGRAM_SOCKS_PROXY_ENABLED") == "1":
        return True
    if os.getenv("INTERNAL_SOCKS_PROXY_ENABLED") == "1":
        return True
    # Неявный режим: включаем только если реально указан хотя бы один proxy URL.
    return bool(parse_socks_url_list(os.getenv("TELEGRAM_SOCKS_PROXY_URLS"))) or bool(
        normalize_socks_url(os.getenv("INTERNAL_SOCKS_PROXY_URL"))
    )


def get_proxy_urls() -> list[str]:
    # Приоритет 1: современная переменная со списком.
    lst = parse_socks_url_list(os.getenv("TELEGRAM_SOCKS_PROXY_URLS"))
    if lst:
        return lst
    # Приоритет 2: legacy single-url.
    single = normalize_socks_url(os.getenv("INTERNAL_SOCKS_PROXY_URL"))
    if single:
        return [single]

    # Локальный fallback допустим только по явному флагу.
    # Это защищает Docker-окружение от случайного 127.0.0.1:1080.
    default_local = os.getenv("TELEGRAM_SOCKS_PROXY_DEFAULT_LOCAL", "").lower() in {"1", "true"}
    if default_local and is_proxy_enabled():
        return ["socks5h://127.0.0.1:1080"]
    return []


def is_running_in_docker() -> bool:
    # Простейшая эвристика контейнера.
    return os.path.exists("/.dockerenv") or os.getenv("CONTAINER") == "1" or os.getenv("DOCKER_CONTAINER") == "1"


def validate_proxy_env() -> None:
    # Если прокси выключен, валидация не требуется.
    if not is_proxy_enabled():
        return
    # Достаём итоговый список URL после всех fallback.
    urls = get_proxy_urls()
    if not urls:
        # Не даём запускаться с полупустой конфигурацией.
        raise RuntimeError("SOCKS enabled, but TELEGRAM_SOCKS_PROXY_URLS is empty")

    # Ручной override для редких сценариев (sidecar / loopback proxy в контейнере).
    allow_loopback = os.getenv("TELEGRAM_SOCKS_ALLOW_LOOPBACK", "").lower() in {"1", "true"}
    # Вне Docker loopback может быть валиден (локальная разработка).
    if allow_loopback or not is_running_in_docker():
        return

    # В Docker блокируем loopback-хосты по умолчанию.
    for u in urls:
        host = (urlparse(u).hostname or "").lower()
        if host in {"127.0.0.1", "localhost", "::1"}:
            raise RuntimeError("Loopback proxy URL is forbidden in Docker")
```

### 3) Python: как подключить прокси к Telegram-клиенту

Зависит от библиотеки:

- **`python-telegram-bot`**: `request`/`proxy_url` в `ApplicationBuilder`.
- **`aiogram`**: прокси в `AiohttpSession`/`Bot`.
- Если используете `requests` напрямую: `proxies={"https": "socks5h://..."}`.

Пример идеи для `requests`:

```python
import requests


def make_session_with_proxy(proxy_url: str | None) -> requests.Session:
    # Создаём новую Session для переиспользования TCP-connections.
    s = requests.Session()
    if proxy_url:
        # Для requests указываем прокси отдельно для http/https.
        s.proxies = {"http": proxy_url, "https": proxy_url}
    # В реальном коде timeout лучше задавать в каждом request(...),
    # чтобы не полагаться на неофициальные поля Session.
    s.timeout = 30
    return s
```

### 4) Python: fallback "proxy -> direct" только для Telegram API

```python
from requests import Session
from requests.exceptions import RequestException, Timeout, ConnectionError


# Список ошибок, при которых имеет смысл переключаться на другой proxy/direct.
NETWORK_ERRORS = (Timeout, ConnectionError)


def telegram_request_with_fallback(
    method: str,
    url: str,
    *,
    json_body: dict | None = None,
    proxy_urls: list[str] | None = None,
    timeout_sec: float = 30.0,
):
    # Нормализуем список прокси (None -> []).
    proxy_urls = proxy_urls or []
    # Храним последнюю ошибку прокси для информативного исключения.
    last_err: Exception | None = None

    # 1) Пробуем все прокси по очереди (в порядке приоритета).
    for p in proxy_urls:
        try:
            # Отдельная Session на попытку; в проде можно вынести пул сессий.
            s = Session()
            s.proxies = {"http": p, "https": p}
            # Выполняем Telegram запрос через proxy.
            r = s.request(method, url, json=json_body, timeout=timeout_sec)
            # 4xx/5xx превращаем в исключение.
            r.raise_for_status()
            # Успех: возвращаем ответ немедленно.
            return r
        except NETWORK_ERRORS as e:
            # Сетевой сбой прокси -> пробуем следующий.
            last_err = e
            continue

    # 2) Все прокси исчерпаны -> fallback direct (без proxy).
    try:
        s = Session()
        r = s.request(method, url, json=json_body, timeout=timeout_sec)
        r.raise_for_status()
        return r
    except Exception as e:
        # Если direct тоже упал, выбрасываем последнюю proxy-ошибку (если была),
        # иначе текущую direct-ошибку.
        raise last_err or e
```

Комментарий по архитектуре: в TS fallback для Telegraf-канала и для глобального `fetch` разделён. В Python обычно проще централизовать все Telegram-вызовы через один адаптер (`telegram_request_with_fallback`) и уже его использовать во всех местах.

### 5) Что важно не потерять при переносе

- В Docker не использовать `127.0.0.1` для удалённого SOCKS (если только это не sidecar и вы точно понимаете маршрут).
- `socks5h` предпочтительнее `socks5`, чтобы DNS резолвился через прокси.
- Валидация env до старта polling/webhook.
- Явные логи режима: `direct` vs `proxy`.
- Ретрай `getMe` (или эквивалентного health-check запроса) до старта фоновых задач.

## Связанные документы

- `docs/TELEGRAM_SOCKS_PROXY.md` — эксплуатационные инструкции
- `docs/TROUBLESHOOTING_BOT.md` — диагностика, если бот не отвечает
