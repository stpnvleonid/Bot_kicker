# Локальный запуск и обновление

## 1) Первый запуск

```bash
npm install
cp .env.example .env
npm run migrate:dev
npm run dev
```

Минимум в `.env`:

```env
BOT_TOKEN=...
DATABASE_URL=file:./data/bot.sqlite
TZ=Europe/Moscow
```

## 2) Обычный запуск после правок

```bash
npm run build
npm run dev
```

## 3) Обновить локальную ветку от `main`

```bash
git fetch origin
git checkout main
git pull origin main
```

Если работаешь в отдельной ветке:

```bash
git checkout <your-branch>
git merge main
```

## 4) Быстрые проверки

```bash
npm run build
```

Ожидаемо: `tsc` без ошибок.

## 5) Остановить локальный запуск

- Если запуск из терминала: `Ctrl+C`
- Если через pm2:

```bash
pm2 stop bot-kicker
pm2 delete bot-kicker
```
