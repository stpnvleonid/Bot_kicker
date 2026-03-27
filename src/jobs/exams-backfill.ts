import { ensureExamSubmissionsForDateRange } from './planner-exams';
import { markJobError, markJobSuccess } from '../db/job-health';

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

