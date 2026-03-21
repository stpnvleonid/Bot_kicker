# Технический дизайн: бот календаря и уведомлений для Telegram

## 1. Обзор

Бот синхронизирует события из Google Calendar и доставляет их в Telegram:
- **Групповой чат** — по задумке: посты и напоминания в топики по предметам; **в текущей сборке отправка в группы отключена** в планировщике (см. §6.1).
- **Топики (Topics)** — маппинг предмет → ветка через `group_topics` и `/link_topic`.
- **Личные сообщения (ЛС)** — основной канал напоминаний и пушей; фильтр по выбранным предметам (`student_subjects`, `/subjects`).

Платформа: **Telegram Bot API** (Long Polling или Webhook).

---

## 2. Ограничения и особенности Telegram

| Аспект | Ограничение / особенность |
|--------|---------------------------|
| Сообщения в ЛС | Бот может писать пользователю только после того, как пользователь хотя бы раз нажал Start или написал боту. |
| Топики | Только в супергруппах (100+ участников) или при включённых топиках в группе. Параметр `message_thread_id`. |
| Длина сообщения | До 4096 символов. |
| Частота | ~30 сообщений/сек в разные чаты, лимиты на запросы к API. |
| Формат | Markdown/HTML, кнопки (InlineKeyboard), ReplyKeyboard. |
| Идентификаторы | `chat_id` (группа/канал/ЛС), `user_id` (пользователь), `message_id`, `message_thread_id` (топик). |

---

