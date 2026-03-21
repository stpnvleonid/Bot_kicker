-- Bot Kicker: initial schema (SQLite-compatible)
-- Run: npm run migrate  (or sqlite3 data/bot.sqlite < migrations/001_initial.sql)

-- 1. Calendar
CREATE TABLE IF NOT EXISTS calendar_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id TEXT NOT NULL,
  name TEXT NOT NULL,
  credentials_json TEXT,
  sync_token TEXT,
  last_sync TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sync_error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_config_id INTEGER NOT NULL REFERENCES calendar_config(id),
  google_event_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  raw_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(calendar_config_id, google_event_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_status ON calendar_events(status);

-- 2. Groups (Telegram chats)
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  telegram_chat_id INTEGER NOT NULL,
  topic_id INTEGER,
  calendar_config_id INTEGER REFERENCES calendar_config(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_groups (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, group_id)
);

-- 3. Students
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  notify_dm INTEGER NOT NULL DEFAULT 1,
  notify_quiet_hours_start TEXT,
  notify_quiet_hours_end TEXT,
  last_dm_at TEXT,
  dm_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_groups (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (student_id, group_id)
);

-- 4. Event delivery logs
CREATE TABLE IF NOT EXISTS event_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  thread_id INTEGER,
  role TEXT NOT NULL CHECK (role IN ('main_post','reminder_24h','reminder_1h','update','cancelled')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_dm_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('new_event','reminder_24h','reminder_1h','update','cancelled')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, student_id, notification_type)
);

-- 5. Queues
CREATE TABLE IF NOT EXISTS notification_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('new_event','updated_event','cancelled_event')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS send_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('chat','dm')),
  chat_id INTEGER NOT NULL,
  message_thread_id INTEGER,
  text TEXT NOT NULL,
  parse_mode TEXT,
  event_id INTEGER REFERENCES calendar_events(id),
  student_id INTEGER REFERENCES students(id),
  notification_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  error_message TEXT,
  worker_id TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_send_queue_status ON send_queue(status);

-- 6. Selections and push log
CREATE TABLE IF NOT EXISTS selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by_telegram_user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  criteria TEXT,
  student_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id INTEGER REFERENCES selections(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  message_text TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL DEFAULT 1
);

-- 7. Admins
CREATE TABLE IF NOT EXISTS admins (
  telegram_user_id INTEGER PRIMARY KEY
);

-- 8. Job locks (for cron jobs mutex)
CREATE TABLE IF NOT EXISTS job_locks (
  key TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
