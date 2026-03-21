/**
 * Полный перерасчёт event_subjects для всех событий по текущим правилам detectSubjectsFromEventText.
 * Запуск: npm run recalc-event-subjects
 */

import { getDb } from '../src/db';
import { detectSubjectsFromEventText } from '../src/config/subjects';

function main(): void {
  const db = getDb();

  try {
    db.prepare('SELECT 1 FROM event_subjects LIMIT 1').get();
  } catch {
    console.error('Таблица event_subjects не найдена. Выполните миграции: npm run migrate:dev');
    process.exit(1);
  }

  const events = db
    .prepare('SELECT id, title, description FROM calendar_events ORDER BY id')
    .all() as Array<{ id: number; title: string | null; description: string | null }>;

  if (!events.length) {
    console.log('Нет событий в calendar_events.');
    return;
  }

  console.log(`Пересчитываю event_subjects для ${events.length} событий...`);
  let deleted = 0;
  let inserted = 0;

  const deleteStmt = db.prepare('DELETE FROM event_subjects WHERE event_id = ?');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO event_subjects (event_id, subject_key) VALUES (?, ?)');

  for (const ev of events) {
    deleteStmt.run(ev.id);
    deleted += 1;
    const keys = detectSubjectsFromEventText(ev.title, ev.description);
    for (const sk of keys) {
      insertStmt.run(ev.id, sk);
      inserted += 1;
    }
    if (keys.length > 0) {
      console.log(`#${ev.id} "${(ev.title || '').slice(0, 80)}" → ${keys.join(', ')}`);
    }
  }

  console.log(`Готово. Очищено event_subjects для ${deleted} событий, добавлено записей: ${inserted}.`);
}

main();