## 3. Архитектура компонентов

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TELEGRAM BOT (Node/Python)                       │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │   Polling/   │  │   Command    │  │  Scheduler   │  │  Calendar   │  │
│  │   Webhook    │  │   Handler    │  │   (Cron)     │  │   Sync      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  │
│         │                 │                 │                 │         │
│         └─────────────────┴────────┬────────┴─────────────────┘         │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                    Notification / Push Engine                       │ │
│  │  (формирование текста, выбор получателей, очередь отправки)         │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                    │                                     │
│  ┌─────────────────────────────────┼─────────────────────────────────┐   │
│  │  Telegram API Client (sendMessage, editMessage, getChat, etc.)    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
┌─────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  Google         │    │  Database            │    │  Telegram API        │
│  Calendar API   │    │  (PostgreSQL/SQLite) │    │  (HTTPS)             │
└─────────────────┘    └─────────────────────┘    └─────────────────────┘
```

---

## 4. Схема данных (БД)

### 4.1. Календарь и события

**calendar_config**
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| calendar_id | string | ID календаря в Google (email или primary) |
| name | string | Человеческое название |
| credentials_json | text/encrypted | Service Account JSON или refresh_token |
| sync_token / last_sync | string/timestamp | Для инкрементальной синхронизации |
| enabled | bool | Вкл/выкл синхронизацию |

**calendar_events**
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| calendar_config_id | FK | |
| google_event_id | string UNIQUE | id из Google Calendar API |
| title | string | |
| description | text | |
| start_at | timestamptz | |
| end_at | timestamptz | |
| raw_json | jsonb | Сырые данные для отладки |
| status | enum | active, cancelled, completed |
| created_at, updated_at | timestamptz | |

**event_groups** (связь событие ↔ группы студентов)
| Поле | Тип | Описание |
|------|-----|----------|
| event_id | FK → calendar_events | |
| group_id | FK → groups | |
| PRIMARY KEY (event_id, group_id) | |

### 4.2. Telegram и студенты

**groups**
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| name | string | Например "Поток 2024", "Группа А" |
| telegram_chat_id | bigint | chat_id группы/супергруппы |
| topic_id | int NULL | message_thread_id для топика "Календарь" (если используется один топик) |
| calendar_config_id | FK NULL | Привязка к календарю (опционально) |
| created_at, updated_at | timestamptz | |

**students**
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| telegram_user_id | bigint UNIQUE | user.id из Telegram |
| telegram_username | string NULL | @username |
| first_name, last_name | string | Из Telegram profile |
| group_ids | array/int[] или отдельная таблица student_groups | Группы, в которых состоит студент |
| notify_dm | bool | Разрешить ЛС-уведомления (по умолчанию true) |
| notify_quiet_hours_start | time NULL | Начало "тихого" окна (например 23:00) |
| notify_quiet_hours_end | time NULL | Конец (например 08:00) |
| last_dm_at | timestamptz NULL | Последняя успешная отправка в ЛС (анти-спам) |
| created_at, updated_at | timestamptz | |

**student_groups** (если группа — отдельная сущность)
| student_id | group_id | PRIMARY KEY (student_id, group_id) |

**group_topics** (топик супергруппы на предмет)
| Поле | Тип | Описание |
|------|-----|----------|
| group_id | FK → groups | |
| subject_key | string | Ключ предмета (math, physics, …) |
| topic_id | int | `message_thread_id` ветки в чате |
| UNIQUE (group_id, subject_key) | | |

**student_subjects** (какие предметы студент выбрал для ЛС — `/subjects`)
| student_id | subject_key | PRIMARY KEY (student_id, subject_key) |

**event_subjects** (предметы события; заполняется при синхронизации по title/description)
| event_id | subject_key | PRIMARY KEY (event_id, subject_key) |

**event_chat_messages** (куда и что отправили по событию)
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| event_id | FK → calendar_events | |
| chat_id | bigint | telegram chat_id |
| message_id | int | id сообщения в чате |
| thread_id | int NULL | message_thread_id (топик) |
| role | enum | main_post, reminder_24h, reminder_1h, update, cancelled (имена исторические: «24h»/«1h» соответствуют напоминаниям **за ~15 мин** и **за ~5 мин** до начала) |
| sent_at | timestamptz | |

**event_dm_log** (логи рассылки в ЛС)
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| event_id | FK | |
| student_id | FK | |
| notification_type | enum | new_event, reminder_24h, reminder_1h, update, cancelled |
| sent_at | timestamptz | |
| UNIQUE (event_id, student_id, notification_type) | | Идемпотентность |

**notification_queue** (очередь задач от Job 1 для Job 2)
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| event_id | FK → calendar_events | |
| type | enum | new_event, updated_event, cancelled_event |
| status | enum | pending, processed, failed |
| created_at, updated_at | timestamptz | |

**send_queue** (очередь отправки в Telegram, потребляет Job 3)
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| type | enum | chat, dm |
| chat_id | bigint | telegram chat_id (для ЛС = user_id) |
| message_thread_id | int NULL | топик в чате |
| text | text | |
| parse_mode | string NULL | Markdown, HTML |
| event_id | FK NULL | для записи в event_chat_messages / event_dm_log |
| student_id | FK NULL | для ЛС и dm_blocked |
| notification_type | string NULL | new_event, reminder_24h, reminder_1h, update, cancelled |
| status | enum | pending, processing, sent, failed |
| error_message | text NULL | |
| worker_id, claimed_at | string, timestamptz NULL | при нескольких воркерах |
| created_at, updated_at | timestamptz | |

### 4.3. Выборочные рассылки (ручной пуш)

**selections** (временная выборка для команды /push)
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK (или UUID) | |
| created_by_telegram_user_id | bigint | Кто создал (админ/преподаватель) |
| chat_id | bigint | Чат, где вызвана команда |
| criteria | jsonb | { "group_id": 1 } или { "event_id": 5, "filter": "not_attended" } |
| student_ids | int[] | Список student_id (заполняется при создании выборки) |
| created_at | timestamptz | TTL: удалять через 1–24 часа |

**push_log**
| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| selection_id | FK | |
| student_id | FK | |
| message_text | text | |
| sent_at | timestamptz | |
| success | bool | |

### 4.4. Планер учебных задач

**students**

- Дополнительное поле `planner_enabled` (bool/int, по умолчанию 1) — участвует ли студент в планере.

**daily_tasks**

| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| student_id | FK → students | Для кого задача |
| task_date | date | Дата в формате YYYY-MM-DD |
| idx | int | Порядковый номер задачи за день (1–6) |
| text | text | Формулировка задачи |
| status | enum | planned, completed, partly_done, cancelled |
| created_at, updated_at | timestamptz | |

**planner_sessions**

| Поле | Тип | Описание |
|------|-----|----------|
| student_id | FK → students | |
| task_date | date | Дата планирования |
| total_tasks | int | Сколько задач хотел запланировать |
| next_index | int | Какую задачу спросить следующей |
| status | enum | collecting, done |

**daily_tasks_exports**

| Поле | Тип | Описание |
|------|-----|----------|
| id | PK | |
| task_id | FK → daily_tasks | |
| exported_at | timestamptz | Когда выгружено |
| sheet_row | int NULL | Номер строки в Google Sheets (опционально) |

### 4.4. Админы и права

**admins**
| telegram_user_id | bigint PK | Список пользователей, которым разрешены /select, /push, настройка календаря |

---

## 5. Интеграция с Google Calendar

- **Библиотека**: для Node.js — `googleapis`; для Python — `google-api-python-client` + `google-auth`.
- **Авторизация**: Service Account с доступом к календарю (calendar_id) или OAuth2 (если календарь личный).
- **Метод**: `events.list` с опциями:
  - `timeMin`, `timeMax` — окно (например now - 1d до now + 30d).
  - `singleEvents: true`, `orderBy: 'startTime'`.
  - При инкрементальной синхронизации — `syncToken` (если API отдал его в предыдущем ответе).
- **Частота**: джоб раз в 1–5 минут.
- **Обработка**:
  - Для каждого события из ответа: upsert в `calendar_events` по `google_event_id`.
  - Статус `cancelled` — если в ответе `status: "cancelled"`.
  - После прохода по всем событиям за окно — пометить события, которых уже нет в окне и дата в прошлом, как `completed` (опционально).
- **Определение групп**: по названию календаря, по описанию события или по отдельному календарю на группу. Маппинг в `event_groups`: при создании/обновлении события парсить описание/название или правило (например, календарь "Group A" → group_id = 1).

---

### 5.1. Job 1: Синхронизация календаря (каждые 30 минут)

#### Назначение

Периодически забирать события из Google Calendar в заданном временном окне, сохранять/обновлять их в БД и помечать отменённые. Результат синхронизации используется другими джобами (уведомления в чат, ЛС, напоминания).

#### Триггер и расписание

- **Интервал**: каждые 30 минут (cron: `*/30 * * * *`, см. `src/index.ts`).
- **Запуск**: один экземпляр за раз (mutex/lock по ключу `calendar_sync` на время выполнения, чтобы при долгом выполнении следующий запуск не стартовал параллельно).

#### Входные данные

- Список активных календарей: выборка из `calendar_config` где `enabled = true`.
- Для каждого календаря (опционально): сохранённый `sync_token` из предыдущей успешной синхронизации — для инкрементального запроса.

#### Временное окно событий

- **timeMin**: `now - 1 день` (чтобы не потерять вчерашние события с переносом или опозданием обновления).
- **timeMax**: `now + 7 дней` (как в `calendar-sync.ts`; дальше события в запрос не попадают).
- События вне окна не запрашиваются; прошедшие можно помечать `completed` отдельным правилом (см. ниже).

#### Пошаговая логика

**Шаг 1. Подготовка**

1. Взять блокировку джоба (Redis/БД: ключ `job:calendar_sync`, TTL 25 мин).
2. Если блокировку взять не удалось — выйти (уже выполняется другой инстанс).
3. Вычислить `timeMin` и `timeMax` в ISO 8601 для текущего часового пояса (или UTC).

**Шаг 2. Цикл по календарям**

Для каждой записи в `calendar_config` с `enabled = true`:

1. Восстановить клиент Google Calendar (по `credentials_json`).
2. Определить параметры запроса:
   - `calendarId`: из `calendar_config.calendar_id`.
   - `timeMin`, `timeMax`: общее окно.
   - `singleEvents: true`, `orderBy: 'startTime'`.
   - Если есть `sync_token` и не первая синхронизация — передать `syncToken` (тогда `timeMin`/`timeMax` игнорируются в инкрементальном запросе).
3. Вызвать `events.list(...)`.
4. Если ответ содержит `nextPageToken` — повторять запрос с `pageToken`, пока страницы не кончатся.
5. Сохранить в конце ответа новый `nextSyncToken` в `calendar_config.sync_token` (и обновить `last_sync = now()`).

**Шаг 3. Обработка каждого события из ответа**

Для каждого элемента в `items`:

1. **Отменённые**: если `event.status === 'cancelled'`:
   - Найти в БД запись по `calendar_config_id` + `google_event_id` (в API это часто `id` с суффиксом).
   - Если запись есть — обновить `status = 'cancelled'`, `updated_at = now()`. Дальше триггерить логику «отмена» (уведомления в чат/ЛС) — см. раздел 6.5.
   - Если записи нет — ничего не писать в `calendar_events` (отменённое событие могло быть создано до начала окна синхронизации).
   - Перейти к следующему событию.

2. **Время начала**: из `event.start.dateTime` (или `event.start.date` для whole-day). Привести к UTC и сохранить в переменные `start_at`, `end_at` (аналогично из `event.end`).

3. **Upsert в `calendar_events`**:
   - Ключ: `(calendar_config_id, google_event_id)`. `google_event_id` = `event.id` из API.
   - Извлечь: `title` = `event.summary` (или пустая строка), `description` = `event.description` (или null), `start_at`, `end_at`, `raw_json` = весь объект события (для отладки).
   - Если записи не было: `INSERT` с `status = 'active'`.
   - Если запись была:
     - Обновить поля выше и `updated_at`.
     - Если изменились `start_at`, `end_at` или `title` — считать событие «обновлённым» для последующей отправки уведомлений об изменении (флаг или отдельная очередь).
   - После upsert получить `event_id` (PK).

4. **Связь с группами (`event_groups`)**:
   - По правилам проекта определить список `group_id`, к которым относится событие (например, один календарь = одна группа; или парсинг описания/названия).
   - Синхронизировать строки в `event_groups`: для данного `event_id` должны быть ровно эти `group_id`. Удалить лишние связи, добавить недостающие.

**Шаг 4. Пометить завершённые события (опционально)**

- Выполнить обновление в БД: события из `calendar_events` с `status = 'active'` и `end_at < now() - 1 день` установить `status = 'completed'`.
- Можно делать не каждый запуск, а раз в сутки (отдельный джоб или флаг).

**Шаг 5. Завершение**

1. Снять блокировку джоба.
2. Записать в лог: количество обработанных календарей, событий (новых/обновлённых/отменённых), ошибки (если были).
3. При наличии новых или изменённых событий — передать их в Notification Engine (очередь задач): «отправить в чат», «дублировать в ЛС», при отмене/изменении — «уведомить об обновлении/отмене».

#### Обработка ошибок

- **Ошибка авторизации (401/403)**: залогировать, пометить календарь как требующий проверки (например, флаг `sync_error`), не падать весь джоб.
- **Rate limit (429)**: выполнить exponential backoff и повторить запрос (ограниченное число попыток).
- **Таймаут/сеть**: повторить один раз; при повторной ошибке — выйти и оставить блокировку снятой по TTL.
- **Частичный сбой**: если один календарь упал, продолжать синхронизацию остальных.

#### Идемпотентность

- Синхронизация по одному и тому же окну и тому же `syncToken` не должна дублировать уведомления: новые посты в чат и ЛС создаются только при появлении новой записи в `calendar_events` или изменении существующей (сравнение по хэшу полей или флагу «требует уведомления»). Notification Engine ориентируется на факт «событие создано/обновлено» и проверяет `event_chat_messages` / `event_dm_log`, чтобы не слать повторно.

#### Псевдокод

```text
function runCalendarSyncJob():
  if not acquireLock("job:calendar_sync", ttlMinutes: 25): return
  try:
    timeMin = now() - 1 day
    timeMax = now() + 60 days
    for config in db.query("SELECT * FROM calendar_config WHERE enabled = true"):
      client = buildGoogleCalendarClient(config.credentials_json)
      params = { timeMin, timeMax, singleEvents: true, orderBy: 'startTime' }
      if config.sync_token: params.syncToken = config.sync_token
      pageToken = null
      do:
        response = client.events.list(config.calendar_id, params)
        for event in response.items:
          if event.status == 'cancelled':
            handleCancelledEvent(config.id, event.id); continue
          start_at, end_at = parseEventTimes(event)
          row = upsertCalendarEvent(config.id, event, start_at, end_at)
          syncEventGroups(row.event_id, config.id, event)
        pageToken = response.nextPageToken
        if pageToken: params.pageToken = pageToken
      while pageToken
      if response.nextSyncToken:
        db.update("calendar_config", { sync_token: response.nextSyncToken, last_sync: now() }, config.id)
    markPastEventsCompleted()
    enqueueNewOrUpdatedEventsForNotifications()
  finally:
    releaseLock("job:calendar_sync")
