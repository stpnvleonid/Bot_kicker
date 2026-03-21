import { getDb } from '../db';
import { detectSubjectsFromEventText, SUBJECT_TOPIC_NAMES } from '../config/subjects';
import { ensureExamSubmissionExists, getSubmissionForModeration, setExamLastPromptedAt, type PlannerExamKind, type PlannerExamSubmissionRow } from '../db/planner-exams';
import { getMoscowIsoDateFromIso, getWeekRangeMonSat, formatRuShortDate } from '../utils/date-helpers';

const EXAMS_KEYWORD = 'exams';
const LOOKBACK_DAYS = 21;

function isExamsEvent(title: string, description: string | null | undefined): boolean {
  const text = `${title ?? ''} ${description ?? ''}`.toLowerCase();
  return text.includes(EXAMS_KEYWORD);
}

function getPrimarySubjectKey(subjectKeys: string[]): string | null {
  if (!subjectKeys.length) return null;
  return [...subjectKeys].sort()[0] ?? null;
}

function ensureEventSubjects(db: ReturnType<typeof getDb>, eventId: number, title: string, description: string | null): string[] {
  const existing = db.prepare('SELECT subject_key FROM event_subjects WHERE event_id = ?').all(eventId) as Array<{ subject_key: string }>;
  const keys = existing.map((r) => r.subject_key);
  if (keys.length > 0) return keys;

  const detected = detectSubjectsFromEventText(title, description);
  for (const sk of detected) {
    db.prepare('INSERT OR IGNORE INTO event_subjects (event_id, subject_key) VALUES (?, ?)').run(eventId, sk);
  }
  return detected;
}

function studentEligibleForEvent(
  db: ReturnType<typeof getDb>,
  studentId: number,
  eventId: number,
  subjectKeys: string[]
): boolean {
  if (subjectKeys.length > 0) {
    const placeholders = subjectKeys.map(() => '?').join(',');
    return !!db
      .prepare(
        `SELECT 1
         FROM event_groups eg
         JOIN student_groups sg ON sg.group_id = eg.group_id
         JOIN students s ON s.id = sg.student_id
         WHERE eg.event_id = ?
           AND s.id = ?
           AND s.notify_dm = 1 AND s.dm_blocked = 0
           AND EXISTS (
             SELECT 1 FROM student_subjects ss
             WHERE ss.student_id = s.id AND ss.subject_key IN (${placeholders})
           )
         LIMIT 1`
      )
      .get(eventId, studentId, ...subjectKeys);
  }

  return !!db
    .prepare(
      `SELECT 1
       FROM event_groups eg
       JOIN student_groups sg ON sg.group_id = eg.group_id
       JOIN students s ON s.id = sg.student_id
       WHERE eg.event_id = ?
         AND s.id = ?
         AND s.notify_dm = 1 AND s.dm_blocked = 0
       LIMIT 1`
    )
    .get(eventId, studentId);
}

function getExamEventsInLookback(db: ReturnType<typeof getDb>, fromIso: string, toIso: string): Array<{ id: number; title: string; description: string | null; start_at: string }> {
  return db
    .prepare(
      `SELECT id, title, description, start_at
       FROM calendar_events
       WHERE status = 'active'
         AND start_at >= ? AND start_at <= ?
         AND (
           LOWER(COALESCE(title,'')) LIKE '%' || LOWER(?) || '%'
           OR LOWER(COALESCE(description,'')) LIKE '%' || LOWER(?) || '%'
         )
       ORDER BY start_at`
    )
    .all(fromIso, toIso, EXAMS_KEYWORD, EXAMS_KEYWORD) as Array<{ id: number; title: string; description: string | null; start_at: string }>;
}

export async function ensureExamSubmissionsForStudent(studentId: number, screenDateIso: string): Promise<void> {
  const db = getDb();

  const screenDateMoscow = getMoscowIsoDateFromIso(`${screenDateIso}T00:00:00.000Z`);
  const lookbackStart = new Date(`${screenDateMoscow}T00:00:00.000Z`);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - LOOKBACK_DAYS);
  const fromIso = lookbackStart.toISOString();
  const toIso = new Date(`${screenDateMoscow}T23:59:59.000Z`).toISOString();

  const events = getExamEventsInLookback(db, fromIso, toIso);

  for (const ev of events) {
    if (!isExamsEvent(ev.title, ev.description)) continue;

    const lessonDate = getMoscowIsoDateFromIso(ev.start_at);
    if (lessonDate > screenDateMoscow) continue; // ещё не вышел

    const subjectKeys = ensureEventSubjects(db, ev.id, ev.title, ev.description);
    const subjectKeyPrimary = getPrimarySubjectKey(subjectKeys);

    if (!studentEligibleForEvent(db, studentId, ev.id, subjectKeys)) continue;

    ensureExamSubmissionExists({
      studentId,
      lessonEventId: ev.id,
      kind: 'lesson',
      lessonDate,
      subjectKey: subjectKeyPrimary,
    });
    ensureExamSubmissionExists({
      studentId,
      lessonEventId: ev.id,
      kind: 'homework',
      lessonDate,
      subjectKey: subjectKeyPrimary,
    });
  }
}

