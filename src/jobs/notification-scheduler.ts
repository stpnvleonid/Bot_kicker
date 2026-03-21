/**
 * Job 2: Планировщик уведомлений (каждые 10 минут).
 * Маршрутизация по предметам (event_subjects, group_topics) и фильтр ЛС по student_subjects (без типов событий).
 * Время в сообщениях и окна напоминаний — по TZ из конфигурации (fallback Europe/Moscow).
 */

import { getDb } from '../db';
import { getConfig } from '../config';
import { detectSubjectsFromEventText, SUBJECT_TOPIC_NAMES } from '../config/subjects';
import { markJobError, markJobSuccess } from '../db/job-health';

/** TZ для отображения времени в сообщениях и расчёта тихих часов. */
const DISPLAY_TZ = getConfig().TZ || 'Europe/Moscow';

const LOCK_KEY = 'job:notification_scheduler';
const LOCK_TTL_MS = 8 * 60 * 1000;
const PENDING_BATCH = 50;

function acquireLock(): boolean {
  const db = getDb();
  try {
    const row = db.prepare("SELECT 1 FROM job_locks WHERE key = ? AND expires_at > datetime('now')").get(LOCK_KEY);
    if (row) return false;
    db.prepare(
      `INSERT OR REPLACE INTO job_locks (key, expires_at) VALUES (?, datetime('now', ?))`
    ).run(LOCK_KEY, `+${LOCK_TTL_MS / 1000} seconds`);
    return true;
  } catch (e: any) {
    // Если база временно занята (SQLITE_BUSY) — просто пропускаем этот запуск джоба.
    if (e && typeof e.code === 'string' && e.code === 'SQLITE_BUSY') {
      console.warn('[Job2] acquireLock: database is busy, skipping this run.');
      return false;
    }
    throw e;
  }
}

function releaseLock(): void {
  getDb().prepare('DELETE FROM job_locks WHERE key = ?').run(LOCK_KEY);
}

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    timeZone: DISPLAY_TZ,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatEventTimeRange(startAt: string, endAt: string): string {
  const e = new Date(endAt);
  const time = (d: Date) => d.toLocaleTimeString('ru-RU', { timeZone: DISPLAY_TZ, hour: '2-digit', minute: '2-digit' });
  return `${formatEventDate(startAt)} – ${time(e)}`;
}

/** Сейчас попадает в тихие часы студента? Время считаем по Москве. */
function isNowInQuietHours(
  quietStart: string | null,
  quietEnd: string | null,
  now: Date = new Date()
): boolean {
  if (!quietStart || !quietEnd) return false;
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: DISPLAY_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const minutePart = parts.find((p) => p.type === 'minute')?.value ?? '0';
  const currentMinutes = parseInt(hourPart, 10) * 60 + parseInt(minutePart, 10);

  const [qsHour, qsMin] = quietStart.split(':').map((v) => parseInt(v, 10));
  const [qeHour, qeMin] = quietEnd.split(':').map((v) => parseInt(v, 10));
  if (Number.isNaN(qsHour) || Number.isNaN(qsMin) || Number.isNaN(qeHour) || Number.isNaN(qeMin)) return false;

  const startMinutes = qsHour * 60 + qsMin;
  const endMinutes = qeHour * 60 + qeMin;

  if (startMinutes === endMinutes) return false; // защита от 00:00–00:00

  // Интервал может «переваливать» через полночь (например, 22:00–08:00)
  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

type EventRow = {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  status: string;
  raw_json: string | null;
};

function extractFirstUrlFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s)]+/i);
  return match ? match[0] : null;
}

/** Первая ссылка из location или description события (без HTML, просто URL). */
function extractEventLink(event: EventRow): string | null {
  // Пытаемся прочитать location и description из исходного JSON события
  if (event.raw_json) {
    try {
      const raw = JSON.parse(event.raw_json) as { location?: string | null; description?: string | null };
      const locUrl = extractFirstUrlFromText(raw.location);
      if (locUrl) return locUrl;
      const descUrl = extractFirstUrlFromText(raw.description ?? event.description);
      if (descUrl) return descUrl;
    } catch {
      // игнорируем ошибки парсинга
    }
  }
  // Фоллбек — ищем URL только в description из БД
  return extractFirstUrlFromText(event.description);
}