```

#### Зависимости

- **БД**: `calendar_config`, `calendar_events`, `event_groups`.
- **Внешний API**: Google Calendar API v3, авторизация через credentials из конфига.
- **Выход**: обновлённое состояние БД; очередь задач для Notification Engine по новым/изменённым/отменённым событиям.

---

### 5.2. Job 2: Планировщик уведомлений (каждую минуту)

#### Назначение

Определять, какие уведомления нужно отправить «прямо сейчас», и ставить задачи в очередь отправки: напоминания за 15 минут и за 5 минут до события (в чат и в ЛС), а также обработка очереди «новое/обновлённое/отменённое событие», сформированной Job 1, и формирование отчётов по посещаемости.

#### Триггер и расписание

- **Интервал**: каждую минуту (cron: `* * * * *`).
- **Блокировка**: mutex `job:notification_scheduler`, TTL 8 мин, чтобы не запускать два экземпляра.

#### Входные данные

- Текущее время `now()` в том же часовом поясе, что и события (или UTC с учётом таймзоны календаря).
- Таблицы: `calendar_events` (status = active), `event_chat_messages`, `event_dm_log`, `event_groups`, `groups`, `students`, `student_groups`.
- Очередь входящих задач от Job 1 (новая/обновлённая/отменённая запись события) — таблица `notification_queue` или аналогичная.

#### Окна для напоминаний

- **Напоминание за 15 минут**: события, у которых `start_at` в интервале `[now + 14 мин, now + 16 мин]`.
- **Напоминание за 5 минут**: события, у которых `start_at` в интервале `[now + 4 мин, now + 6 мин]`.

#### Пошаговая логика

**Шаг 1. Захват блокировки**

1. Попытаться взять блокировку `job:notification_scheduler` (TTL 8 мин).
2. Если не удалось — выйти.

**Шаг 2. Обработка очереди от Job 1 (новые/обновлённые/отменённые события)**

1. Выбрать из `notification_queue` записи со статусом `pending`, батч до 50.
2. Для каждой записи (актуальная логика `notification-scheduler.ts`):
   - **Тип «new_event» / «updated_event»**: задачи **не ставятся в `send_queue`** — запись только помечается `processed` (мгновенная рассылка при появлении/изменении события отключена; уведомления идут напоминаниями за 15 и 5 минут).
   - **Тип «cancelled_event»**: формируются задачи в `send_queue` на уведомление об отмене; **в ЛС** — тем, у кого уже была запись в `event_dm_log` по этому событию (и ещё не было `cancelled`), с учётом тихих часов. Попытки поставить задачи «в чат» в коде есть, но см. примечание ниже про `enqueueSend`.
3. Пометить обработанную запись в `notification_queue` как `processed` (или `failed` при ошибке).

**Примечание:** в планировщике `enqueueSend('chat', …)` сейчас **не ставит задачи в очередь** (временно отключена отправка в группы; в проде уходят **только ЛС**). Документированное ниже поведение «пост в чат» соответствует целевой схеме; фактически — проверять `src/jobs/notification-scheduler.ts`.

**Шаг 3. Напоминание за ~15 минут до начала**

1. События: `status = 'active'`, `start_at` в окне `[now + 14 мин, now + 16 мин]` (и пропуск «неучебных» по title/description: обед, self-study).
2. Идемпотентность по чату: `event_chat_messages.role = 'reminder_24h'` (если отправка в группу снова включена).
3. **ЛС**: при ненулевом `event_subjects` — только студенты с пересечением `student_subjects`; `notification_type` в логе — **`reminder_24h`**; тихие часы — пропуск отправки на этом шаге.
4. Опционально: отчёт админам по подтверждениям «Буду на занятии» (отдельный блок в том же джобе).

**Шаг 4. Напоминание за ~5 минут до начала**

1. Окно `start_at`: `[now + 4 мин, now + 6 мин]`.
2. Роли/типы в БД: **`reminder_1h`** (историческое имя), подтверждения из `reminder_confirmations`, перед 5-минутным ЛС — спец. задача удаления предыдущего 15-минутного сообщения в ЛС (`delete_dm_reminder_24h` в очереди).

**Шаг 5. Завершение**

1. Снять блокировку.
2. Залогировать статистику (очередь, напоминания 15/5 мин).

#### Обработка ошибок

- Ошибки БД при выборке — залогировать, выйти; следующий запуск через **~1 минуту** (cron раз в минуту).
- Ошибки при формировании задач — не падать целиком; помечать проблемную запись как failed и продолжать.

#### Идемпотентность

- Повторный проход за ту же минуту не должен дублировать напоминания: проверка по `event_chat_messages` (reminder_24h / reminder_1h) и по `event_dm_log` / `reminder_confirmations`. Очередь отправки потребляется воркером (Job 3) один раз на задачу.

#### Псевдокод

```text
function runNotificationSchedulerJob():
  if not acquireLock("job:notification_scheduler", ttlMinutes: 8): return
  try:
    for task in db.getPendingFromNotificationQueue(limit: 50):
      if task.type in ['new_event','updated_event']:
        markProcessed(task.id)   // мгновенная рассылка отключена
        continue
      if task.type == 'cancelled_event':
        enqueueCancelledDmToPreviousRecipients(task.event_id)
      markProcessed(task.id)

    events15m = db.getEventsWhereStartBetween(now()+14min, now()+16min)
    for event in events15m:
      for student in getStudentsForEventDm(event.id, eventSubjects):
        enqueueReminderDm(student, event, 'reminder_24h')

    events5m = db.getEventsWhereStartBetween(now()+4min, now()+6min)
    for event in events5m:
      for student in getStudentsForEventDm(event.id, eventSubjects):
        enqueueReminderDm(student, event, 'reminder_1h')
  finally:
    releaseLock("job:notification_scheduler")