export async function selectPendingExamSubmissionsForStudent(params: {
  studentId: number;
  screenDateIso: string; // YYYY-MM-DD (planner day)
  maxLessons: number; // 2
  maxHomeworks: number; // 2
  markPromptedAt?: boolean; // default true for evening screen, false for morning preview
}): Promise<{
  selected: Array<
    PlannerExamSubmissionRow & {
      subjectLabel: string;
      itemTitle: string;
      lastConfirmedCompletionDateLabel: string | null;
      completionDateLabel: string | null;
    }
  >;
  totalLessons: number;
  totalHomeworks: number;
  totalPending: number;
}> {
  const { studentId, screenDateIso, maxLessons, maxHomeworks, markPromptedAt = true } = params;
  const db = getDb();

  // Ensure records exist for relevant events in the lookback window.
  await ensureExamSubmissionsForStudent(studentId, screenDateIso);

  const screenDateMoscow = getMoscowIsoDateFromIso(`${screenDateIso}T00:00:00.000Z`);
  const { weekStart, weekEnd } = getWeekRangeMonSat(screenDateMoscow);

  const rows = db
    .prepare(
      `SELECT *
       FROM planner_exam_submissions
       WHERE student_id = ?
         AND status IN ('pending','rejected')
         AND lesson_date <= ?`
    )
    .all(studentId, screenDateMoscow) as PlannerExamSubmissionRow[];

  const lessons = rows.filter((r) => r.kind === 'lesson');
  const homeworks = rows.filter((r) => r.kind === 'homework');

  const lessonEventIdSet = new Set<number>();

  const sortByPromptThenDate = (a: PlannerExamSubmissionRow, b: PlannerExamSubmissionRow): number => {
    // 1) null last_prompted_at first => "others will come tomorrow"
    const aNull = a.last_prompted_at == null ? 0 : 1;
    const bNull = b.last_prompted_at == null ? 0 : 1;
    if (aNull !== bNull) return aNull - bNull;
    if (a.last_prompted_at && b.last_prompted_at) {
      if (a.last_prompted_at !== b.last_prompted_at) return a.last_prompted_at.localeCompare(b.last_prompted_at);
    }
    // 2) older lesson_date first
    if (a.lesson_date !== b.lesson_date) return a.lesson_date.localeCompare(b.lesson_date);
    return a.id - b.id;
  };

  const inWeekPassed = (lessonDate: string): boolean => lessonDate >= weekStart && lessonDate <= weekEnd;

  lessons.sort((a, b) => {
    const aIn = inWeekPassed(a.lesson_date);
    const bIn = inWeekPassed(b.lesson_date);
    if (aIn !== bIn) return aIn ? -1 : 1;
    return sortByPromptThenDate(a, b);
  });

  const pickedLessons = lessons.slice(0, maxLessons);
  for (const l of pickedLessons) lessonEventIdSet.add(l.lesson_event_id);

  homeworks.sort((a, b) => {
    const aIn = inWeekPassed(a.lesson_date);
    const bIn = inWeekPassed(b.lesson_date);
    if (aIn !== bIn) return aIn ? -1 : 1;

    const aMatches = lessonEventIdSet.has(a.lesson_event_id);
    const bMatches = lessonEventIdSet.has(b.lesson_event_id);
    if (aMatches !== bMatches) return aMatches ? -1 : 1;

    return sortByPromptThenDate(a, b);
  });

  const pickedHomeworks = homeworks.slice(0, maxHomeworks);

  const selected = [...pickedLessons, ...pickedHomeworks];
  if (markPromptedAt) {
    setExamLastPromptedAt(selected.map((s) => s.id));
  }

  const mapped = selected.map((s) => {
    const subjectLabel = s.subject_key ? (SUBJECT_TOPIC_NAMES[s.subject_key] ?? s.subject_key) : '(предмет не определён)';
    const dateLabel = formatRuShortDate(s.lesson_date);
    const itemKindLabel = s.kind === 'lesson' ? 'Урок' : 'ДЗ';
    const itemTitle = `${subjectLabel} ${itemKindLabel} ${dateLabel}`;
    const lastConfirmedCompletionDateLabel = s.last_confirmed_completion_date ? formatRuShortDate(s.last_confirmed_completion_date) : null;
    const completionDateLabel = s.completion_date ? formatRuShortDate(s.completion_date) : null;
    return { ...s, subjectLabel, itemTitle, lastConfirmedCompletionDateLabel, completionDateLabel };
  });

  return {
    selected: mapped,
    totalLessons: lessons.length,
    totalHomeworks: homeworks.length,
    totalPending: lessons.length + homeworks.length,
  };
}