function formatMainPost(event: EventRow): string {
  const lines = [
    `📅 ${event.title || 'Без названия'}`,
    `🕐 ${formatEventTimeRange(event.start_at, event.end_at)}`,
  ];
  if (event.description?.trim()) {
    lines.push('');
    lines.push(event.description.trim().slice(0, 500));
  }
   const link = extractEventLink(event);
   if (link) {
     lines.push('');
     lines.push(link);
   }
  return lines.join('\n');
}

function formatUpdatePost(event: EventRow): string {
  const base = `🔄 Обновление: ${event.title || 'Событие'} — ${formatEventDate(event.start_at)}`;
  const link = extractEventLink(event);
  return link ? `${base}\n${link}` : base;
}

function formatCancelledPost(event: EventRow): string {
  const base = `❌ Событие отменено: ${event.title || 'Событие'}`;
  const link = extractEventLink(event);
  return link ? `${base}\n${link}` : base;
}

function formatReminder(event: EventRow, kind: '15m' | '5m'): string {
  const when = kind === '15m' ? 'через 15 минут' : 'через 5 минут';
  const base = `⏰ Напоминание: ${when} — ${event.title || 'Событие'}`;
  const link = extractEventLink(event);
  return link ? `${base}\n${link}` : base;
}

/** Неиcследуемые / вспомогательные события (обед, self-study и т.п.), по которым не нужно слать напоминания. */
function isNonAcademicEvent(title: string | null, description: string | null): boolean {
  const text = `${title ?? ''} ${description ?? ''}`.toLowerCase();
  if (!text.trim()) return false;
  if (text.includes('обед')) return true;
  if (text.includes('self-study') || text.includes('self study')) return true;
  return false;
}

function enqueueSend(
  type: 'chat' | 'dm',
  chatId: number,
  text: string,
  opts: { message_thread_id?: number; event_id?: number; student_id?: number; notification_type?: string }
): void {
  // Временное изменение: не отправляем сообщения в группы, только в ЛС.
  if (type === 'chat') return;
  const db = getDb();
  db.prepare(
    `INSERT INTO send_queue (type, chat_id, message_thread_id, text, event_id, student_id, notification_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    type,
    chatId,
    opts.message_thread_id ?? null,
    text,
    opts.event_id ?? null,
    opts.student_id ?? null,
    opts.notification_type ?? null
  );
}

/** Предметы события из event_subjects; если таблицы нет — []. */
export function getEventSubjectKeys(db: ReturnType<typeof getDb>, eventId: number): string[] {
  try {
    const rows = db.prepare('SELECT subject_key FROM event_subjects WHERE event_id = ?').all(eventId) as Array<{ subject_key: string }>;
    return rows.map((r) => r.subject_key);
  } catch {
    return [];
  }
}

/** Если у события пустой event_subjects — вычислить по title/description и заполнить (дозаполнение для старых событий). */
function ensureEventSubjects(
  db: ReturnType<typeof getDb>,
  eventId: number,
  title: string | null,
  description: string | null
): void {
  try {
    const existing = db.prepare('SELECT 1 FROM event_subjects WHERE event_id = ?').get(eventId);
    if (existing) return;
    const keys = detectSubjectsFromEventText(title, description);
    for (const sk of keys) {
      db.prepare('INSERT OR IGNORE INTO event_subjects (event_id, subject_key) VALUES (?, ?)').run(eventId, sk);
    }
  } catch (e) {
    if (String((e as { message?: string })?.message ?? e).includes('no such table')) return;
    throw e;
  }
}

/** Если для события не найдено ни одной цели (chatTargets пустой) — отправить диагностическое ЛС всем админам. */
function sendDiagnosticIfNoTargets(
  db: ReturnType<typeof getDb>,
  event: EventRow,
  groups: Array<{ id: number; name?: string; telegram_chat_id: number; topic_id: number | null }>,
  chatTargets: Array<{ chatId: number; threadId: number | null }>
): void {
  if (chatTargets.length > 0) return;
  try {
    const admins = db.prepare('SELECT telegram_user_id FROM admins').all() as Array<{ telegram_user_id: number }>;
    if (!admins.length) return;
    const subjectKeys = getEventSubjectKeys(db, event.id);
    const subjectsLabel = subjectKeys.length ? subjectKeys.join(', ') : '(не определены)';
    const groupNames =
      groups.map((g) => (g.name && g.name.trim().length ? g.name : String(g.telegram_chat_id))).join(', ') ||
      '(нет групп)';
    const diagText = [
      '⚠️ Не удалось определить ветку для события.',
      '',
      `Событие #${event.id}: ${event.title || 'Без названия'}`,
      `Группы: ${groupNames}`,
      `Предметы (event_subjects): ${subjectsLabel}`,
      '',
      'Проверьте название/описание события и привязку топиков через /link_topic, затем при необходимости выполните /sync_now.',
    ].join('\n');
    for (const a of admins) {
      enqueueSend('dm', a.telegram_user_id, diagText, {});
    }
  } catch (e) {
    if (!String((e as { message?: string })?.message ?? e).includes('no such table')) {
      console.error('[Job2] Diagnostic DM error:', e);
    }
  }
}

