/**
 * Ручной запуск Job4 (cleanup-archive) для проверки без ожидания 03:00.
 * Использует ту же БД и логику, что и cron в index.ts.
 */
import { getDb, closeDb } from '../src/db';
import { runMigrations } from '../src/db/migrate';
import { runCleanupArchiveJob } from '../src/jobs/cleanup-archive';

async function main(): Promise<void> {
  getDb();
  runMigrations();

  console.log('[Job4] Запуск runCleanupArchiveJob() вручную...');
  try {
    await runCleanupArchiveJob();
    console.log('[Job4] Готово.');
  } catch (e) {
    console.error('[Job4] Ошибка:', e);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main().catch((e) => {
  console.error('[Job4] Fatal:', e);
  process.exit(1);
});
