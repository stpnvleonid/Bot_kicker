-- Track last success/error timestamps for critical background jobs.

CREATE TABLE IF NOT EXISTS job_health (
  job_name TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

