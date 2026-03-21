-- Adds retry/backoff scheduling to send_queue for reliability.
-- Applies after migration 001_initial.sql

ALTER TABLE send_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE send_queue ADD COLUMN next_attempt_at TEXT;

CREATE INDEX IF NOT EXISTS idx_send_queue_next_attempt_at ON send_queue(next_attempt_at);