```

#### Зависимости

- **БД**: `calendar_events`, `event_chat_messages`, `event_dm_log`, `event_groups`, `groups`, `students`, `student_groups`, `notification_queue`, `send_queue` (или аналог).
- **Выход**: записи в очереди отправки сообщений (`send_queue`), потребляемые Job 3.

---

### 5.3. Job 3: Воркер очереди отправки сообщений (постоянный цикл)

#### Назначение

Забирать из очереди отправки задачи (отправить в чат / в ЛС) и выполнять их через Telegram Bot API с соблюдением лимитов, чтобы не получить 429 и не быть заблокированным. Обрабатывать ошибки (например, пользователь заблокировал бота) и логировать результат.

#### Триггер и расписание

- **Режим**: в репозитории — **cron каждые 5 секунд** (`src/index.ts`), внутри — итерация воркера очереди. Блокировка не обязательна, если воркер один; при нескольких инстансах — потребление очереди с блокировкой записей (claim).

#### Лимиты

- **Глобально**: не более 25–30 сообщений в секунду к Telegram API.
- **На одного пользователя (ЛС)**: не более 1 сообщения в 1–2 секунды.
- Реализация: счётчик сообщений за скользящую секунду; при достижении лимита — sleep до следующей секунды. Отдельный счётчик/время последней отправки на `telegram_user_id` для ЛС.

#### Входные данные

- Очередь отправки: таблица `send_queue` с полями: id, type (chat | dm), chat_id, message_thread_id (nullable), text, parse_mode, event_id (nullable), student_id (nullable), notification_type (nullable), created_at, status (pending | sent | failed), error_message (nullable).
- Или аналогичная структура (Redis list, Bull queue и т.п.).

#### Пошаговая логика

**Шаг 1. Выборка задач**

1. Выбрать из `send_queue` записи со статусом `pending`, упорядоченные по `created_at`, лимит N (например 5–10 за итерацию).
2. При нескольких воркерах: обновить выбранные строки на `status = 'processing'` и указать `claimed_at`, `worker_id`, чтобы другой воркер не взял ту же задачу.

**Шаг 2. Применение лимитов перед отправкой**

1. Перед каждой отправкой проверить глобальный лимит (сообщений за последнюю секунду). Если превышен — подождать 1 с и повторить проверку.
2. Для задачи типа `dm`: проверить, когда последний раз отправляли этому пользователю (по chat_id = user_id). Если меньше 1–2 сек назад — отложить задачу (вернуть в очередь с небольшой задержкой) или подождать.

**Шаг 3. Отправка**

1. Вызвать `bot.telegram.sendMessage(chat_id, text, { parse_mode, message_thread_id })`.
2. При успехе: обновить задачу `status = 'sent'`, при необходимости записать в `event_chat_messages` или `event_dm_log` (если ещё не записано в Job 2 — тогда запись здесь). Для ЛС обновить `students.last_dm_at`.
3. При ошибке:
   - Код 403 / «bot was blocked by the user»: пометить задачу `status = 'failed'`, в профиле студента установить `dm_blocked = true` (чтобы больше не ставить ему задачи в ЛС до разблокировки).
   - 429 (Too Many Requests): не помечать задачу как failed; вернуть в pending или оставить processing и повторить через retry_after из заголовка ответа.
   - Остальные ошибки: `status = 'failed'`, сохранить `error_message`; при необходимости retry с backoff (повторные попытки с задержкой).

**Шаг 4. Цикл**

1. Если очередь пуста — sleep 2–5 сек и снова выбрать задачи.
2. После каждой отправки учитывать лимиты (sleep при необходимости).

#### Обработка ошибок

- Сетевой таймаут: retry 1–2 раза с небольшой паузой, затем failed.
- 429: обязательная пауза по `Retry-After` или 60 сек, затем повторить отправку той же задачи.

#### Идемпотентность

- Задача с id обрабатывается один раз (после claim статус меняется на processing/sent/failed). Повторная отправка одного и того же уведомления не выполняется, т.к. запись в `event_dm_log` / `event_chat_messages` создаётся при отправке и Job 2 больше не создаст дубликат по тем же правилам.

#### Псевдокод

```text
function runSendQueueWorker():
  loop:
    tasks = db.getSendQueuePending(limit: 10)
    for task in tasks:
      db.claimTask(task.id, worker_id)
      if task.type == 'dm': waitIfNeededForUserRateLimit(task.chat_id)
      waitIfNeededForGlobalRateLimit()
      try:
        result = telegram.sendMessage(task.chat_id, task.text, { message_thread_id: task.message_thread_id })
        db.updateTask(task.id, status: 'sent')
        maybeWriteEventDmLogOrChatMessage(task)
      catch e:
        if e.code == 403 and 'blocked' in e.message:
          db.setStudentDmBlocked(task.student_id)
        if e.code == 429: requeueWithDelay(task, e.retry_after)
        else: db.updateTask(task.id, status: 'failed', error_message: e.message)
    if tasks.length == 0: sleep(3)
