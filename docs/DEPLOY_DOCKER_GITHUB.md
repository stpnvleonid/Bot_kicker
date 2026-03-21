# Деплой на сервер через Docker после пуша на GitHub

Пошаговая инструкция для **Ubuntu**: код уже в репозитории GitHub, запуск через **Docker Compose**. Секреты (`.env`, `secrets/`, `data/`) **не** в образе — передаются на сервер отдельно.

См. также: [DOCKER.md](DOCKER.md) (безопасность образа, перенос `docker save`).

---

## 1. Подготовка сервера

Подключись по SSH:

```bash
ssh user@IP_СЕРВЕРА
```

Установи Docker Engine и плагин Compose (официально: [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)). Кратко:

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME:-$VERSION_ID}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Проверка:

```bash
docker --version
docker compose version
```

Запуск без `sudo` (после этого выйди из SSH и зайди снова):

```bash
sudo usermod -aG docker $USER
```

---

## 2. Клонирование репозитория с GitHub

Пример каталога деплоя:

```bash
sudo mkdir -p /opt/bot-kicker
sudo chown $USER:$USER /opt/bot-kicker
cd /opt/bot-kicker
```

**Публичный репозиторий:**

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git .
```

Подставь свой логин и имя репозитория.

**Приватный репозиторий** — один из вариантов:

- **SSH:** сгенерируй ключ на сервере, добавь **Deploy key** в настройках репозитория на GitHub, затем:
  ```bash
  git clone git@github.com:YOUR_USER/YOUR_REPO.git .
  ```
- **HTTPS** с [Personal Access Token](https://github.com/settings/tokens) вместо пароля.

После клона в каталоге должны быть `Dockerfile`, `docker-compose.yml`, `package.json`, `src/`, `migrations/`.

---

## 3. Секреты и данные (с локального ПК, не из GitHub)

`.env`, JSON ключ Google и при необходимости БД **не** лежат в git — скопируй их на сервер (SCP/SFTP и т.п.).

С **локальной машины** (подставь пользователя, IP и путь к проекту):

```bash C:\Users\User\Desktop\Bot_kicker
scp /path/to/Bot_kicker/.env user@SERVER_IP:/opt/bot-kicker/.env
scp /path/to/Bot_kicker/secrets/calendar-service-account.json user@SERVER_IP:/opt/bot-kicker/secrets/
```

Если на сервере ещё нет каталогов:

```bash
ssh user@SERVER_IP "mkdir -p /opt/bot-kicker/secrets /opt/bot-kicker/data"
```

**База SQLite:** для нового сервера достаточно пустого `data/`. Чтобы перенести существующую БД:

```bash
scp /path/to/Bot_kicker/data/bot.sqlite user@SERVER_IP:/opt/bot-kicker/data/
```

На сервере ограничь права:

```bash
chmod 600 /opt/bot-kicker/.env
chmod 600 /opt/bot-kicker/secrets/calendar-service-account.json
chmod 600 /opt/bot-kicker/data/bot.sqlite 2>/dev/null || true
```

---

## 4. Проверка `.env` под Docker

В контейнере рабочая директория `/app`; в `docker-compose.yml` смонтированы:

- `./data` → `/app/data`
- `./secrets` → `/app/secrets`

В `.env` должны быть пути **относительно `/app`** (как в образе при таких томах):

```env
DATABASE_URL=file:./data/bot.sqlite
GOOGLE_APPLICATION_CREDENTIALS=./secrets/calendar-service-account.json
```

Остальное (`BOT_TOKEN`, `PLANNER_SHEET_ID`, `TZ`, …) — как в `.env.example` и на локальной машине.

**Docker Compose и символ `!`:** если `PLANNER_SHEET_RANGE` содержит `!` (как в Google Sheets `Лист!A:D`), задайте значение **в двойных кавычках**, например:  
`PLANNER_SHEET_RANGE="'Название листа'!A:O"` — иначе `docker compose` выдаст ошибку парсинга `.env`.

Проверка доступа к таблице с машины, где есть `.env` и `secrets/`:  
`npm run check-planner-sheet`

---

## 5. Сборка и запуск

```bash
cd /opt/bot-kicker
docker compose build
docker compose up -d
```

Или одной командой при первом запуске:

```bash
docker compose up -d --build
```

Логи (ожидается строка вроде `Bot started (polling)`):

```bash
docker compose logs -f bot
```

Выход из просмотра логов: `Ctrl+C` (контейнер продолжит работу).

---

## 6. Проверка в Telegram

Напиши боту `/start` или другую команду. С одним токеном должен работать **один** экземпляр бота; второй вытеснит первого.

---

## 7. Обновление после нового пуша в GitHub

```bash
cd /opt/bot-kicker
git pull
docker compose build
docker compose up -d
```

Миграции БД выполняются **при старте** приложения. При необходимости вручную:

```bash
docker compose run --rm bot node dist/db/migrate.js
docker compose up -d
```

---

## 7.1. Обновить только `.env` на сервере

Файл `.env` в git не хранится — после правок на своём ПК залей его на сервер и **пересоздай контейнер**, иначе переменные окружения не обновятся (простой `restart` подхватывает старый env).

**1. С Windows (PowerShell)** — путь к `.env`, пользователь, IP, порт SSH и ключ подставь свои; путь в кавычках, если есть `C:\`:

```powershell
scp -P ВАШ_SSH_ПОРТ -i "C:\Users\ТЫ\.ssh\id_ed25519" "C:\Users\User\Desktop\Bot_kicker\.env" admin01@IP_СЕРВЕРА:/opt/bot-kicker/.env
```

**2. На сервере по SSH:**

```bash
chmod 600 /opt/bot-kicker/.env
cd /opt/bot-kicker
docker compose up -d --force-recreate
```

`--force-recreate` создаёт контейнер заново и снова читает `env_file: .env`.

**3. Проверка:**

```bash
docker compose logs bot --tail 30
```

Если менялся только `.env` и не код образа — `docker compose build` не обязателен.

---

## 8. Полезные команды

| Действие        | Команда                      |
|-----------------|------------------------------|
| Остановить      | `docker compose down`        |
| Перезапуск бота | `docker compose restart bot` |
| Статус          | `docker compose ps`          |
| Логи (хвост)    | `docker compose logs bot --tail 100` |

Исходящий доступ в интернет на сервере нужен (Telegram API, при необходимости Google). Входящие порты для long polling **не открывают**.

---

## 9. Если что-то пошло не так

- Смотри логи: `docker compose logs bot --tail 100`.
- Ошибки сборки / модулей — попробуй: `docker compose build --no-cache`.
- `BOT_TOKEN is required` или нет файла ключа — проверь наличие `.env` и `secrets/` в `/opt/bot-kicker` и пути в `.env`.
- Права на файлы: `chmod 600` для `.env` и JSON в `secrets/`.

---

## См. также

- [DOCKER.md](DOCKER.md) — зачем не вшивать секреты в образ, `docker save` / `load`
- [DEPLOY_UBUNTU.md](DEPLOY_UBUNTU.md) — деплой без Docker (Node + PM2)
