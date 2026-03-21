import { getDb } from './index';

export type PlannerExamKind = 'lesson' | 'homework';

export type PlannerExamSubmissionRow = {
  id: number;
  student_id: number;
  lesson_event_id: number;
  kind: PlannerExamKind;
  lesson_date: string;
  completion_date: string | null;
  subject_key: string | null;
  evidence_file_id: string | null;
  evidence_message_id: string | null;
  evidence_caption: string | null;
  status: 'pending' | 'confirmed' | 'rejected';
  last_confirmed_completion_date: string | null;
  last_prompted_at: string | null;
  updated_at: string;
};

export function ensureExamSubmissionExists(params: {
  studentId: number;
  lessonEventId: number;
  kind: PlannerExamKind;
  lessonDate: string; // YYYY-MM-DD
  subjectKey: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO planner_exam_submissions
     (student_id, lesson_event_id, kind, lesson_date, subject_key, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  ).run(params.studentId, params.lessonEventId, params.kind, params.lessonDate, params.subjectKey);
}

export function upsertExamEvidence(submissionId: number, evidence: { fileId: string; messageId: number; caption?: string | null }): void {
  const db = getDb();
  db.prepare(
    `UPDATE planner_exam_submissions
     SET evidence_file_id = ?,
         evidence_message_id = ?,
         evidence_caption = ?,
         status = 'pending',
         last_submitted_at = datetime('now')
     WHERE id = ?`
  ).run(evidence.fileId, evidence.messageId, evidence.caption ?? null, submissionId);
}

export function setExamCompletionDate(submissionId: number, completionDateIso: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE planner_exam_submissions
     SET completion_date = ?,
         status = 'pending'
     WHERE id = ?`
  ).run(completionDateIso, submissionId);
}

export function confirmExamSubmission(submissionId: number, adminTelegramUserId: number): void {
  const db = getDb();
  const row = db.prepare('SELECT completion_date FROM planner_exam_submissions WHERE id = ?').get(submissionId) as { completion_date: string | null } | undefined;
  const completionDate = row?.completion_date ?? null;

  db.prepare(
    `UPDATE planner_exam_submissions
     SET status = 'confirmed',
         last_confirmed_at = datetime('now'),
         last_confirmed_by_telegram_user_id = ?,
         last_confirmed_completion_date = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(adminTelegramUserId, completionDate, submissionId);
}

export function rejectExamSubmission(submissionId: number, adminTelegramUserId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE planner_exam_submissions
     SET status = 'rejected',
         last_rejected_at = datetime('now'),
         last_rejected_by_telegram_user_id = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(adminTelegramUserId, submissionId);
}

export function setExamLastPromptedAt(submissionIds: number[]): void {
  if (submissionIds.length === 0) return;
  const db = getDb();
  const placeholders = submissionIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE planner_exam_submissions
     SET last_prompted_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id IN (${placeholders})`
  ).run(...submissionIds);
}

export function getSubmissionForModeration(submissionId: number): {
  submission: PlannerExamSubmissionRow;
  student: { first_name: string; last_name: string; telegram_user_id: number; telegram_username: string | null };
  event: { title: string; start_at: string; description: string | null };
} | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT pes.*, s.first_name, s.last_name, s.telegram_user_id, s.telegram_username,
              ce.title, ce.start_at, ce.description
       FROM planner_exam_submissions pes
       JOIN students s ON s.id = pes.student_id
       JOIN calendar_events ce ON ce.id = pes.lesson_event_id
       WHERE pes.id = ?`
    )
    .get(submissionId) as (PlannerExamSubmissionRow & {
    first_name: string;
    last_name: string;
    telegram_user_id: number;
    telegram_username: string | null;
    title: string;
    start_at: string;
    description: string | null;
  }) | undefined;

  if (!row) return null;

  return {
    submission: row as unknown as PlannerExamSubmissionRow,
    student: { first_name: row.first_name, last_name: row.last_name, telegram_user_id: row.telegram_user_id, telegram_username: row.telegram_username },
    event: { title: row.title, start_at: row.start_at, description: row.description },
  };
}

export function getUnconfirmedExamSubmissionsForStudent(studentId: number): PlannerExamSubmissionRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT *
       FROM planner_exam_submissions
       WHERE student_id = ?
         AND status IN ('pending','rejected')`
    )
    .all(studentId) as PlannerExamSubmissionRow[];
}