```

#### Зависимости

- **БД**: `send_queue`, `event_chat_messages`, `event_dm_log`, `students`.
- **Внешний API**: Telegram Bot API (sendMessage).
- **Вход**: записи в `send_queue`, созданные Job 2 и командами бота (/push).

---

### 5.4. Job 4: Очистка и архивирование (раз в сутки)

#### Назначение

Поддерживать БД в приемлемом состоянии: помечать прошедшие события как `completed`, архивировать или удалять старые записи логов отправки и очередей, чтобы не раздувать таблицы и ускорить выборки.

#### Триггер и расписание

- **Интервал**: раз в сутки, например в 03:00 (cron: `0 0 3 * * *`).
- **Блокировка**: mutex `job:cleanup_archive`, TTL 2 часа.

#### Входные данные

- Текущая дата/время.
- Конфигурируемые пороги: сколько дней хранить «сырые» логи, через сколько дней помечать события как completed (если не сделано в Job 1).

#### Пошаговая логика

**Шаг 1. Пометить завершённые события**

1. Обновить `calendar_events`: установить `status = 'completed'` для записей с `status = 'active'` и `end_at < now() - 1 day`. (Дублирует логику из Job 1, если там это не выполнялось каждый запуск; можно оставить только здесь.)

**Шаг 2. Очистка обработанной очереди уведомлений**

1. Удалить из `notification_queue` записи со статусом `processed` или `failed`, старше 7 дней (или конфиг).

**Шаг 3. Очистка очереди отправки**

1. Удалить из `send_queue` записи со статусом `sent` или `failed`, старше 14 дней (или конфиг).

**Шаг 4. Архивирование логов (опционально)**

1. **event_chat_messages**: для событий с `calendar_events.status = 'completed'` и `end_at` старше 90 дней — перенести строки в таблицу `event_chat_messages_archive` (или удалить, если архив не нужен). Критерий: `event_id IN (SELECT id FROM calendar_events WHERE status = 'completed' AND end_at < now() - 90 days)`.
2. **event_dm_log**: аналогично — архивировать или удалить записи, связанные с событиями старше 90 дней.
3. **push_log**: удалить или архивировать записи старше 180 дней.

**Шаг 5. Истёкшие выборки (selections)**

1. Удалить из `selections` записи, где `created_at < now() - 24 hours` (временные выборки для /push уже не актуальны).

**Шаг 6. Завершение**

1. Снять блокировку.
2. Залогировать: сколько строк обновлено/удалено/архивировано по каждой таблице.

#### Обработка ошибок

- При ошибке БД (deadlock, timeout) — залогировать, снять блокировку по TTL, повторить на следующем суточном запуске.
- Большие объёмы удаления выполнять батчами (например по 1000 строк), чтобы не блокировать таблицу надолго.

#### Идемпотентность

- Повторный запуск не должен «дважды удалить» данные: обновления и удаления идут по чётким критериям (дата, статус). Архив при повторном запуске будет пустым для уже перенесённых строк.

#### Псевдокод

```text
function runCleanupArchiveJob():
  if not acquireLock("job:cleanup_archive", ttlMinutes: 120): return
  try:
    db.update("calendar_events", { status: 'completed' }, "status='active' AND end_at < now() - interval '1 day'")
    db.deleteFrom("notification_queue", "status IN ('processed','failed') AND updated_at < now() - interval '7 days'")
    db.deleteFrom("send_queue", "status IN ('sent','failed') AND updated_at < now() - interval '14 days'")
    archiveOldEventChatMessages(olderThanDays: 90)
    archiveOldEventDmLog(olderThanDays: 90)
    db.deleteFrom("push_log", "sent_at < now() - interval '180 days'")
    db.deleteFrom("selections", "created_at < now() - interval '24 hours'")
  finally:
    releaseLock("job:cleanup_archive")
