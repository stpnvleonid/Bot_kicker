import { runExamsGapCheckJob } from '../jobs/exams-gap-check';

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const weekStart = args[0];
  const weekEnd = args[1];

  if (weekStart && !isIsoDate(weekStart)) {
    throw new Error('Invalid weekStart date, expected YYYY-MM-DD');
  }
  if (weekEnd && !isIsoDate(weekEnd)) {
    throw new Error('Invalid weekEnd date, expected YYYY-MM-DD');
  }

  await runExamsGapCheckJob({ weekStart, weekEnd });
}

main().catch((e) => {
  console.error('[ExamsGapCheckCLI] error:', e);
  process.exit(1);
});

