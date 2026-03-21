# Деплой на Ubuntu (код с GitHub)

Краткая инструкция: сервер Ubuntu, репозиторий на GitHub, секреты **не** в git.

**Альтернатива:** запуск в Docker — см. [DOCKER.md](DOCKER.md) (`Dockerfile`, `docker-compose.yml`: секреты и БД монтируются с хоста, не вшиваются в образ).

---

## 0. Что понадобится

- SSH-доступ к серверу (`user@IP`).
- URL репозитория GitHub (HTTPS или SSH).
- Локально или в менеджере паролей: **токен бота**, **JSON сервисного аккаунта Google** (если нужны календарь/Sheets), при необходимости готовый **`.env`**.
- При переносе с другой машины — файл **`data/bot.sqlite`** (если нужна та же БД).

---

## 1. Пакеты на сервере

```bash
sudo apt update
sudo apt install -y git build-essential
```

**Node.js 18+** (вариант через NodeSource, пример для 20.x):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v20.x или новее
```

Для нативного модуля `better-sqlite3` нужен компилятор — пакет `build-essential` уже ставит `g++` и `make`.

---

## 2. Клонирование проекта

Рекомендуемый каталог (можно свой):

```bash
sudo mkdir -p /opt/bot-kicker
sudo chown "$USER:$USER" /opt/bot-kicker
cd /opt/bot-kicker
git clone https://github.com/YOUR_USER/YOUR_REPO.git .
# или: git clone git@github.com:YOUR_USER/YOUR_REPO.git .
```

Если репозиторий приватный — настройте [SSH-ключ на GitHub](https://docs.github.com/en/authentication/connecting-to-github-with-ssh) или используйте HTTPS с токеном.

---

## 3. Секреты (с локальной машины по SSH)

**Не коммитьте** `.env` и `secrets/*.json`. Передайте их отдельно.

С **вашего ПК** (Linux/macOS/WSL; на Windows — PowerShell с OpenSSH или WinSCP):

```bash
scp .env user@SERVER_IP:/opt/bot-kicker/.env
scp secrets/calendar-service-account.json user@SERVER_IP:/opt/bot-kicker/secrets/
```

На сервере:

```bash
cd /opt/bot-kicker
chmod 600 .env
chmod 600 secrets/calendar-service-account.json
```

Если `.env` ещё нет — скопируйте шаблон и отредактируйте на сервере:

```bash
cp .env.example .env
nano .env
```

Проверьте минимум: `BOT_TOKEN`, `DATABASE_URL` (часто `file:./data/bot.sqlite`), `GOOGLE_APPLICATION_CREDENTIALS`, `TZ=Europe/Moscow`, при планере — `PLANNER_SHEET_ID` (см. `docs/PLANNER.md`).

**Перенос БД** (опционально):

```bash
scp data/bot.sqlite user@SERVER_IP:/opt/bot-kicker/data/bot.sqlite
```

На сервере: `chmod 600 data/bot.sqlite` (при необходимости).

---

## 4. Установка зависимостей и сборка

```bash
cd /opt/bot-kicker
npm ci
# или: npm install
npm run build
npm run migrate
```

Миграции нужны после первого деплоя и после каждого `git pull` с новыми файлами в `migrations/`.

---

## 5. Проверочный запуск (один раз)

```bash
export NODE_ENV=production
node dist/index.js
```

В логе должно быть что-то вроде `Bot started (polling)`. Остановка: `Ctrl+C`.

---

## 6. PM2 (рекомендуется)

Установка:

```bash
sudo npm install -g pm2
```

Запуск:

```bash
cd /opt/bot-kicker
export NODE_ENV=production
pm2 start dist/index.js --name bot-kicker --node-args="--max_old_space_size=512"
pm2 save
```

Автозапуск после перезагрузки:

```bash
pm2 startup systemd
# выполните одну строку, которую выведет pm2 (с sudo)
pm2 save
```

Полезные команды:

```bash
pm2 logs bot-kicker
pm2 restart bot-kicker
pm2 stop bot-kicker
```

---

## 7. Обновление с GitHub

```bash
cd /opt/bot-kicker
pm2 stop bot-kicker
git pull
npm ci
npm run build
npm run migrate
pm2 start bot-kicker
pm2 save
```

---

## 8. Сеть и безопасность

- Бот использует **long polling** — **входящие** порты для Telegram открывать не нужно.
- Нужен исходящий HTTPS (в т.ч. до `api.telegram.org` и Google).
- При необходимости SOCKS для Telegram см. `docs/SETUP.md` (`TELEGRAM_SOCKS_PROXY_URLS`).

---

## 9. Если что-то падает

- Логи PM2: `pm2 logs bot-kicker --lines 100`
- Проверка конфига календаря (на машине с тем же `.env`): `npm run check-calendar`
- Структура БД и миграции: см. `README.md` и `docs/SETUP.md`

---

## См. также

- [SETUP.md](SETUP.md) — переменные окружения, прокси, миграции
- [SWITCH_TO_PRODUCTION_CHAT.md](SWITCH_TO_PRODUCTION_CHAT.md) — боевой чат и топики
- [PLANNER.md](PLANNER.md) — Google Sheets и планер
