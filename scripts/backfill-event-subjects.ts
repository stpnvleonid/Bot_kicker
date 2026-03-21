/**
 * Разовый проход: дозаполнить event_subjects для всех событий, у которых он пустой.
 * Запуск: npm run backfill-event-subjects
 */

import { getDb } from '../src/db';
import { detectSubjectsFromEventText } from '../src/config/subjects';

const LOCK_KEY = 'job:backfill_event_subjects';
const LOCK_TTL_MS = 30 * 60 * 1000;

function acquireLock(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM job_locks WHERE key = ? AND expires_at > datetime('now')").get(LOCK_KEY);
  if (row) return false;
  db.prepare(`INSERT OR REPLACE INTO job_locks (key, expires_at) VALUES (?, datetime('now', ?))`).run(
    LOCK_KEY,
    `+${LOCK_TTL_MS / 1000} seconds`
  );
  return true;
}

function releaseLock(): void {
  getDb().prepare('DELETE FROM job_locks WHERE key = ?').run(LOCK_KEY);
}

function main(): void {
  const db = getDb();
  if (!acquireLock()) {
    console.log('[backfill-event-subjects] skipped: lock held');
    return;
  }

  try {
    db.prepare('SELECT 1 FROM event_subjects LIMIT 1').get();
  } catch {
    console.error('Таблица event_subjects не найдена. Выполните миграции: npm run migrate:dev');
    releaseLock();
    process.exit(1);
  }

  const empty = db
    .prepare(
      `SELECT ce.id, ce.title, ce.description
       FROM calendar_events ce
       LEFT JOIN event_subjects es ON es.event_id = ce.id
       WHERE es.event_id IS NULL
       ORDER BY ce.id`
    )
    .all() as Array<{ id: number; title: string | null; description: string | null }>;

  if (empty.length === 0) {
    console.log('Нет событий с пустым event_subjects. Всё заполнено.');
    releaseLock();
    return;
  }

  console.log(`Найдено событий без предметов: ${empty.length}`);
  let inserted = 0;

  // Пачка вставок в транзакции уменьшает вероятность частичного состояния при ошибках.
  const tx = db.transaction(() => {
    for (const row of empty) {
      const keys = detectSubjectsFromEventText(row.title, row.description);
      for (const sk of keys) {
        db.prepare('INSERT OR IGNORE INTO event_subjects (event_id, subject_key) VALUES (?, ?)').run(row.id, sk);
        inserted += 1;
      }
      if (keys.length > 0) {
        console.log(`  #${row.id} "${(row.title || '').slice(0, 50)}" → ${keys.join(', ')}`);
      }
    }
  });

  tx();

  console.log(`Готово. Добавлено записей в event_subjects: ${inserted}.`);
  releaseLock();
}

main();
