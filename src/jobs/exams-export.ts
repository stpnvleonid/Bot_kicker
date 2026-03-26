import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db';
import { getWeekRangeMonSat } from '../utils/date-helpers';

export type ExamsWeekExportParams = {
  weekDateIso: string; // YYYY-MM-DD
};

export type ExamsWeekExportResult = {
  weekStart: string; // YYYY-MM-DD
  weekEnd: string; // YYYY-MM-DD
  filePath: string;
  fileName: string;
  rows: number;
};

function csvEscape(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function toCsvLine(values: Array<string | number | null | undefined>): string {
  return values
    .map((v) => {
      if (v == null) return '';
      return csvEscape(String(v));
    })
    .join(',');
}

/**
 * Экспорт "exams" за неделю (Пн–Сб) в CSV.
 *
 * Данные минимальные (без ФИО/телеграм):
 * - student_id
 * - lesson_event_id
 * - kind (lesson/homework)
 * - lesson_date (YYYY-MM-DD)
 * - subject_key (unknown если NULL)
 * - status (pending/confirmed)
 * - last_confirmed_completion_date
 *
 * Фильтры:
 * - week: lesson_date BETWEEN weekStart AND weekEnd
 * - kind IN (lesson, homework)
 * - status IN (pending, confirmed)  (expected = pending+confirmed)
 * - оставляем только те (lesson_event_id, kind), где есть хотя бы один confirmed в неделе
 */
export function exportExamsWeekCsv(params: ExamsWeekExportParams): ExamsWeekExportResult {
  const { weekDateIso } = params;
  const { weekStart, weekEnd } = getWeekRangeMonSat(weekDateIso);

  const db = getDb();
  const sql = `
WITH week_events AS (
  SELECT lesson_event_id, kind
  FROM planner_exam_submissions
  WHERE lesson_date BETWEEN ? AND ?
    AND kind IN ('lesson','homework')
    AND status IN ('pending','confirmed')
  GROUP BY lesson_event_id, kind
  HAVING SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) > 0
)
SELECT
  pes.student_id AS student_id,
  pes.lesson_event_id AS lesson_event_id,
  pes.kind AS kind,
  pes.lesson_date AS lesson_date,
  COALESCE(pes.subject_key, 'unknown') AS subject_key,
  pes.status AS status,
  pes.last_confirmed_completion_date AS last_confirmed_completion_date
FROM planner_exam_submissions pes
JOIN week_events we
  ON we.lesson_event_id = pes.lesson_event_id
 AND we.kind = pes.kind
WHERE pes.lesson_date BETWEEN ? AND ?
  AND pes.kind IN ('lesson','homework')
  AND pes.status IN ('pending','confirmed')
ORDER BY pes.kind, subject_key, pes.lesson_date, pes.lesson_event_id, pes.student_id
`;

  const rows = db.prepare(sql).all(weekStart, weekEnd, weekStart, weekEnd) as Array<{
    student_id: number;
    lesson_event_id: number;
    kind: 'lesson' | 'homework';
    lesson_date: string;
    subject_key: string;
    status: 'pending' | 'confirmed';
    last_confirmed_completion_date: string | null;
  }>;

  const fileName = `exams_week_${weekStart}__${weekEnd}.csv`;
  const filePath = path.join(os.tmpdir(), fileName);

  const header = toCsvLine([
    'week_start',
    'week_end',
    'student_id',
    'lesson_event_id',
    'kind',
    'lesson_date',
    'subject_key',
    'status',
    'last_confirmed_completion_date',
  ]);

  const lines = [header];
  for (const r of rows) {
    lines.push(
      toCsvLine([
        weekStart,
        weekEnd,
        r.student_id,
        r.lesson_event_id,
        r.kind,
        r.lesson_date,
        r.subject_key,
        r.status,
        r.last_confirmed_completion_date,
      ])
    );
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  return { weekStart, weekEnd, filePath, fileName, rows: rows.length };
}
