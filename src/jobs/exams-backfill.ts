import { ensureExamSubmissionsForDateRange } from './planner-exams';
import { markJobError, markJobSuccess } from '../db/job-health';
import { ensureEnglishSyntheticExamsPlus3d } from './english-synthetic-exams';

const BACKFILL_LOOKBACK_DAYS = 21;

function getTodayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildLookbackRange(days: number): { fromIso: string; toIso: string } {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    fromIso: from.toISOString(),
    toIso: now.toISOString(),
  };
}

export async function runExamsSubmissionsBackfillJob(options?: {
  fromIso?: string;
  toIso?: string;
  upToDateIso?: string;
  suppressJobHealth?: boolean;
}): Promise<void> {
  const { fromIso, toIso } = options?.fromIso && options?.toIso
    ? { fromIso: options.fromIso, toIso: options.toIso }
    : buildLookbackRange(BACKFILL_LOOKBACK_DAYS);
  const upToDateIso = options?.upToDateIso ?? getTodayIsoUtc();

  try {
    // Доп. обязательные english exams (урок+ДЗ) — synthetic events, не зависят от календаря.
    // Идемпотентно: calendar_events уникальны по (calendar_config_id, google_event_id),
    // submissions — по (student_id, lesson_event_id, kind).
    const eng = ensureEnglishSyntheticExamsPlus3d({ daysBack: 7, daysForward: 7, plusDays: 3 });
    console.log(
      '[ExamsBackfill] english synthetic',
      `anchor_event_id=${eng.anchorEventId ?? 'none'}`,
      `anchor_lesson_date=${eng.anchorLessonDate ?? 'none'}`,
      `synthetic_date=${eng.syntheticLessonDate ?? 'none'}`,
      `eligible_students=${eng.eligibleStudents}`,
      `pairs_ensured=${eng.pairsEnsured}`
    );

    const res = ensureExamSubmissionsForDateRange({
      fromIso,
      toIso,
      upToDateIso,
    });
    console.log(
      '[ExamsBackfill] done',
      `events_scanned=${res.eventsScanned}`,
      `events_processed=${res.eventsProcessed}`,
      `eligible_total=${res.eligibleStudentsTotal}`,
      `inserted_pairs=${res.insertedPairsTotal}`,
      `range=${fromIso}..${toIso}`,
      `up_to=${upToDateIso}`
    );
    if (!options?.suppressJobHealth) {
      markJobSuccess('job6_exams_backfill');
    }
  } catch (e) {
    console.error('[ExamsBackfill] failed:', e);
    if (!options?.suppressJobHealth) {
      markJobError('job6_exams_backfill', e);
    }
    throw e;
  }
}

