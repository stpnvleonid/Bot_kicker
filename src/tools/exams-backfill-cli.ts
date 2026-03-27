import { runExamsSubmissionsBackfillJob } from '../jobs/exams-backfill';

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const from = args[0];
  const to = args[1];
  const upToDate = args[2];

  if (from && !isIsoDate(from)) {
    throw new Error('Invalid from date, expected YYYY-MM-DD');
  }
  if (to && !isIsoDate(to)) {
    throw new Error('Invalid to date, expected YYYY-MM-DD');
  }
  if (upToDate && !isIsoDate(upToDate)) {
    throw new Error('Invalid upToDate, expected YYYY-MM-DD');
  }

  await runExamsSubmissionsBackfillJob({
    fromIso: from ? `${from}T00:00:00.000Z` : undefined,
    toIso: to ? `${to}T23:59:59.999Z` : undefined,
    upToDateIso: upToDate,
  });
}

main().catch((e) => {
  console.error('[ExamsBackfillCLI] error:', e);
  process.exit(1);
});

