-- Глобальный журнал обработанных callback-запросов Telegram.
-- Используется для защиты от повторной обработки одного и того же callback'а
-- (например, при повторной доставке из-за сетевых ошибок).

CREATE TABLE IF NOT EXISTS callback_log (
  id TEXT PRIMARY KEY,                -- callback_query.id из Telegram
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

