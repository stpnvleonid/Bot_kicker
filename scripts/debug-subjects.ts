import { getDb } from '../src/db';
import { getEventSubjectKeys } from '../src/jobs/notification-scheduler'; // вспомогательный экспорт сделаем ниже

type EventRow = {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
  status: string;
};

function main(): void {
  const db = getDb();

  const events = db
    .prepare(
      `SELECT id, title, description, start_at, status
       FROM calendar_events
       ORDER BY start_at`
    )
    .all() as EventRow[];

  if (events.length === 0) {
    console.log('Событий в calendar_events нет.');
    return;
  }

  let withoutSubjects = 0;
  const prefixes = new Map<string, number>();

  for (const ev of events) {
    const subjects = getEventSubjectKeys(db, ev.id);
    if (subjects.length === 0) {
      withoutSubjects += 1;
      const t = (ev.title || '').trim().toLowerCase();
      const prefix = t.split(/\s+/).slice(0, 3).join(' ');
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
  }

  console.log(`Всего событий: ${events.length}`);
  console.log(`Без предметов (event_subjects): ${withoutSubjects}`);

  if (withoutSubjects === 0) return;

  console.log('\nЧастые первые 1–3 слова у событий без предметов:');
  const top = [...prefixes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  for (const [pref, count] of top) {
    console.log(`${count.toString().padStart(4, ' ')} ×  ${pref}`);
  }
}

main();

