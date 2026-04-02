import { ensureEnglishSyntheticExamsPlus3d } from '../jobs/english-synthetic-exams';
import { getDateInMoscow } from '../jobs/planner';

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function main(): void {
  const args = process.argv.slice(2);
  const argDate = args.find((a) => !a.startsWith('--'))?.trim();

  const centerIso = argDate && isIsoDate(argDate) ? argDate : getDateInMoscow();
  if (argDate && !isIsoDate(argDate)) {
    console.error('Неверный формат даты. Используйте YYYY-MM-DD');
    process.exit(1);
  }

  const res = ensureEnglishSyntheticExamsPlus3d({
    centerIso,
    daysBack: 7,
    daysForward: 7,
    plusDays: 3,
  });

  console.log('=== English synthetic exams (+3d) ===');
  console.log(`center: ${centerIso}`);
  console.log(`anchor_event_id: ${res.anchorEventId ?? 'none'}`);
  console.log(`anchor_lesson_date: ${res.anchorLessonDate ?? 'none'}`);
  console.log(`synthetic_date: ${res.syntheticLessonDate ?? 'none'}`);
  console.log(`eligible_students: ${res.eligibleStudents}`);
  console.log(`pairs_ensured: ${res.pairsEnsured}`);
}

main();

