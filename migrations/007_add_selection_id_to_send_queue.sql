-- Добавляем selection_id в send_queue, чтобы связать задачи отправки с выборками (/push).

ALTER TABLE send_queue
  ADD COLUMN selection_id INTEGER REFERENCES selections(id);

CREATE INDEX IF NOT EXISTS idx_send_queue_selection_id
  ON send_queue(selection_id);

