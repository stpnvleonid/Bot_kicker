-- Лог личных сообщений по событиям с message_id (для удаления старых напоминаний и отладки).
CREATE TABLE IF NOT EXISTS event_dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('new_event','reminder_24h','reminder_1h','update','cancelled')),
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, student_id, notification_type)
);

