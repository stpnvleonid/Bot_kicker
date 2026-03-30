import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBJECT_TOPIC_NAMES } from '../config/subjects';
import { getDb } from '../db';
import { getMoscowIsoDateFromIso, getWeekRangeMonSat } from '../utils/date-helpers';

type Kind = 'lesson' | 'homework';

export type ExamsWeekSubjectSummary = {
  subjectKey: string;
  kind: Kind;
  expected: number;
  confirmed: number;
};

export type ExamsWeekStudentSummary = {
  studentId: number;
  studentName: string;
  telegramUsername: string | null;
  subjectKey: string;
  lessonsExpected: number;
  lessonsConfirmed: number;
  homeworksExpected: number;
  homeworksConfirmed: number;
};

export type ExamsWeekSummaryResult = {
  weekStart: string;
  weekEnd: string;
  effectiveEnd: string;
  perSubject: ExamsWeekSubjectSummary[];
  perStudent: ExamsWeekStudentSummary[];
};

export type ExamsWeekNudgeItem = {
  studentId: number;
  telegramUserId: number;
  text: string;
};

function clampEffectiveEnd(weekEnd: string): string {
  const todayMoscow = getMoscowIsoDateFromIso(new Date().toISOString());
  return todayMoscow < weekEnd ? todayMoscow : weekEnd;
}

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

export function buildExamsWeekSummary(params: {
  weekDateIso: string;
  subjectKey?: string | null;
}): ExamsWeekSummaryResult {
  const { weekDateIso, subjectKey = null } = params;
  const { weekStart, weekEnd } = getWeekRangeMonSat(weekDateIso);
  const effectiveEnd = clampEffectiveEnd(weekEnd);
  const db = getDb();

  const baseFilter =
    `FROM planner_exam_submissions pes
     WHERE pes.lesson_date BETWEEN ? AND ?
       AND pes.kind IN ('lesson','homework')
       AND pes.status IN ('pending','confirmed')` +
    (subjectKey ? ` AND COALESCE(pes.subject_key, 'unknown') = ?` : '');

  const subjectSql =
    `SELECT COALESCE(pes.subject_key, 'unknown') AS subject_key,
            pes.kind AS kind,
            COUNT(*) AS expected,
            SUM(CASE WHEN pes.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
     ${baseFilter}
     GROUP BY COALESCE(pes.subject_key, 'unknown'), pes.kind
     ORDER BY subject_key, kind`;
  const perSubject = (subjectKey
    ? db.prepare(subjectSql).all(weekStart, effectiveEnd, subjectKey)
    : db.prepare(subjectSql).all(weekStart, effectiveEnd)) as Array<{
    subject_key: string;
    kind: Kind;
    expected: number;
    confirmed: number;
  }>;

  const studentSql =
    `SELECT pes.student_id AS student_id,
            s.last_name AS last_name,
            s.first_name AS first_name,
            s.telegram_username AS telegram_username,
            COALESCE(pes.subject_key, 'unknown') AS subject_key,
            pes.kind AS kind,
            COUNT(*) AS expected,
            SUM(CASE WHEN pes.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
     FROM planner_exam_submissions pes
     JOIN students s ON s.id = pes.student_id
     WHERE pes.lesson_date BETWEEN ? AND ?
       AND pes.kind IN ('lesson','homework')
       AND pes.status IN ('pending','confirmed')` +
    (subjectKey ? ` AND COALESCE(pes.subject_key, 'unknown') = ?` : '') +
    `
     GROUP BY pes.student_id, s.last_name, s.first_name, s.telegram_username, COALESCE(pes.subject_key, 'unknown'), pes.kind
     ORDER BY s.last_name, s.first_name, pes.student_id, subject_key, kind`;

  const studentRows = (subjectKey
    ? db.prepare(studentSql).all(weekStart, effectiveEnd, subjectKey)
    : db.prepare(studentSql).all(weekStart, effectiveEnd)) as Array<{
    student_id: number;
    last_name: string;
    first_name: string;
    telegram_username: string | null;
    subject_key: string;
    kind: Kind;
    expected: number;
    confirmed: number;
  }>;

  const perStudentMap = new Map<string, ExamsWeekStudentSummary>();
  for (const r of studentRows) {
    const name = `${(r.last_name ?? '').trim()} ${(r.first_name ?? '').trim()}`.trim() || `id:${r.student_id}`;
    const key = `${r.student_id}:${r.subject_key}`;
    const existing = perStudentMap.get(key) ?? {
      studentId: r.student_id,
      studentName: name,
      telegramUsername: r.telegram_username,
      subjectKey: r.subject_key,
      lessonsExpected: 0,
      lessonsConfirmed: 0,
      homeworksExpected: 0,
      homeworksConfirmed: 0,
    };
    if (r.kind === 'lesson') {
      existing.lessonsExpected = r.expected;
      existing.lessonsConfirmed = r.confirmed;
    } else {
      existing.homeworksExpected = r.expected;
      existing.homeworksConfirmed = r.confirmed;
    }
    perStudentMap.set(key, existing);
  }

  const perStudent = Array.from(perStudentMap.values()).sort(
    (a, b) => a.studentName.localeCompare(b.studentName, 'ru') || a.subjectKey.localeCompare(b.subjectKey)
  );

  return {
    weekStart,
    weekEnd,
    effectiveEnd,
    perSubject: perSubject.map((r) => ({
      subjectKey: r.subject_key,
      kind: r.kind,
      expected: r.expected,
      confirmed: r.confirmed,
    })),
    perStudent,
  };
}

