/**
 * Диагностика маршрутизации: почему сообщение уходит в General или не в тот топик.
 * Запуск: npm run debug-routing [event_id]
 * Без event_id берётся ближайшее предстоящее событие.
 */

import { getDb } from '../src/db';

function getEventSubjectKeys(db: ReturnType<typeof getDb>, eventId: number): string[] {
  try {
    const rows = db
      .prepare('SELECT subject_key FROM event_subjects WHERE event_id = ?')
      .all(eventId) as Array<{ subject_key: string }>;
    return rows.map((r) => r.subject_key);
  } catch {
    return [];
  }
}

function main(): void {
  const db = getDb();
  const eventIdArg = process.argv[2];
  let eventId: number;
  let event: { id: number; title: string; start_at: string; status: string } | undefined;

  if (eventIdArg) {
    eventId = parseInt(eventIdArg, 10);
    if (Number.isNaN(eventId)) {
      console.error('Укажите числовой event_id: npm run debug-routing 42');
      process.exit(1);
    }
    event = db.prepare('SELECT id, title, start_at, status FROM calendar_events WHERE id = ?').get(eventId) as
      | { id: number; title: string; start_at: string; status: string }
      | undefined;
    if (!event) {
      console.error('Событие с id', eventId, 'не найдено.');
      process.exit(1);
    }
  } else {
    const nowIso = new Date().toISOString();
    event = db.prepare(
      `SELECT id, title, start_at, status FROM calendar_events
       WHERE status = 'active' AND start_at >= ? ORDER BY start_at LIMIT 1`
    ).get(nowIso) as { id: number; title: string; start_at: string; status: string } | undefined;
    if (!event) {
      console.error('Нет предстоящих активных событий. Укажите event_id: npm run debug-routing 42');
      process.exit(1);
    }
    eventId = event.id;
  }
  if (!event) process.exit(1);

  const subjectKeys = getEventSubjectKeys(db, eventId);
  const groups = db
    .prepare(
      `SELECT g.id, g.name, g.telegram_chat_id, g.topic_id
       FROM event_groups eg
       JOIN groups g ON g.id = eg.group_id
       WHERE eg.event_id = ?`
    )
    .all(eventId) as Array<{ id: number; name: string; telegram_chat_id: number; topic_id: number | null }>;

  // Итоговые цели (как в getChatTargetsForEvent)
  const out: Array<{ chatId: number; threadId: number | null }> = [];
  const seen = new Set<string>();
  for (const g of groups) {
    let added = false;
    if (subjectKeys.length > 0) {
      for (const sk of subjectKeys) {
        const row = db
          .prepare('SELECT topic_id FROM group_topics WHERE group_id = ? AND subject_key = ?')
          .get(g.id, sk) as { topic_id: number } | undefined;
        if (row) {
          const key = `${g.telegram_chat_id}:${row.topic_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ chatId: g.telegram_chat_id, threadId: row.topic_id });
            added = true;
          }
        }
      }
    }
    if (!added) {
      if (subjectKeys.length === 0 || g.topic_id != null) {
        const key = `${g.telegram_chat_id}:${g.topic_id ?? 'null'}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ chatId: g.telegram_chat_id, threadId: g.topic_id });
        }
      }
    }
  }

  const sent = db
    .prepare(
      'SELECT chat_id, thread_id, role FROM event_chat_messages WHERE event_id = ? ORDER BY role'
    )
    .all(eventId) as Array<{ chat_id: number; thread_id: number | null; role: string }>;

  const queueRows = db
    .prepare(
      `SELECT id, type, chat_id, message_thread_id, status FROM send_queue
       WHERE event_id = ? AND type = 'chat' ORDER BY id DESC LIMIT 20`
    )
    .all(eventId) as Array<{ id: number; type: string; chat_id: number; message_thread_id: number | null; status: string }>;

  // Вывод
  console.log('=== Маршрутизация для события ===');
  console.log('event_id:', event.id);
  console.log('title:', event.title || '(без названия)');
  console.log('start_at:', event.start_at);
  console.log('status:', event.status);
  console.log('');
  console.log('--- event_subjects (предметы события) ---');
  if (subjectKeys.length === 0) {
    console.log('  (пусто) → fallback на group.topic_id (если null = General)');
  } else {
    console.log('  ', subjectKeys.join(', '));
  }
  console.log('');
  console.log('--- Группы события (event_groups → groups) ---');
  for (const g of groups) {
    console.log(`  group_id=${g.id} name="${g.name}" chat_id=${g.telegram_chat_id} group.topic_id=${g.topic_id ?? 'null'}`);
    const topics = db
      .prepare('SELECT subject_key, topic_id FROM group_topics WHERE group_id = ? ORDER BY subject_key')
      .all(g.id) as Array<{ subject_key: string; topic_id: number }>;
    if (topics.length === 0) {
      console.log('    group_topics: (пусто)');
    } else {
      for (const t of topics) {
        const match = subjectKeys.includes(t.subject_key) ? ' ✓' : '';
        console.log(`    group_topics: ${t.subject_key} → topic_id ${t.topic_id}${match}`);
      }
    }
  }
  console.log('');
  console.log('--- Итоговые цели (куда уйдёт сообщение) ---');
  if (out.length === 0) {
    console.log('  (нет целей)');
    if (subjectKeys.length > 0 && groups.length > 0) {
      console.log('  Причина: у события есть предметы, но для группы нет совпадений в group_topics');
      console.log('  либо subject_key в event_subjects не совпадает с subject_key в group_topics.');
    }
  } else {
    for (const t of out) {
      const threadLabel = t.threadId == null ? 'General (thread_id=null)' : `topic_id=${t.threadId}`;
      console.log(`  chat_id=${t.chatId} ${threadLabel}`);
    }
  }
  console.log('');
  console.log('--- Уже отправлено (event_chat_messages) ---');
  if (sent.length === 0) {
    console.log('  (пока ничего)');
  } else {
    for (const s of sent) {
      const threadLabel = s.thread_id == null ? 'General' : `topic_id=${s.thread_id}`;
      console.log(`  chat_id=${s.chat_id} ${threadLabel} role=${s.role}`);
    }
  }
  console.log('');
  console.log('--- Очередь отправки (send_queue, type=chat, этот event) ---');
  if (queueRows.length === 0) {
    console.log('  (нет записей)');
  } else {
    for (const r of queueRows) {
      const threadLabel = r.message_thread_id == null ? 'General' : `topic_id=${r.message_thread_id}`;
      console.log(`  id=${r.id} chat_id=${r.chat_id} ${threadLabel} status=${r.status}`);
    }
  }
}

main();
