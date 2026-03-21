-- Кнопка «Буду на занятии» в напоминаниях 15 и 5 мин: кто отметился.
CREATE TABLE IF NOT EXISTS reminder_confirmations (
  event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_reminder_confirmations_event ON reminder_confirmations(event_id);

-- Чтобы не слать отчёт админу повторно.
CREATE TABLE IF NOT EXISTS event_report_sent (
  event_id INTEGER PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
