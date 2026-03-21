-- Daily planner: задачи студентов на день и выгрузка в Google Sheets.

-- Флаг «участвует в планере» у студента.
-- В SQLite нет синтаксиса ADD COLUMN IF NOT EXISTS, а миграции и так выполняются ровно один раз.
ALTER TABLE students ADD COLUMN planner_enabled INTEGER NOT NULL DEFAULT 1;

-- Ежедневные задачи.
CREATE TABLE IF NOT EXISTS daily_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  task_date TEXT NOT NULL, -- YYYY-MM-DD
  idx INTEGER NOT NULL, -- номер задачи в дне (1–6)
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled','partly_done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, task_date, idx)
);
CREATE INDEX IF NOT EXISTS idx_daily_tasks_student_date ON daily_tasks(student_id, task_date);

-- Сессии планирования (чтобы знать, сколько задач осталось спросить).
CREATE TABLE IF NOT EXISTS planner_sessions (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  task_date TEXT NOT NULL,
  total_tasks INTEGER NOT NULL,
  next_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','done')),
  PRIMARY KEY (student_id, task_date)
);

-- Выгрузка задач в Google Sheets (одна запись на задачу).
CREATE TABLE IF NOT EXISTS daily_tasks_exports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES daily_tasks(id) ON DELETE CASCADE,
  exported_at TEXT NOT NULL DEFAULT (datetime('now')),
  sheet_row INTEGER,
  UNIQUE(task_id)
);

