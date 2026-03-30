import { getMoscowIsoDateFromIso, getWeekRangeMonSat } from '../utils/date-helpers';
import { getDb } from '../db';

export type ExamsReviewQueueItem = {
  submissionId: number;
  studentId: number;
  lessonDate: string;
  subjectKey: string;
  kind: 'lesson' | 'homework';
  lastSubmittedAt: string | null;
};

export type ExamsReviewQueueResult = {
  weekStart: string;
  weekEnd: string;
  effectiveEnd: string;
  items: ExamsReviewQueueItem[];
  bySubjectKind: Array<{ subjectKey: string; kind: 'lesson' | 'homework'; count: number }>;
};

function clampEffectiveEnd(weekEnd: string): string {
  const todayMoscow = getMoscowIsoDateFromIso(new Date().toISOString());
  return todayMoscow < weekEnd ? todayMoscow : weekEnd;
}

export function buildExamsReviewQueue(params: {
  weekDateIso: string;
  subjectKey?: string | null;
}): ExamsReviewQueueResult {
  const { weekDateIso, subjectKey = null } = params;
  const { weekStart, weekEnd } = getWeekRangeMonSat(weekDateIso);
  const effectiveEnd = clampEffectiveEnd(weekEnd);
  const db = getDb();

  const where =
    `WHERE pes.status = 'pending'
       AND pes.evidence_file_id IS NOT NULL
       AND pes.lesson_date BETWEEN ? AND ?` +
    (subjectKey ? ` AND COALESCE(pes.subject_key, 'unknown') = ?` : '');

  const itemsSql =
    `SELECT pes.id AS submission_id,
            pes.student_id AS student_id,
            pes.lesson_date AS lesson_date,
            COALESCE(pes.subject_key, 'unknown') AS subject_key,
            pes.kind AS kind,
            pes.last_submitted_at AS last_submitted_at
     FROM planner_exam_submissions pes
     ${where}
     ORDER BY pes.lesson_date, COALESCE(pes.last_submitted_at, ''), pes.id`;
  const items = (subjectKey
    ? db.prepare(itemsSql).all(weekStart, effectiveEnd, subjectKey)
    : db.prepare(itemsSql).all(weekStart, effectiveEnd)) as Array<{
    submission_id: number;
    student_id: number;
    lesson_date: string;
    subject_key: string;
    kind: 'lesson' | 'homework';
    last_submitted_at: string | null;
  }>;

  const aggSql =
    `SELECT COALESCE(pes.subject_key, 'unknown') AS subject_key,
            pes.kind AS kind,
            COUNT(*) AS c
     FROM planner_exam_submissions pes
     ${where}
     GROUP BY COALESCE(pes.subject_key, 'unknown'), pes.kind
     ORDER BY subject_key, kind`;
  const bySubjectKind = (subjectKey
    ? db.prepare(aggSql).all(weekStart, effectiveEnd, subjectKey)
    : db.prepare(aggSql).all(weekStart, effectiveEnd)) as Array<{
    subject_key: string;
    kind: 'lesson' | 'homework';
    c: number;
  }>;

  return {
    weekStart,
    weekEnd,
    effectiveEnd,
    items: items.map((i) => ({
      submissionId: i.submission_id,
      studentId: i.student_id,
      lessonDate: i.lesson_date,
      subjectKey: i.subject_key,
      kind: i.kind,
      lastSubmittedAt: i.last_submitted_at,
    })),
    bySubjectKind: bySubjectKind.map((r) => ({
      subjectKey: r.subject_key,
      kind: r.kind,
      count: r.c,
    })),
  };
}

