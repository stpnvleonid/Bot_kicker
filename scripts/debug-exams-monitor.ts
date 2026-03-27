/**
 * Мониторинг/диагностика потерь по exams (уроки/ДЗ).
 *
 * Запуск:
 *   npm run debug-exams-monitor -- 2026-03-23
 *   npm run debug-exams-monitor -- 2026-03-23 --subject informatics
 * Если дата не указана, берётся сегодня (UTC-дата контейнера).
 */

import { buildExamsMonitorReport } from '../src/jobs/exams-monitor';

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function main(): void {
  const args = process.argv.slice(2);
  const argDate = args.find((a) => !a.startsWith('--'))?.trim();
  const subjectFlagIdx = args.findIndex((a) => a === '--subject');
  const subjectArg = subjectFlagIdx >= 0 ? args[subjectFlagIdx + 1]?.trim() : undefined;

  const weekDate = argDate && isIsoDate(argDate) ? argDate : todayIsoUtc();
  if (argDate && !isIsoDate(argDate)) {
    console.error('Неверный формат даты. Используйте YYYY-MM-DD');
    process.exit(1);
  }

  const lines = buildExamsMonitorReport({
    weekDateIso: weekDate,
    subjectKey: subjectArg || null,
  });
  console.log(lines.join('\n'));
}

main();

