import { getDb } from './index';

export type JobHealthName = 'job1_calendar_sync' | 'job2_notification_scheduler';

function normalizeErrorMessage(err: unknown): string {
  if (!err) return 'unknown error';
  if (err instanceof Error) return err.message || err.name || 'unknown error';
  const anyErr = err as any;
  const msg = typeof anyErr?.message === 'string' ? anyErr.message : undefined;
  if (msg) return msg;
  return String(err);
}

export function markJobSuccess(job: JobHealthName): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO job_health (job_name, last_success_at, last_error_at, last_error_message, updated_at)
     VALUES (?, datetime('now'), NULL, NULL, datetime('now'))
     ON CONFLICT(job_name) DO UPDATE SET
       last_success_at = excluded.last_success_at,
       last_error_at = NULL,
       last_error_message = NULL,
       updated_at = excluded.updated_at`
  ).run(job);
}

export function markJobError(job: JobHealthName, err: unknown): void {
  const db = getDb();
  const message = normalizeErrorMessage(err);
  db.prepare(
    `INSERT INTO job_health (job_name, last_success_at, last_error_at, last_error_message, updated_at)
     VALUES (?, NULL, datetime('now'), ?, datetime('now'))
     ON CONFLICT(job_name) DO UPDATE SET
       last_error_at = excluded.last_error_at,
       last_error_message = excluded.last_error_message,
       updated_at = excluded.updated_at`
  ).run(job, message);
}

