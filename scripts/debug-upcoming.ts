import { getDb } from '../src/db';
import { getConfig } from '../src/config';

type EventRow = {
  id: number;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
};

function formatDate(iso: string, tz: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function main(): void {
  const config = getConfig();
  const tz = config.TZ || 'UTC';
  const db = getDb();

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Берём ближайшие 24 часа активных событий
  const in24hIso = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, title, start_at, end_at, status
       FROM calendar_events
       WHERE status = 'active' AND start_at >= ? AND start_at <= ?
       ORDER BY start_at`
    )
    .all(nowIso, in24hIso) as EventRow[];

  if (rows.length === 0) {
    console.log('Нет активных событий в ближайшие 24 часа.');
    return;
  }

  console.log(`Текущее время: ${formatDate(nowIso, tz)} (TZ=${tz})`);
  console.log(`Найдено событий в ближайшие 24 часа: ${rows.length}`);
  console.log('---');

  for (const ev of rows) {
    const startMs = new Date(ev.start_at).getTime();
    const diffMinutes = Math.round((startMs - now) / (60 * 1000));
    const in15Window = diffMinutes >= 14 && diffMinutes <= 16;
    const in5Window = diffMinutes >= 4 && diffMinutes <= 6;

    console.log(
      [
        `#${ev.id} "${ev.title || 'Без названия'}"`,
        `  start_at: ${ev.start_at} → ${formatDate(ev.start_at, tz)}`,
        `  end_at:   ${ev.end_at} → ${formatDate(ev.end_at, tz)}`,
        `  до начала ~ ${diffMinutes} мин`,
        `  в окне 15 минут? ${in15Window ? 'ДА' : 'нет'}`,
        `  в окне 5 минут?  ${in5Window ? 'ДА' : 'нет'}`,
      ].join('\n')
    );
    console.log('---');
  }
}

main();

