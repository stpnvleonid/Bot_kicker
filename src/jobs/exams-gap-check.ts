import { getDb } from '../db';
import { markJobError, markJobSuccess } from '../db/job-health';

export async function runExamsGapCheckJob(options?: {
  weekStart?: string;
  weekEnd?: string;
  suppressJobHealth?: boolean;
}): Promise<void> {
  const db = getDb();
  const weekStart =
    options?.weekStart ??
    db.prepare("SELECT date('now', 'weekday 1', '-7 days') AS d").get() as { d: string };
  const weekEnd =
    options?.weekEnd ??
    db.prepare("SELECT date(?, '+5 days') AS d").get((weekStart as any).d ?? weekStart) as { d: string };

  const startIso = typeof weekStart === 'string' ? weekStart : weekStart.d;
  const endIso = typeof weekEnd === 'string' ? weekEnd : weekEnd.d;

  try {
    const rows = db
      .prepare(
        `WITH exams_events AS (
           SELECT ce.id AS event_id, ce.start_at
           FROM calendar_events ce
           WHERE ce.status = 'active'
             AND date(ce.start_at) BETWEEN ? AND ?
             AND (
               LOWER(COALESCE(ce.title,'')) LIKE '%exams%'
               OR LOWER(COALESCE(ce.description,'')) LIKE '%exams%'
             )
         ),
         event_subjects_joined AS (
           SELECT ee.event_id, GROUP_CONCAT(es.subject_key, ',') AS subject_keys
           FROM exams_events ee
           LEFT JOIN event_subjects es ON es.event_id = ee.event_id
           GROUP BY ee.event_id
         ),
         eligible AS (
           SELECT ee.event_id, COUNT(DISTINCT s.id) AS eligible_count
           FROM exams_events ee
           JOIN event_groups eg ON eg.event_id = ee.event_id
           JOIN student_groups sg ON sg.group_id = eg.group_id
           JOIN students s ON s.id = sg.student_id
           WHERE s.notify_dm = 1 AND s.dm_blocked = 0
             AND (
               NOT EXISTS (SELECT 1 FROM event_subjects es0 WHERE es0.event_id = ee.event_id)
               OR EXISTS (
                 SELECT 1
                 FROM student_subjects ss
                 JOIN event_subjects es1 ON es1.subject_key = ss.subject_key
                 WHERE ss.student_id = s.id AND es1.event_id = ee.event_id
               )
             )
           GROUP BY ee.event_id
         ),
         submissions AS (
           SELECT lesson_event_id AS event_id, COUNT(*) AS submissions_count
           FROM planner_exam_submissions
           WHERE lesson_date BETWEEN ? AND ?
           GROUP BY lesson_event_id
         )
         SELECT ee.event_id,
                ee.start_at,
                COALESCE(esj.subject_keys, '') AS subject_keys,
                COALESCE(el.eligible_count, 0) AS eligible_count,
                COALESCE(sb.submissions_count, 0) AS submissions_count
         FROM exams_events ee
         LEFT JOIN event_subjects_joined esj ON esj.event_id = ee.event_id
         LEFT JOIN eligible el ON el.event_id = ee.event_id
         LEFT JOIN submissions sb ON sb.event_id = ee.event_id
         WHERE COALESCE(el.eligible_count, 0) > 0
           AND COALESCE(sb.submissions_count, 0) = 0
         ORDER BY ee.start_at`
      )
      .all(startIso, endIso, startIso, endIso) as Array<{
      event_id: number;
      start_at: string;
      subject_keys: string;
      eligible_count: number;
      submissions_count: number;
    }>;

    if (rows.length > 0) {
      console.warn(
        `[ExamsGapCheck] gaps found for ${startIso}..${endIso}:`,
        rows.map((r) => `#${r.event_id}[${r.subject_keys || 'none'}]: eligible=${r.eligible_count}`).join('; ')
      );
      if (!options?.suppressJobHealth) {
        markJobError(
          'job7_exams_gap_check',
          new Error(`gaps=${rows.length} in ${startIso}..${endIso}`)
        );
      }
      return;
    }

    console.log(`[ExamsGapCheck] no gaps for ${startIso}..${endIso}`);
    if (!options?.suppressJobHealth) {
      markJobSuccess('job7_exams_gap_check');
    }
  } catch (e) {
    console.error('[ExamsGapCheck] failed:', e);
    if (!options?.suppressJobHealth) {
      markJobError('job7_exams_gap_check', e);
    }
    throw e;
  }
}

