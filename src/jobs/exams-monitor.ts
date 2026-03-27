import { getDb } from '../db';
import { detectSubjectsFromEventText } from '../config/subjects';
import { getWeekRangeMonSat } from '../utils/date-helpers';

type ExamsEventRow = {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
};

export type ExamsMonitorParams = {
  weekDateIso: string;
  subjectKey?: string | null;
};

function getExamEventsInWeek(db: ReturnType<typeof getDb>, weekStart: string, weekEnd: string): ExamsEventRow[] {
  const fromIso = `${weekStart}T00:00:00.000Z`;
  const toIso = `${weekEnd}T23:59:59.999Z`;
  return db
    .prepare(
      `SELECT id, title, description, start_at
       FROM calendar_events
       WHERE status = 'active'
         AND start_at >= ? AND start_at <= ?
         AND (
           LOWER(COALESCE(title,'')) LIKE '%exams%'
           OR LOWER(COALESCE(description,'')) LIKE '%exams%'
         )
       ORDER BY start_at`
    )
    .all(fromIso, toIso) as ExamsEventRow[];
}

function getEventSubjectKeys(db: ReturnType<typeof getDb>, eventId: number): string[] {
  const rows = db
    .prepare('SELECT subject_key FROM event_subjects WHERE event_id = ? ORDER BY subject_key')
    .all(eventId) as Array<{ subject_key: string }>;
  return rows.map((r) => r.subject_key);
}

function countEligibleForEvent(
  db: ReturnType<typeof getDb>,
  eventId: number,
  subjectKeys: string[]
): number {
  if (subjectKeys.length > 0) {
    const placeholders = subjectKeys.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT s.id) AS c
         FROM event_groups eg
         JOIN student_groups sg ON sg.group_id = eg.group_id
         JOIN students s ON s.id = sg.student_id
         WHERE eg.event_id = ?
           AND s.notify_dm = 1
           AND s.dm_blocked = 0
           AND EXISTS (
             SELECT 1 FROM student_subjects ss
             WHERE ss.student_id = s.id
               AND ss.subject_key IN (${placeholders})
           )`
      )
      .get(eventId, ...subjectKeys) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT s.id) AS c
       FROM event_groups eg
       JOIN student_groups sg ON sg.group_id = eg.group_id
       JOIN students s ON s.id = sg.student_id
       WHERE eg.event_id = ?
         AND s.notify_dm = 1
         AND s.dm_blocked = 0`
    )
    .get(eventId) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function buildExamsMonitorReport(params: ExamsMonitorParams): string[] {
  const { weekDateIso, subjectKey = null } = params;
  const { weekStart, weekEnd } = getWeekRangeMonSat(weekDateIso);
  const db = getDb();

  const lines: string[] = [];
  lines.push('=== Exams monitor ===');
  lines.push(`week_start: ${weekStart}`);
  lines.push(`week_end: ${weekEnd}`);
  lines.push(`subject: ${subjectKey ?? 'all'}`);
  lines.push('');

  const submissionsSql =
    `SELECT COALESCE(subject_key, 'unknown') AS subject_key, kind, status, COUNT(*) AS cnt
     FROM planner_exam_submissions
     WHERE lesson_date BETWEEN ? AND ?
       AND kind IN ('lesson','homework')` +
    (subjectKey ? ` AND COALESCE(subject_key, 'unknown') = ?` : '') +
    `
     GROUP BY COALESCE(subject_key, 'unknown'), kind, status
     ORDER BY subject_key, kind, status`;
  const submissions = (subjectKey
    ? db.prepare(submissionsSql).all(weekStart, weekEnd, subjectKey)
    : db.prepare(submissionsSql).all(weekStart, weekEnd)) as Array<{
    subject_key: string;
    kind: 'lesson' | 'homework';
    status: 'pending' | 'confirmed' | 'rejected';
    cnt: number;
  }>;

  lines.push('--- submissions by subject/kind/status ---');
  if (!submissions.length) {
    lines.push('(нет строк)');
  } else {
    for (const r of submissions) {
      lines.push(`${r.subject_key} | ${r.kind} | ${r.status} | ${r.cnt}`);
    }
  }
  lines.push('');

  const events = getExamEventsInWeek(db, weekStart, weekEnd);
  const diagnostics: Array<{
    event_id: number;
    start_at: string;
    title: string;
    subject_keys: string;
    subject_keys_source: 'event_subjects' | 'detected_runtime' | 'none';
    eligible_students: number;
    submissions_scope: number;
  }> = [];

  for (const ev of events) {
    const fromEventSubjects = getEventSubjectKeys(db, ev.id);
    let subjectKeys = fromEventSubjects;
    let source: 'event_subjects' | 'detected_runtime' | 'none' = 'event_subjects';
    if (!subjectKeys.length) {
      const detected = detectSubjectsFromEventText(ev.title, ev.description);
      if (detected.length) {
        subjectKeys = detected;
        source = 'detected_runtime';
      } else {
        source = 'none';
      }
    }

    if (subjectKey && !subjectKeys.includes(subjectKey)) {
      continue;
    }

    const eligibleCount = countEligibleForEvent(db, ev.id, subjectKey ? [subjectKey] : subjectKeys);
    const countSql =
      `SELECT COUNT(*) AS c
       FROM planner_exam_submissions
       WHERE lesson_event_id = ?
         AND lesson_date BETWEEN ? AND ?` +
      (subjectKey ? ` AND COALESCE(subject_key, 'unknown') = ?` : '');
    const countRow = (subjectKey
      ? db.prepare(countSql).get(ev.id, weekStart, weekEnd, subjectKey)
      : db.prepare(countSql).get(ev.id, weekStart, weekEnd)) as { c: number } | undefined;

    diagnostics.push({
      event_id: ev.id,
      start_at: ev.start_at,
      title: ev.title,
      subject_keys: subjectKeys.join(',') || '(none)',
      subject_keys_source: source,
      eligible_students: eligibleCount,
      submissions_scope: countRow?.c ?? 0,
    });
  }

  lines.push('--- events diagnostics ---');
  if (!diagnostics.length) {
    lines.push('(нет exams-событий под фильтр)');
  } else {
    for (const d of diagnostics) {
      lines.push(
        `#${d.event_id} | ${d.start_at} | subj=[${d.subject_keys}] (${d.subject_keys_source}) | eligible=${d.eligible_students} | submissions=${d.submissions_scope}`
      );
      lines.push(`   ${d.title}`);
    }
  }
  lines.push('');

  const noSubjects = diagnostics.filter((e) => e.subject_keys_source === 'none');
  const noEligible = diagnostics.filter((e) => e.eligible_students === 0);
  const noSubmissions = diagnostics.filter((e) => e.submissions_scope === 0);
  lines.push('--- hints ---');
  if (noSubjects.length) {
    lines.push(`without subject keys: ${noSubjects.map((e) => e.event_id).join(', ')}`);
  }
  if (noEligible.length) {
    lines.push(`zero eligible: ${noEligible.map((e) => e.event_id).join(', ')}`);
  }
  if (noSubmissions.length) {
    lines.push(`zero submissions: ${noSubmissions.map((e) => e.event_id).join(', ')}`);
  }
  if (!noSubjects.length && !noEligible.length && !noSubmissions.length) {
    lines.push('no obvious issues found');
  }

  return lines;
}

