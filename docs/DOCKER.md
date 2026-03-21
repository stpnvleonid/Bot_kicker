# Docker: сборка и запуск на сервере

## Безопасность: не вшивать `.env`, `secrets/` и `data/` в образ

**Включать секреты и БД в слои Docker-образа небезопасно:**

- Любой, кто получит образ (`docker pull`, бэкап registry, утечка tar), может **извлечь** из слоёв старые версии `.env` и файлов из `secrets/`.
- История слоёв (`docker history`, анализ tar) часто **долго хранит** удалённые файлы.
- Образы часто пушат в **публичные или полупубличные** registry.

**Правильно (как в этом репозитории):**

- Образ содержит только **код** (`dist/`), **`migrations/`** и **`node_modules`** (production).
- При запуске подключаются:
  - **`env_file: .env`** — переменные с хоста (файл не копируется в образ);
  - **том `./secrets`** — JSON ключ Google и т.п.;
  - **том `./data`** — `bot.sqlite` и WAL.

Так вы «передаёте проект на сервер» как **образ + отдельно** (по SSH) каталоги `secrets/`, `data/` и файл `.env`.

---

## Что нужно на сервере (Ubuntu)

1. [Docker Engine](https://docs.docker.com/engine/install/ubuntu/) и плагин Compose.
2. Каталог деплоя, например `/opt/bot-kicker`, с файлами:
   - `docker-compose.yml`, `Dockerfile` (из `git clone` или копией);
   - `.env` — скопировать с машины разработчика (`scp`, менеджер паролей);
   - `secrets/calendar-service-account.json` — только на сервер, `chmod 600`;
   - `data/` — при переносе существующей БД положить `bot.sqlite`, иначе пустой каталог (создастся при первом запуске).

---

## Сборка и запуск

```bash
cd /opt/bot-kicker
docker compose build
docker compose up -d
```

Логи:

```bash
docker compose logs -f bot
```

Остановка:

```bash
docker compose down
```

Обновление после `git pull`:

```bash
docker compose build --no-cache
docker compose up -d
```

Миграции выполняются **при старте процесса** внутри контейнера (`runMigrations()` в `index.ts`). При необходимости вручную:

```bash
docker compose run --rm bot node dist/db/migrate.js
```

---

## Перенос образа без registry

На машине, где собрали:

```bash
docker save bot-kicker:latest | gzip > bot-kicker-image.tar.gz
scp bot-kicker-image.tar.gz user@server:/opt/bot-kicker/
```

На сервере:

```bash
gunzip -c bot-kicker-image.tar.gz | docker load
# затем docker compose up -d без --build, если в compose указан image: bot-kicker:latest
```

Не забудьте передать **`docker-compose.yml`**, **`.env`**, **`secrets/`**, **`data/`** отдельно.

---

## Переменные в `.env`

Пути в контейнере — от **рабочей директории `/app`**:

```env
DATABASE_URL=file:./data/bot.sqlite
GOOGLE_APPLICATION_CREDENTIALS=./secrets/calendar-service-account.json
```

Тома в `docker-compose.yml` как раз монтируют хостовые `./data` и `./secrets` в эти пути.

---

## Если «очень нужно» всё в одном образе

Только для **локальных тестов** и **никогда** для публичного registry: можно временно добавить `COPY .env secrets/ data/` в `Dockerfile`. После тестов **смените все секреты** — они считаются скомпрометированными. Для продакшена так делать не рекомендуется.