/** Сообщение админам: событие без предмета, автоматическая рассылка студентам отключена. */
function notifyAdminsAboutNoSubject(db: ReturnType<typeof getDb>, event: EventRow): void {
  try {
    const admins = db.prepare('SELECT telegram_user_id FROM admins').all() as Array<{ telegram_user_id: number }>;
    if (!admins.length) return;
    const text = [
      '⚠️ Событие без предмета: не рассылается.',
      '',
      `Событие #${event.id}: ${event.title || 'Без названия'}`,
      `Когда: ${formatEventDate(event.start_at)}`,
      '',
      'Если это плановое учебное событие и его нужно разослать студентам, используйте:',
      '/select E=' + event.id,
      '/push Текст сообщения',
    ].join('\n');
    for (const a of admins) {
      enqueueSend('dm', a.telegram_user_id, text, {});
    }
  } catch (e) {
    if (!String((e as { message?: string })?.message ?? e).includes('no such table')) {
      console.error('[Job2] notifyAdminsAboutNoSubject error:', e);
    }
  }
}

/** Цели для поста в чат: по топикам предметов (group_topics) или fallback на group.topic_id.
 * Если у события есть предметы (event_subjects), но для группы не настроены топики (group_topics),
 * в General не шлём — иначе всё сваливается в общий топик. Напоминание уйдёт только после /link_topic в каждом топике. */
