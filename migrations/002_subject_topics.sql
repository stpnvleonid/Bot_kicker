-- Топики по предметам в группе; выбор предметов студентами.
-- subject_key: math, informatics, physics, society, russian, english (см. src/config/subjects.ts)

-- В каждой группе (чат) — свой topic_id (message_thread_id) для каждого предмета
CREATE TABLE IF NOT EXISTS group_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  subject_key TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(group_id, subject_key)
);

-- Выбор предметов студентом (для маршрутизации уведомлений в ЛС и в топики)
CREATE TABLE IF NOT EXISTS student_subjects (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_key TEXT NOT NULL,
  PRIMARY KEY (student_id, subject_key)
);

-- Связь события с предметами (заполняется при синхронизации/обработке по title+description)
CREATE TABLE IF NOT EXISTS event_subjects (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  subject_key TEXT NOT NULL,
  PRIMARY KEY (event_id, subject_key)
);

CREATE INDEX IF NOT EXISTS idx_group_topics_group ON group_topics(group_id);
CREATE INDEX IF NOT EXISTS idx_event_subjects_event ON event_subjects(event_id);
