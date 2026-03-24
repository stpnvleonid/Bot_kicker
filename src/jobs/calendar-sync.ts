/**
 * Job 1: Синхронизация календаря (каждые 30 минут).
 * См. TECHNICAL_DESIGN_TELEGRAM.md § 5.1
 */

import { calendar_v3, google } from 'googleapis';
import { getDb } from '../db';
import { getConfig } from '../config';
import { detectSubjectsFromEventText } from '../config/subjects';
import { markJobError, markJobSuccess } from '../db/job-health';

const LOCK_KEY = 'job:calendar_sync';
const LOCK_TTL_MS = 25 * 60 * 1000;

type CalendarConfigRow = {
  id: number;
  calendar_id: string;
  name: string;
  credentials_json: string | null;
  sync_token: string | null;
  last_sync: string | null;
};

type ExistingEventRow = {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  status: 'active' | 'cancelled' | 'completed';
};

function acquireLock(): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM job_locks WHERE key = ? AND expires_at > datetime('now')").get(LOCK_KEY);
  if (row) return false;
  db.prepare(
    `INSERT OR REPLACE INTO job_locks (key, expires_at) VALUES (?, datetime('now', ?))`
  ).run(LOCK_KEY, `+${LOCK_TTL_MS / 1000} seconds`);
  return true;
}

function releaseLock(): void {
  getDb().prepare('DELETE FROM job_locks WHERE key = ?').run(LOCK_KEY);
}

function getTimeWindow(): { timeMin: string; timeMax: string } {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  // Берём события за прошедшие сутки (для отмен/изменений) и только на 7 дней вперёд
  const start = new Date(now - dayMs);
  const end = new Date(now + 7 * dayMs);
  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

function parseEventTimes(event: calendar_v3.Schema$Event): { start_at: string; end_at: string } {
  const toIso = (d?: string | null, allDay?: boolean): string => {
    if (!d) return new Date().toISOString();
    if (allDay) {
      // date-only (YYYY-MM-DD) → treat as UTC midnight
      return new Date(`${d}T00:00:00.000Z`).toISOString();
    }
    return new Date(d).toISOString();
  };

  const allDay = !!event.start?.date;
  const start_at = toIso(event.start?.dateTime || event.start?.date || null, allDay);
  const end_at = toIso(event.end?.dateTime || event.end?.date || null, allDay);
  return { start_at, end_at };
}

function isProxyNetworkError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '');
  const code = String((err as any)?.code ?? (err as any)?.errno ?? '');
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('EHOSTUNREACH') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  );
}

async function buildCalendarClient(): Promise<calendar_v3.Calendar> {
  const config = getConfig();
  if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  return google.calendar({ version: 'v3', auth });
}

