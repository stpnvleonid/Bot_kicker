-- Mandatory "exams" completions for planner analytics:
-- - lesson (Урок)
-- - homework (ДЗ)
--
-- Student sends photo/screens, bot forwards to admins for moderation.
-- We store evidence + completion_date (DD MM provided by student) and keep:
-- - status: pending/confirmed/rejected
-- - last_confirmed_* fields for "последнее подтвержденное"
-- - last_prompted_at for paging (top-4 today, others tomorrow)

CREATE TABLE IF NOT EXISTS planner_exam_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  lesson_event_id INTEGER NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('lesson','homework')),

  -- lesson_date is the "truth" date from calendar event in planner timezone (YYYY-MM-DD)
  lesson_date TEXT NOT NULL, -- YYYY-MM-DD

  -- completion_date is the date provided by the student (YYYY-MM-DD after parsing),
  -- can differ from lesson_date.
  completion_date TEXT,

  -- optional: helps to show short "<Subject>" label and debugging/analytics joins
  subject_key TEXT,

  evidence_file_id TEXT,
  evidence_message_id TEXT,
  evidence_caption TEXT,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),

  last_prompted_at TEXT,
  last_submitted_at TEXT,

  last_confirmed_at TEXT,
  last_confirmed_by_telegram_user_id INTEGER,

  last_rejected_at TEXT,
  last_rejected_by_telegram_user_id INTEGER,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(student_id, lesson_event_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_pes_student_status_date ON planner_exam_submissions(student_id, status, lesson_date);
CREATE INDEX IF NOT EXISTS idx_pes_lesson_event ON planner_exam_submissions(lesson_event_id);