```

#### Зависимости

- **БД**: `calendar_events`, `notification_queue`, `send_queue`, `event_chat_messages`, `event_dm_log`, `push_log`, `selections`, при архиве — таблицы `*_archive`.
- **Выход**: уменьшенный объём активных таблиц, при необходимости — заполненный архив для аудита.

---

### 5.5. Job 5: Планер учебных задач (ежедневно)

#### Назначение

Помогать студентам планировать до 6 задач на день и вечером отмечать их выполнение, а также выгружать результаты в Google Sheets.

#### Триггер и расписание

- Утренний опрос: каждый день в 10:00 по Москве.
- Вечерний опрос: каждый день в 20:00 по Москве.
- Экспорт в таблицу: каждый день в 21:00 по Москве.

#### Входные данные

- Таблицы: `students` (включая `planner_enabled`), `planner_sessions`, `daily_tasks`, `daily_tasks_exports`.

#### Пошаговая логика

- **Утро (10:00)**:
  - Выбрать студентов с `planner_enabled = 1`, `notify_dm = 1`, `dm_blocked = 0`.
  - В ЛС отправить приглашение с кнопками 1–6 и «Сегодня без задач» (notification_type=planner_invite).
  - По выбору студента создать/обновить `planner_sessions` и дальше собирать текст задач в `daily_tasks` через диалог в ЛС.
- **Вечер (20:00)**:
  - Найти задачи за сегодня со статусами `planned` или `partly_done`.
  - Для каждой задачи отправить сообщение в ЛС с текстом «Задача N: …» и кнопками:
    - ✅ выполнена → status=completed;
    - 🟡 частично → status=partly_done;
    - ❌ отменена → status=cancelled (с дополнительным вопросом «почему»).
- **Экспорт (21:00)**:
  - Собрать задачи за сегодня со статусами `completed`, `partly_done`, `cancelled`, ещё не выгруженные в `daily_tasks_exports`.
  - Вызвать Google Sheets API (см. модуль planner-sheets) и записать строки формата `[дата, ФИО, статус, текст задачи]`.
  - Для успешно выгруженных задач добавить записи в `daily_tasks_exports`.

---

## 6. Логика уведомлений в Telegram

### 6.1. Отправка в групповой чат

**Текущая реализация:** в коде планировщика отключена постановка задач на отправку в группы (`enqueueSend` для `type === 'chat'` возвращает без записи в `send_queue`). На практике пользователи получают уведомления **в ЛС** по правилам §6.3; ниже — целевая схема, когда групповая отправка снова будет включена.

- **Триггер**: после синхронизации календаря обнаружено новое событие (или обновление).
- **Алгоритм**:
  1. По `event_groups` определить список `group_id` для события.
  2. Для каждой группы взять `telegram_chat_id` (и при необходимости `topic_id`).
  3. Проверить в `event_chat_messages`, что для данной пары (event_id, chat_id) ещё нет записи с role=main_post (или update).
  4. Сформировать текст (см. ниже).
  5. Вызвать `sendMessage(chat_id, text, { message_thread_id: topic_id || undefined })`.
  6. Сохранить в `event_chat_messages`: event_id, chat_id, message_id, thread_id, role.

**Формат сообщения (пример)** — без префикса «типа» события; классификация только по предметам (`event_subjects`) и топикам:
```
📅 Название события
🕐 15 марта 2025, 10:00 – 11:30
📍 Офлайн / Ссылка: ...