function upsertEventAndGroups(
  calConfigId: number,
  gEvent: calendar_v3.Schema$Event,
  times: { start_at: string; end_at: string }
): { eventId: number; kind: 'new_event' | 'updated_event' | 'none' } {
  const db = getDb();
  const googleEventId = gEvent.id;
  if (!googleEventId) {
    return { eventId: 0, kind: 'none' };
  }

  const summary = gEvent.summary ?? '';
  const description = gEvent.description ?? null;
  const status: 'active' = 'active';

  const existing = db
    .prepare(
      `SELECT id, title, description, start_at, end_at, status
       FROM calendar_events
       WHERE calendar_config_id = ? AND google_event_id = ?`
    )
    .get(calConfigId, googleEventId) as ExistingEventRow | undefined;

  if (!existing) {
    const result = db
      .prepare(
        `INSERT INTO calendar_events
         (calendar_config_id, google_event_id, title, description, start_at, end_at, raw_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        calConfigId,
        googleEventId,
        summary,
        description,
        times.start_at,
        times.end_at,
        JSON.stringify(gEvent),
        status
      );
    const eventId = Number(result.lastInsertRowid);
    syncEventGroups(calConfigId, eventId);
    syncEventSubjects(eventId, summary, description);
    // Больше не шлём мгновенные уведомления о новых событиях.
    return { eventId, kind: 'new_event' };
  }

  const changed =
    existing.title !== summary ||
    (existing.description ?? null) !== (description ?? null) ||
    existing.start_at !== times.start_at ||
    existing.end_at !== times.end_at ||
    existing.status !== status;

  if (!changed) {
    return { eventId: existing.id, kind: 'none' };
  }

  db.prepare(
    `UPDATE calendar_events
     SET title = ?, description = ?, start_at = ?, end_at = ?, raw_json = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(summary, description, times.start_at, times.end_at, JSON.stringify(gEvent), status, existing.id);

  syncEventGroups(calConfigId, existing.id);
  syncEventSubjects(existing.id, summary, description);
  // Больше не шлём мгновенные уведомления об обновлениях.
  return { eventId: existing.id, kind: 'updated_event' };
}

function handleCancelledEvent(calConfigId: number, googleEventId: string): void {
  const db = getDb();
  const row = db
    .prepare('SELECT id, status FROM calendar_events WHERE calendar_config_id = ? AND google_event_id = ?')
    .get(calConfigId, googleEventId) as ExistingEventRow | undefined;
  if (!row) return;
  if (row.status === 'cancelled') return;
  db.prepare(
    `UPDATE calendar_events
     SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ?`
  ).run(row.id);
  enqueueNotification(row.id, 'cancelled_event');
}

function syncEventGroups(calendarConfigId: number, eventId: number): void {
  const db = getDb();
  const groups = db
    .prepare('SELECT id FROM groups WHERE calendar_config_id = ?')
    .all(calendarConfigId) as Array<{ id: number }>;
  const desiredIds = new Set(groups.map((g) => g.id));

  const existing = db
    .prepare('SELECT group_id FROM event_groups WHERE event_id = ?')
    .all(eventId) as Array<{ group_id: number }>;
  const existingIds = new Set(existing.map((g) => g.group_id));

  for (const gid of desiredIds) {
    if (!existingIds.has(gid)) {
      db.prepare('INSERT INTO event_groups (event_id, group_id) VALUES (?, ?)').run(eventId, gid);
    }
  }
  for (const gid of existingIds) {
    if (!desiredIds.has(gid)) {
      db.prepare('DELETE FROM event_groups WHERE event_id = ? AND group_id = ?').run(eventId, gid);
    }
  }
}

/** Событие в будущем (или недавно началось), чтобы не слать уведомления о старых. */
function isEventInFuture(startAtIso: string, marginMinutes = 5): boolean {
  const startMs = new Date(startAtIso).getTime();
  return startMs >= Date.now() - marginMinutes * 60 * 1000;
}

function enqueueNotification(eventId: number, type: 'new_event' | 'updated_event' | 'cancelled_event', startAtIso?: string): void {
  if (type === 'new_event' || type === 'updated_event') {
    if (!startAtIso || !isEventInFuture(startAtIso)) return;
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO notification_queue (event_id, type, status)
     VALUES (?, ?, 'pending')`
  ).run(eventId, type);
}

function syncEventSubjects(eventId: number, title: string | null, description: string | null): void {
  try {
    const db = getDb();
    const subjectKeys = detectSubjectsFromEventText(title, description);
    db.prepare('DELETE FROM event_subjects WHERE event_id = ?').run(eventId);
    for (const sk of subjectKeys) {
      db.prepare('INSERT INTO event_subjects (event_id, subject_key) VALUES (?, ?)').run(eventId, sk);
    }
  } catch (e) {
    if (String((e as { message?: string })?.message || e).includes('no such table')) return;
    throw e;
  }
}

export async function runCalendarSyncJob(options?: { force?: boolean }): Promise<void> {
  if (!options?.force && !acquireLock()) {
    console.log('[Job1] Calendar sync skipped: lock held');
    return;
  }
  try {
    const db = getDb();
    const { timeMin, timeMax } = getTimeWindow();
    // Telegram proxying only; keep Google Calendar traffic direct.
    const useProxy = false;

    let calendar: calendar_v3.Calendar;
    let calendarDirect: calendar_v3.Calendar | null = null;
    // `useProxy` kept for future compatibility, but currently always false.
    calendar = await buildCalendarClient();

    // Храним события только в окне синхронизации: от timeMin до timeMax (7 дней вперёд).
    // Сначала чистим связанные задачи в send_queue, иначе возникнет FOREIGN KEY constraint (event_id → calendar_events.id).
    db.prepare(
      `DELETE FROM send_queue
       WHERE event_id IN (SELECT id FROM calendar_events WHERE start_at > ?)`
    ).run(timeMax);
    db.prepare('DELETE FROM calendar_events WHERE start_at > ?').run(timeMax);

    const calendarConfigs = db
      .prepare(
        `SELECT id, calendar_id, name, credentials_json, sync_token, last_sync
         FROM calendar_config
         WHERE enabled = 1`
      )
      .all() as CalendarConfigRow[];

    console.log(
      `[Job1] Starting sync for ${calendarConfigs.length} calendar(s) in window ${timeMin} → ${timeMax}`
    );

    for (const cfg of calendarConfigs) {
      console.log(`[Job1] Sync calendar id=${cfg.id} calendar_id=${cfg.calendar_id}`);
      let inserted = 0;
      let updated = 0;
      let cancelled = 0;
      // Для полного окна (без sync_token) будем отслеживать, какие события реально пришли,
      // чтобы пометить как отменённые те, что были в БД, но больше не приходят из Google.
      const fetchedIds = new Set<string>();

      try {
        const events: calendar_v3.Schema$Event[] = [];
        let pageToken: string | undefined;
        let nextSyncToken: string | undefined;

        const baseParams: calendar_v3.Params$Resource$Events$List = cfg.sync_token
          ? { calendarId: cfg.calendar_id, syncToken: cfg.sync_token }
          : {
              calendarId: cfg.calendar_id,
              timeMin,
              timeMax,
              singleEvents: true,
              orderBy: 'startTime',
            };

        do {
          let apiRes: any;
          try {
            apiRes = await calendar.events.list({ ...baseParams, pageToken });
          } catch (err) {
            // If the proxy was used and failed mid-run (e.g. connection reset),
            // build a direct client once and retry the same page request.
            // Since Google traffic is always direct, just rethrow.
            throw err;
          }

          const data = apiRes.data;
          if (data.items) {
            events.push(...data.items);
          }
          pageToken = data.nextPageToken || undefined;
          if (data.nextSyncToken) {
            nextSyncToken = data.nextSyncToken;
          }
        } while (pageToken);

        for (const ev of events) {
          if (!ev.id) continue;
          if (ev.status === 'cancelled') {
            handleCancelledEvent(cfg.id, ev.id);
            cancelled += 1;
            continue;
          }
          const times = parseEventTimes(ev);
          const res = upsertEventAndGroups(cfg.id, ev, times);
          if (res.kind === 'new_event') inserted += 1;
          if (res.kind === 'updated_event') updated += 1;
          // В полном режиме (без sync_token) запоминаем id всех живых событий в окне.
          if (!cfg.sync_token) {
            fetchedIds.add(ev.id);
          }
        }

        console.log(
          `[Job1] Calendar ${cfg.calendar_id}: fetched=${events.length}, inserted=${inserted}, updated=${updated}, cancelled=${cancelled}`
        );

        // Если синхронизируемся по окну (без sync_token): события, которые были у нас как active,
        // но больше не приходят из Google в том же окне, считаем удалёнными в календаре и помечаем как cancelled.
        if (!cfg.sync_token) {
          const fetchedIdsArr = Array.from(fetchedIds);
          const notInClause = fetchedIdsArr.length
            ? `AND google_event_id NOT IN (${fetchedIdsArr.map(() => '?').join(',')})`
            : '';
          const missing = db
            .prepare(
              `SELECT id, google_event_id
               FROM calendar_events
               WHERE calendar_config_id = ?
                 AND status = 'active'
                 AND start_at BETWEEN ? AND ?
                 ${notInClause}`
            )
            .all(
              cfg.id,
              timeMin,
              timeMax,
              ...fetchedIdsArr
            ) as Array<{ id: number; google_event_id: string }>;

          if (missing.length) {
            console.log(
              `[Job1] Calendar ${cfg.calendar_id}: marking ${missing.length} missing events as cancelled (not returned by API)`
            );
            for (const ev of missing) {
              handleCancelledEvent(cfg.id, ev.google_event_id);
            }
          }
        }

        if (nextSyncToken) {
          db.prepare(
            `UPDATE calendar_config
             SET sync_token = ?, last_sync = datetime('now'), sync_error = 0, updated_at = datetime('now')
             WHERE id = ?`
          ).run(nextSyncToken, cfg.id);
        } else {
          db.prepare(
            `UPDATE calendar_config
             SET last_sync = datetime('now'), sync_error = 0, updated_at = datetime('now')
             WHERE id = ?`
          ).run(cfg.id);
        }
      } catch (err) {
        console.error('[Job1] Error syncing calendar', cfg.calendar_id, err);
        db.prepare(
          `UPDATE calendar_config
           SET sync_error = 1, updated_at = datetime('now')
           WHERE id = ?`
        ).run(cfg.id);
      }
    }

    db.prepare(
      `UPDATE calendar_events
       SET status = 'completed', updated_at = datetime('now')
       WHERE status = 'active' AND end_at < datetime('now', '-1 day')`
    ).run();

    console.log('[Job1] Calendar sync finished');
    markJobSuccess('job1_calendar_sync');
  } catch (e) {
    console.error('[Job1] Calendar sync error:', e);
    markJobError('job1_calendar_sync', e);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  // Позволяет запускать джобу напрямую: npx ts-node src/jobs/calendar-sync.ts
  runCalendarSyncJob().catch((e) => {
    console.error('[Job1] Fatal error:', e);
    process.exit(1);
  });
}