export function exportExamsWeekSummaryCsv(params: {
  weekDateIso: string;
  subjectKey?: string | null;
}): { filePath: string; fileName: string; rows: number; weekStart: string; weekEnd: string; effectiveEnd: string } {
  const summary = buildExamsWeekSummary(params);
  const subjectPart = params.subjectKey ? `_${params.subjectKey}` : '_all';
  const fileName = `exams_week_summary_${summary.weekStart}__${summary.weekEnd}${subjectPart}.csv`;
  const filePath = path.join(os.tmpdir(), fileName);

  const lines = [
    toCsvLine([
      'week_start',
      'week_end',
      'effective_end',
      'student_id',
      'student_name',
      'telegram_username',
      'subject_key',
      'subject_label',
      'lessons_expected',
      'lessons_confirmed',
      'homeworks_expected',
      'homeworks_confirmed',
    ]),
  ];
  for (const r of summary.perStudent) {
    lines.push(
      toCsvLine([
        summary.weekStart,
        summary.weekEnd,
        summary.effectiveEnd,
        r.studentId,
        r.studentName,
        r.telegramUsername,
        r.subjectKey,
        SUBJECT_TOPIC_NAMES[r.subjectKey] ?? r.subjectKey,
        r.lessonsExpected,
        r.lessonsConfirmed,
        r.homeworksExpected,
        r.homeworksConfirmed,
      ])
    );
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return {
    filePath,
    fileName,
    rows: summary.perStudent.length,
    weekStart: summary.weekStart,
    weekEnd: summary.weekEnd,
    effectiveEnd: summary.effectiveEnd,
  };
}

export function buildExamsWeekNudgeList(params: {
  weekDateIso: string;
  subjectKey?: string | null;
}): { weekStart: string; weekEnd: string; effectiveEnd: string; items: ExamsWeekNudgeItem[] } {
  const { weekDateIso, subjectKey = null } = params;
  const summary = buildExamsWeekSummary({ weekDateIso, subjectKey });
  const db = getDb();

  const pendingSql =
    `SELECT DISTINCT pes.student_id AS student_id
     FROM planner_exam_submissions pes
     JOIN students s ON s.id = pes.student_id
     WHERE pes.lesson_date BETWEEN ? AND ?
       AND pes.status IN ('pending','rejected')
       AND s.planner_enabled = 1
       AND s.dm_blocked = 0` +
    (subjectKey ? ` AND COALESCE(pes.subject_key, 'unknown') = ?` : '');

  const pendingStudents = (subjectKey
    ? db.prepare(pendingSql).all(summary.weekStart, summary.effectiveEnd, subjectKey)
    : db.prepare(pendingSql).all(summary.weekStart, summary.effectiveEnd)) as Array<{ student_id: number }>;
  const pendingSet = new Set(pendingStudents.map((r) => r.student_id));

  const eligibleRows = db
    .prepare(
      `SELECT id, telegram_user_id
       FROM students
       WHERE planner_enabled = 1 AND dm_blocked = 0`
    )
    .all() as Array<{ id: number; telegram_user_id: number }>;
  const userIdByStudentId = new Map<number, number>(eligibleRows.map((r) => [r.id, r.telegram_user_id]));

  const byStudent = new Map<number, ExamsWeekStudentSummary[]>();
  for (const row of summary.perStudent) {
    if (!pendingSet.has(row.studentId)) continue;
    const arr = byStudent.get(row.studentId) ?? [];
    arr.push(row);
    byStudent.set(row.studentId, arr);
  }

  const items: ExamsWeekNudgeItem[] = [];
  for (const [studentId, rows] of byStudent.entries()) {
    const telegramUserId = userIdByStudentId.get(studentId);
    if (!telegramUserId) continue;
    const lines: string[] = [];
    lines.push(
      `Напоминание по exams за неделю ${summary.weekStart} — ${summary.effectiveEnd}.`
    );
    lines.push('Остались неподтвержденные уроки/ДЗ:');
    lines.push('');
    rows.sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
    for (const r of rows) {
      const label = SUBJECT_TOPIC_NAMES[r.subjectKey] ?? r.subjectKey;
      lines.push(
        `• ${label}: уроки ${r.lessonsConfirmed}/${r.lessonsExpected}, ДЗ ${r.homeworksConfirmed}/${r.homeworksExpected}`
      );
    }
    lines.push('');
    lines.push('Зайди в /planner и отправь фото для непокрытых пунктов, чтобы закрыть долги.');
    items.push({
      studentId,
      telegramUserId,
      text: lines.join('\n'),
    });
  }

  return {
    weekStart: summary.weekStart,
    weekEnd: summary.weekEnd,
    effectiveEnd: summary.effectiveEnd,
    items,
  };
}