Краткое описание (если есть).

Группы: Поток 2024, Группа А
```
Кнопки (опционально): "Подробнее" (ссылка на календарь или описание).

### 6.2. Отправка в топик (ветку)

- В супергруппах с топиками использовать один общий топик "Календарь" (`topic_id` в `groups`) или создавать топик на событие (если Telegram API и политика чата это позволяют).
- Все последующие сообщения по этому событию (напоминания, отмена, перенос) отправлять в тот же чат с `message_thread_id = thread_id` из `event_chat_messages` (или `topic_id` группы), чтобы обсуждение шло в одной ветке.

### 6.3. Дублирование в ЛС

- **Условия**:
  - Студент входит в одну из групп события (`event_groups` → `students` через `student_groups`).
  - У студента `notify_dm = true`.
  - Если у события есть предметы в `event_subjects` — у студента должен быть выбран хотя бы один из этих предметов в `student_subjects` (`/subjects`). Если в `event_subjects` пусто — допускается рассылка всем студентам группы по связке `event_groups` (как в коде планировщика).
  - Нет записи в `event_dm_log` для (event_id, student_id, notification_type).
  - (Опционально) Текущее время не попадает в quiet_hours; если попадает — поставить в очередь на `notify_quiet_hours_end`.
- **Действие**: отправить в ЛС через `sendMessage(telegram_user_id, text)` (в Telegram ЛС — chat_id = user_id).
- **Запись**: вставить в `event_dm_log`.

Текст в ЛС можно сократить и персонализировать: "Привет, {first_name}. Напоминаем: завтра [событие] в 10:00. …"

### 6.4. Напоминания (за ~15 и ~5 минут до начала)

- Джоб 2 по расписанию (**каждую минуту**, см. `src/index.ts`):
  1. События с `start_at` в окне **14–16 минут** от текущего момента; в БД роль/тип — **`reminder_24h`** (историческое имя).
  2. Аналогично окно **4–6 минут**; роль/тип — **`reminder_1h`**; учёт таблицы `reminder_confirmations`, перед 5-минутным ЛС — удаление предыдущего напоминания в ЛС (по `send_queue`).
- Для каждого такого события:
  - **В чат**: при включённой отправке в группы — топик по `group_topics` / `event_subjects`; иначе см. §6.1.
  - **В ЛС**: правила §6.3; `notification_type` в `event_dm_log` — `reminder_24h` / `reminder_1h`; inline «Буду на занятии» для отчёта админам.

### 6.5. Обновление и отмена события

- При синхронизации календаря обнаружено изменение времени/названия или статус `cancelled`.
- **Новое/изменённое событие**: задачи в `notification_queue` типов `new_event` / `updated_event` **не приводят к мгновенной рассылке** (см. §5.2); пользователи увидят событие через напоминания за 15/5 минут.
- **Отмена**: из очереди `cancelled_event` — уведомление в ЛС тем, кто уже получал сообщения по этому событию (`event_dm_log`), запись `notification_type = cancelled` (тихие часы учитываются). Попытка поста в группу — см. §6.1.

---

## 7. Выборочная рассылка (команды бота)

### 7.1. Регистрация пользователя (Start)

- Команда `/start`.
- Если `chat.type === 'private'`: создать/обновить запись в `students` по `from.id`, сохранить first_name, last_name, username. Отправить приветствие и ссылку на настройки уведомлений (кнопки или /settings).

### 7.2. Настройки студента

- `/settings` (только в ЛС):
  - Inline-кнопки: "ЛС уведомления вкл/выкл", "Тихие часы".
  - Сохранять в `students.notify_*`, `notify_quiet_hours_*`. Фильтр по предметам — `/subjects` (`student_subjects`).

### 7.3. Админ-команды (проверка по таблице admins)

- **Выборка студентов**  
  `/select group=Поток 2024` — выборка по группе.  
  `/select event=<event_id>` — все, кому предназначено событие.  
  `/select event=<event_id> not_attended` — если есть таблица посещаемости (отдельная сущность).  
  Бот отвечает: "Выбрано N человек: Имя1, Имя2, … (и ещё M). Подтвердите или отправьте /push <текст>."

- **Отправка пуша**  
  `/push Текст сообщения для выбранных`  
  - Взять последнюю выборку (selection) от этого пользователя (по created_by_telegram_user_id и created_at).  
  - Для каждого student_id из selection получить telegram_user_id и отправить сообщение в ЛС.  
  - Сохранить в push_log.  
  - Ограничение: не более K сообщений в минуту (например 20), остальные поставить в очередь.

- **Список групп**  
  `/groups` — вывести группы и привязанные chat_id (для админа).

### 7.4. Привязка чата к группе

- Админ добавляет бота в группу и в чате пишет: `/link_group Поток 2024`.  
  Бот сохраняет `telegram_chat_id` (и при необходимости `message_thread_id` текущего топика) в запись группы "Поток 2024".  
  Или: `/link_group "Поток 2024" topic` — использовать текущий топик как топик для календаря.

---

## 8. Очередь отправки и лимиты

- Все исходящие сообщения (в чат и в ЛС) пропускать через **очередь** (in-memory или Redis/БД):
  - Глобальный лимит: не более 25–30 сообщений в секунду.
  - На одного пользователя (ЛС): не более 1 сообщения в 1–2 секунды.
- При ошибке "user blocked the bot" (403) — обновить у студента флаг, например `dm_blocked = true`, и не слать ему в ЛС до ручной разблокировки или повторного /start.

---

## 9. Безопасность и секреты

- Токен бота (`BOT_TOKEN`) и учётные данные Google — только в переменных окружения или секретном хранилище, не в коде.
- `credentials_json` в БД — шифровать (AES с ключом из env).
- Проверять `chat_id` при привязке групп: только админ может выполнять `/link_group`.
- Ввод в командах (/push текст) — экранировать от Markdown/HTML инъекций при выводе.

---

## 10. Стек и окружение (рекомендации)

| Компонент | Вариант |
|-----------|--------|
| Язык | Node.js (TypeScript) или Python |
| БД | PostgreSQL или SQLite (для малых объёмов) |
| Очередь | Bull (Node) / Celery (Python) или простая in-memory с таймерами |
| Планировщик | node-cron / Agenda (Node), APScheduler (Python) |
| Telegram | node-telegram-bot-api или Telegraf (Node), python-telegram-bot (Python) |
| Google | googleapis (Node), google-api-python-client (Python) |

---

## 11. Этапы реализации (кратко)

1. Настройка бота в BotFather, получение токена.
2. Модели БД и миграции (в т.ч. `event_subjects` / `student_subjects` / `group_topics`, миграция снятия legacy-колонок при обновлении со старых схем).
3. Подключение Google Calendar API и джоб синхронизации (окно **−1 день … +7 дней**).
4. Маршрутизация по предметам и топикам; при необходимости — снова включить посты в группу.
5. Дублирование в ЛС по правилам (`notify_dm`, `student_subjects`, тихие часы).
6. Напоминания **за ~15 мин и ~5 мин** до начала (чат + ЛС по схеме; фактически — проверить отключение группы в `enqueueSend`).
7. Обработка отмен в ЛС; очередь `new_event`/`updated_event` без мгновенной рассылки.
8. Команды /start, /settings, /subjects для студентов.
9. Админ: /select, /push, /link_group, /link_topic, /groups.
10. Очередь `send_queue`, воркер, лимиты, обработка ошибок (blocked user).
11. Шифрование credentials и проверка безопасности.

Этот документ можно использовать как ТЗ для реализации бота под Telegram с календарём и выборочными пушами.