function getChatTargetsForEvent(
  db: ReturnType<typeof getDb>,
  eventId: number,
  groups: Array<{ id: number; telegram_chat_id: number; topic_id: number | null }>
): Array<{ chatId: number; threadId: number | null }> {
  const subjectKeys = getEventSubjectKeys(db, eventId);
  const out: Array<{ chatId: number; threadId: number | null }> = [];
  const seen = new Set<string>();
  for (const g of groups) {
    let added = false;
    if (subjectKeys.length > 0) {
      for (const sk of subjectKeys) {
        const row = db.prepare('SELECT topic_id FROM group_topics WHERE group_id = ? AND subject_key = ?').get(g.id, sk) as { topic_id: number } | undefined;
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
      // Fallback: без предметов — в topic_id группы (или General, если null). С предметами в General не шлём.
      if (subjectKeys.length === 0 || g.topic_id != null) {
        const key = `${g.telegram_chat_id}:${g.topic_id ?? 'null'}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ chatId: g.telegram_chat_id, threadId: g.topic_id });
        }
      }
    }
  }
  return out;
}

/** Уже отправлено в этот чат+топик с данной ролью? */
function alreadySentInChat(
  db: ReturnType<typeof getDb>,
  eventId: number,
  chatId: number,
  threadId: number | null,
  role: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM event_chat_messages
       WHERE event_id = ? AND chat_id = ? AND role = ?
       AND ((thread_id IS NULL AND ? IS NULL) OR (thread_id = ?))`
    )
    .get(eventId, chatId, role, threadId, threadId);
  return !!row;
}

/** Студенты для ЛС: при наличии предметов — только с выбранными предметами (student_subjects), иначе все по группе. */
function getStudentsForEventDm(
  db: ReturnType<typeof getDb>,
  eventId: number,
  eventSubjectKeys: string[]
): Array<{
  id: number;
  telegram_user_id: number;
  first_name: string;
  telegram_username: string | null;
  notify_quiet_hours_start: string | null;
  notify_quiet_hours_end: string | null;
}> {
  const base = `FROM event_groups eg
    JOIN student_groups sg ON sg.group_id = eg.group_id
    JOIN students s ON s.id = sg.student_id
    WHERE eg.event_id = ? AND s.notify_dm = 1 AND s.dm_blocked = 0`;
  if (eventSubjectKeys.length > 0) {
    try {
      const placeholders = eventSubjectKeys.map(() => '?').join(',');
      const filtered = db
        .prepare(
          `SELECT DISTINCT s.id, s.telegram_user_id, s.first_name, s.telegram_username, s.notify_quiet_hours_start, s.notify_quiet_hours_end
           ${base}
           AND EXISTS (SELECT 1 FROM student_subjects ss WHERE ss.student_id = s.id AND ss.subject_key IN (${placeholders}))`
        )
        .all(
          eventId,
          ...eventSubjectKeys
        ) as Array<{
        id: number;
        telegram_user_id: number;
        first_name: string;
        telegram_username: string | null;
        notify_quiet_hours_start: string | null;
        notify_quiet_hours_end: string | null;
      }>;
      if (filtered.length > 0) return filtered;
    } catch {
      // таблица student_subjects может отсутствовать
    }
  }
  return db
    .prepare(
      `SELECT s.id, s.telegram_user_id, s.first_name, s.telegram_username, s.notify_quiet_hours_start, s.notify_quiet_hours_end ${base}`
    )
    .all(
      eventId
    ) as Array<{
    id: number;
    telegram_user_id: number;
    first_name: string;
    telegram_username: string | null;
    notify_quiet_hours_start: string | null;
    notify_quiet_hours_end: string | null;
  }>;
}

export async function runNotificationSchedulerJob(): Promise<void> {
  if (!acquireLock()) {
    console.log('[Job2] Notification scheduler skipped: lock held');
    return;
  }
  const db = getDb();
  let stats = { queue: 0, reminder15m: 0, reminder5m: 0 };

  try {
    // —— Шаг 1: Обработка notification_queue (new_event / updated_event / cancelled_event) ——
    const pending = db
      .prepare(
        `SELECT nq.id as task_id, nq.event_id, nq.type as notif_type
         FROM notification_queue nq
         WHERE nq.status = 'pending'
         ORDER BY nq.created_at
         LIMIT ?`
      )
      .all(PENDING_BATCH) as Array<{ task_id: number; event_id: number; notif_type: string }>;

    for (const task of pending) {
      try {
        const event = db
          .prepare(
            'SELECT id, title, description, start_at, end_at, status, raw_json FROM calendar_events WHERE id = ?'
          )
          .get(task.event_id) as EventRow | undefined;
        if (!event || event.status === 'cancelled') {
          db.prepare('UPDATE notification_queue SET status = ? WHERE id = ?').run('processed', task.task_id);
          continue;
        }

        // С этого момента мы не отправляем мгновенные new_event/updated_event вообще.
        // Старые задачи таких типов просто помечаем как обработанные, чтобы не копились.
        if (task.notif_type === 'new_event' || task.notif_type === 'updated_event') {
          db.prepare('UPDATE notification_queue SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
            'processed',
            task.task_id
          );
          continue;
        }

        const groups = db
          .prepare(
            `SELECT g.id, g.telegram_chat_id, g.topic_id, g.name
             FROM event_groups eg
             JOIN groups g ON g.id = eg.group_id
             WHERE eg.event_id = ?`
          )
          .all(task.event_id) as Array<{ id: number; telegram_chat_id: number; topic_id: number | null; name: string }>;

        if (task.notif_type === 'new_event' || task.notif_type === 'updated_event') {
          const role = task.notif_type === 'new_event' ? 'main_post' : 'update';
          const text = task.notif_type === 'new_event' ? formatMainPost(event) : formatUpdatePost(event);
          ensureEventSubjects(db, task.event_id, event.title, event.description);
          const chatTargets = getChatTargetsForEvent(db, task.event_id, groups);
          sendDiagnosticIfNoTargets(db, event, groups, chatTargets);
          for (const t of chatTargets) {
            if (!alreadySentInChat(db, task.event_id, t.chatId, t.threadId, role)) {
              enqueueSend('chat', t.chatId, text, {
                message_thread_id: t.threadId ?? undefined,
                event_id: task.event_id,
                notification_type: role,
              });
              stats.queue += 1;
            }
          }
          const eventSubjectKeys = getEventSubjectKeys(db, task.event_id);
          if (!eventSubjectKeys.length) {
            // Событие без предмета: студентам автоматически не рассылаем, только уведомляем админов.
            notifyAdminsAboutNoSubject(db, event);
          } else {
            const students = getStudentsForEventDm(db, task.event_id, eventSubjectKeys);
            for (const s of students) {
              const already = db.prepare(
                'SELECT 1 FROM event_dm_log WHERE event_id = ? AND student_id = ? AND notification_type = ?'
              ).get(task.event_id, s.id, task.notif_type === 'new_event' ? 'new_event' : 'update');
              if (already) continue;
              if (isNowInQuietHours(s.notify_quiet_hours_start, s.notify_quiet_hours_end)) {
                // В тихие часы не шлём ЛС
                continue;
              }
              const dmText = `Привет${s.first_name ? `, ${s.first_name}` : ''}! Напоминаем: ${
                event.title || 'Событие'
              } — ${formatEventDate(event.start_at)}.`;
              enqueueSend('dm', s.telegram_user_id, dmText, {
                event_id: task.event_id,
                student_id: s.id,
                notification_type: task.notif_type === 'new_event' ? 'new_event' : 'update',
              });
              stats.queue += 1;
            }
          }
        } else if (task.notif_type === 'cancelled_event') {
          const text = formatCancelledPost(event);
          const sentChats = db
            .prepare(
              'SELECT DISTINCT chat_id, thread_id FROM event_chat_messages WHERE event_id = ?'
            )
            .all(task.event_id) as Array<{ chat_id: number; thread_id: number | null }>;
          if (sentChats.length > 0) {
            for (const row of sentChats) {
              enqueueSend('chat', row.chat_id, text, {
                message_thread_id: row.thread_id ?? undefined,
                event_id: task.event_id,
                notification_type: 'cancelled',
              });
              stats.queue += 1;
            }
          } else {
            for (const g of groups) {
              enqueueSend('chat', g.telegram_chat_id, text, {
                message_thread_id: g.topic_id ?? undefined,
                event_id: task.event_id,
                notification_type: 'cancelled',
              });
              stats.queue += 1;
            }
          }
          const dmReceivers = db
            .prepare(
              `SELECT DISTINCT s.id, s.telegram_user_id, s.first_name, s.notify_quiet_hours_start, s.notify_quiet_hours_end
               FROM event_dm_log edl
               JOIN students s ON s.id = edl.student_id
               WHERE edl.event_id = ? AND s.dm_blocked = 0`
            )
            .all(
              task.event_id
            ) as Array<{
            id: number;
            telegram_user_id: number;
            first_name: string;
            notify_quiet_hours_start: string | null;
            notify_quiet_hours_end: string | null;
          }>;
          for (const s of dmReceivers) {
            const already = db.prepare(
              'SELECT 1 FROM event_dm_log WHERE event_id = ? AND student_id = ? AND notification_type = ?'
            ).get(task.event_id, s.id, 'cancelled');
            if (!already) {
              if (isNowInQuietHours(s.notify_quiet_hours_start, s.notify_quiet_hours_end)) {
                continue;
              }
              enqueueSend('dm', s.telegram_user_id, `Событие отменено: ${event.title || 'Событие'}.`, {
                event_id: task.event_id,
                student_id: s.id,
                notification_type: 'cancelled',
              });
              stats.queue += 1;
            }
          }
        }

        db.prepare('UPDATE notification_queue SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run('processed', task.task_id);
      } catch (err) {
        console.error('[Job2] Task error', task.task_id, err);
        db.prepare('UPDATE notification_queue SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run('failed', task.task_id);
      }
    }

    // —— Шаг 2: Напоминания за 15 минут (окно 14–16 мин от текущего момента) ——
    const nowMs = Date.now();
    const window15mStart = new Date(nowMs + 14 * 60 * 1000).toISOString();
    const window15mEnd = new Date(nowMs + 16 * 60 * 1000).toISOString();
    const events15m = db
      .prepare(
        `SELECT id, title, description, start_at, end_at, status, raw_json
         FROM calendar_events
         WHERE status = 'active' AND start_at >= ? AND start_at <= ?`
      )
      .all(window15mStart, window15mEnd) as EventRow[];

    for (const event of events15m) {
      if (isNonAcademicEvent(event.title, event.description)) continue;
      const groups = db
        .prepare(
          `SELECT g.id, g.telegram_chat_id, g.topic_id, g.name
           FROM event_groups eg
           JOIN groups g ON g.id = eg.group_id
           WHERE eg.event_id = ?`
        )
        .all(event.id) as Array<{ id: number; telegram_chat_id: number; topic_id: number | null; name: string }>;
      ensureEventSubjects(db, event.id, event.title, event.description);
      const chatTargets = getChatTargetsForEvent(db, event.id, groups);
      sendDiagnosticIfNoTargets(db, event, groups, chatTargets);
      for (const t of chatTargets) {
        if (!alreadySentInChat(db, event.id, t.chatId, t.threadId, 'reminder_24h')) {
          enqueueSend('chat', t.chatId, formatReminder(event, '15m'), {
            message_thread_id: t.threadId ?? undefined,
            event_id: event.id,
            notification_type: 'reminder_24h',
          });
          stats.reminder15m += 1;
        }
      }
      const eventSubjectKeys = getEventSubjectKeys(db, event.id);
      if (eventSubjectKeys.length) {
        const students = getStudentsForEventDm(db, event.id, eventSubjectKeys);
        for (const s of students) {
          const sent = db.prepare(
            'SELECT 1 FROM event_dm_log WHERE event_id = ? AND student_id = ? AND notification_type = ?'
          ).get(event.id, s.id, 'reminder_24h');
          if (sent) continue;
          if (isNowInQuietHours(s.notify_quiet_hours_start, s.notify_quiet_hours_end)) {
            continue;
          }
          enqueueSend('dm', s.telegram_user_id, formatReminder(event, '15m'), {
            event_id: event.id,
            student_id: s.id,
            notification_type: 'reminder_24h',
          });
          stats.reminder15m += 1;
        }
      }
    }

    // —— Шаг 3: Напоминания за 5 минут ——
    const window5mStart = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const window5mEnd = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    const events5m = db
      .prepare(
        `SELECT id, title, description, start_at, end_at, status, raw_json
         FROM calendar_events
         WHERE status = 'active' AND start_at >= ? AND start_at <= ?`
      )
      .all(window5mStart, window5mEnd) as EventRow[];

    for (const event of events5m) {
      if (isNonAcademicEvent(event.title, event.description)) continue;
      const groups = db
        .prepare(
          `SELECT g.id, g.telegram_chat_id, g.topic_id, g.name
           FROM event_groups eg
           JOIN groups g ON g.id = eg.group_id
           WHERE eg.event_id = ?`
        )
        .all(event.id) as Array<{ id: number; telegram_chat_id: number; topic_id: number | null; name: string }>;
      ensureEventSubjects(db, event.id, event.title, event.description);
      const chatTargets = getChatTargetsForEvent(db, event.id, groups);
      sendDiagnosticIfNoTargets(db, event, groups, chatTargets);
      for (const t of chatTargets) {
        if (!alreadySentInChat(db, event.id, t.chatId, t.threadId, 'reminder_1h')) {
          enqueueSend('chat', t.chatId, formatReminder(event, '5m'), {
            message_thread_id: t.threadId ?? undefined,
            event_id: event.id,
            notification_type: 'reminder_1h',
          });
          stats.reminder5m += 1;
        }
      }
      const eventSubjectKeys = getEventSubjectKeys(db, event.id);
      if (eventSubjectKeys.length) {
        const students = getStudentsForEventDm(db, event.id, eventSubjectKeys);
        for (const s of students) {
          const sent = db.prepare(
            'SELECT 1 FROM event_dm_log WHERE event_id = ? AND student_id = ? AND notification_type = ?'
          ).get(event.id, s.id, 'reminder_1h');
          if (sent) continue;
          const confirmed = db.prepare('SELECT 1 FROM reminder_confirmations WHERE event_id = ? AND student_id = ?').get(event.id, s.id);
          if (confirmed) continue;
          if (isNowInQuietHours(s.notify_quiet_hours_start, s.notify_quiet_hours_end)) {
            continue;
          }
          // Перед отправкой 5-минутного напоминания пробуем удалить предыдущее 15-минутное в ЛС (если оно было).
          enqueueSend('dm', s.telegram_user_id, '', {
            event_id: event.id,
            student_id: s.id,
            notification_type: 'delete_dm_reminder_24h',
          });
          enqueueSend('dm', s.telegram_user_id, formatReminder(event, '5m'), {
            event_id: event.id,
            student_id: s.id,
            notification_type: 'reminder_1h',
          });
          stats.reminder5m += 1;
        }
      }
    }

    // —— Шаг 4: Отчёт админам по событиям, которые начались 5–15 мин назад (кто отметил «Буду на занятии») ——
    try {
      const reportWindowStart = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const reportWindowEnd = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const eventsForReport = db
        .prepare(
          `SELECT ce.id, ce.title, ce.start_at
           FROM calendar_events ce
           LEFT JOIN event_report_sent ers ON ers.event_id = ce.id
           WHERE ce.start_at >= ? AND ce.start_at <= ? AND ers.event_id IS NULL`
        )
        .all(reportWindowStart, reportWindowEnd) as Array<{ id: number; title: string; start_at: string }>;

      const admins = db.prepare('SELECT telegram_user_id FROM admins').all() as Array<{ telegram_user_id: number }>;
      const DISPLAY_TZ_REPORT = 'Europe/Moscow';

      for (const ev of eventsForReport) {
        const subjectKeys = getEventSubjectKeys(db, ev.id);
        if (!subjectKeys.length) {
          // Событие без предмета: студентам не рассылается автоматически — отчёт админам не шлём, но помечаем как обработанное.
          db.prepare('INSERT OR REPLACE INTO event_report_sent (event_id, sent_at) VALUES (?, datetime(\'now\'))').run(
            ev.id
          );
          continue;
        }
        const confirmedRows = db
          .prepare(
            `SELECT s.id, s.first_name, s.telegram_username
             FROM reminder_confirmations rc
             JOIN students s ON s.id = rc.student_id
             WHERE rc.event_id = ?`
          )
          .all(ev.id) as Array<{ id: number; first_name: string; telegram_username: string | null }>;
        const recipients = getStudentsForEventDm(db, ev.id, subjectKeys);
        const confirmedIds = new Set(confirmedRows.map((r) => r.id));
        const confirmedNames = confirmedRows.map((s) => (s.telegram_username ? `${s.first_name || '—'} (@${s.telegram_username})` : s.first_name || '—')).join(', ') || '—';
        const notConfirmed = recipients.filter((r) => !confirmedIds.has(r.id));
        const notConfirmedNames = notConfirmed.map((s) => (s.telegram_username ? `${s.first_name || '—'} (@${s.telegram_username})` : s.first_name || '—')).join(', ') || '—';
        const dateStr = new Date(ev.start_at).toLocaleString('ru-RU', {
          timeZone: DISPLAY_TZ_REPORT,
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        const reportText = [
          `Отчёт по событию: ${ev.title || 'Без названия'}`,
          `Дата и время: ${dateStr}`,
          '',
          `Отметили «Буду на занятии»: ${confirmedNames}`,
          `Не отметили: ${notConfirmedNames || '—'}`,
        ].join('\n');

        for (const a of admins) {
          enqueueSend('dm', a.telegram_user_id, reportText, {});
        }
        db.prepare('INSERT OR REPLACE INTO event_report_sent (event_id, sent_at) VALUES (?, datetime(\'now\'))').run(ev.id);
      }
    } catch (e) {
      if (!String((e as { message?: string })?.message ?? e).includes('no such table')) {
        console.error('[Job2] Report step error:', e);
      }
    }

    console.log('[Job2] Done:', { queue: stats.queue, reminder_15m: stats.reminder15m, reminder_5m: stats.reminder5m });
    markJobSuccess('job2_notification_scheduler');
  } catch (e) {
    console.error('[Job2] Notification scheduler error:', e);
    markJobError('job2_notification_scheduler', e);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  runNotificationSchedulerJob().catch((e) => {
    console.error('[Job2] Fatal:', e);
    process.exit(1);
  });
}
