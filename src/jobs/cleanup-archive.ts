/**
 * Job 4: Очистка и архивирование (раз в сутки).
 * См. TECHNICAL_DESIGN_TELEGRAM.md § 5.4
 */

import { getDb } from '../db';

const LOCK_KEY = 'job:cleanup_archive';
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;

function acquireLock(): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM job_locks WHERE key = ? AND expires_at > datetime(\'now\')').get(LOCK_KEY);
  if (row) return false;
  db.prepare(
    `INSERT OR REPLACE INTO job_locks (key, expires_at) VALUES (?, datetime('now', ?))`
  ).run(LOCK_KEY, `+${LOCK_TTL_MS / 1000} seconds`);
  return true;
}

function releaseLock(): void {
  getDb().prepare('DELETE FROM job_locks WHERE key = ?').run(LOCK_KEY);
}

export async function runCleanupArchiveJob(): Promise<void> {
  if (!acquireLock()) {
    console.log('[Job4] Cleanup skipped: lock held');
    return;
  }
  try {
    const db = getDb();
    const r1 = db.prepare(
      `UPDATE calendar_events SET status = 'completed', updated_at = datetime('now')
       WHERE status = 'active' AND end_at < datetime('now', '-1 day')`
    ).run();
    const r2 = db.prepare(
      `DELETE FROM notification_queue WHERE status IN ('processed','failed') AND updated_at < datetime('now', '-7 days')`
    ).run();
    const r3 = db.prepare(
      `DELETE FROM send_queue WHERE status IN ('sent','failed') AND updated_at < datetime('now', '-14 days')`
    ).run();
    // Убираем ссылки на старые выборки, иначе FOREIGN KEY не даст удалить selections
    db.prepare(
      `DELETE FROM push_log WHERE selection_id IN (SELECT id FROM selections WHERE created_at < datetime('now', '-1 day'))`
    ).run();
    db.prepare(
      `UPDATE send_queue SET selection_id = NULL WHERE selection_id IN (SELECT id FROM selections WHERE created_at < datetime('now', '-1 day'))`
    ).run();
    const r4 = db.prepare(
      `DELETE FROM selections WHERE created_at < datetime('now', '-1 day')`
    ).run();
    // Агрессивная очистка: удаляем события старше 3 дней (completed/cancelled) и связанные записи.
    // Не трогаем события с planner_exam_submissions: FK ON DELETE CASCADE иначе сотрёт долги/историю exams.
    const oldEventsSubquery =
      `SELECT ce.id FROM calendar_events ce
       WHERE ce.end_at < datetime('now', '-3 days')
         AND ce.status IN ('completed','cancelled')
         AND NOT EXISTS (SELECT 1 FROM planner_exam_submissions pes WHERE pes.lesson_event_id = ce.id)`;
    const r5 = db
      .prepare(`DELETE FROM send_queue WHERE event_id IN (${oldEventsSubquery})`)
      .run();
    const r6 = db.prepare(`DELETE FROM calendar_events WHERE id IN (${oldEventsSubquery})`).run();

    console.log('[Job4] Cleanup done:', {
      events_completed: r1.changes,
      notif: r2.changes,
      send_queue_old: r3.changes,
      selections: r4.changes,
      send_queue_events_purged: r5.changes,
      events_purged: r6.changes,
    });
    releaseLock();
  } catch (e) {
    console.error('[Job4] Cleanup error:', e);
    releaseLock();
  }
}
