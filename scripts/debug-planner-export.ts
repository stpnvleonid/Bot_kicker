import { getDb, closeDb } from '../src/db';
import { getConfig } from '../src/config';
import { runPlannerExportJob, runPlannerExportJobForDate } from '../src/jobs/planner';

/**
 * Ручной запуск выгрузки планера в Google Таблицу.
 *
 * Варианты:
 *   npm run debug-planner-export              — выгрузить только сегодня
 *   npm run debug-planner-export -- --date=2025-03-15  — выгрузить одну дату
 *   npm run debug-planner-export -- --all     — выгрузить все даты, по которым есть задачи (completed/partly_done)
 */
async function main(): Promise<void> {
  const config = getConfig();
  console.log('[PlannerDebug] TZ =', config.TZ || 'UTC');

  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const taskDate = dateArg ? dateArg.split('=')[1].trim() : null;
  const allDates = process.argv.includes('--all');

  const db = getDb();

  if (allDates) {
    const dates = db
      .prepare(
        `SELECT DISTINCT task_date FROM daily_tasks
         WHERE status IN ('completed','partly_done')
         ORDER BY task_date`
      )
      .all() as Array<{ task_date: string }>;
    if (!dates.length) {
      console.log('[PlannerDebug] Нет дат с выполненными/частично выполненными задачами.');
      closeDb();
      return;
    }
    console.log('[PlannerDebug] Выгрузка для всех дат с задачами:', dates.map((d) => d.task_date).join(', '));
    try {
      for (const { task_date } of dates) {
        await runPlannerExportJobForDate(task_date);
      }
      console.log('[PlannerDebug] Выгрузка по всем датам завершена.');
    } catch (e) {
      console.error('[PlannerDebug] Ошибка при выгрузке:', e);
    } finally {
      closeDb();
    }
    return;
  }

  console.log(
    '[PlannerDebug] Запускаю выгрузку',
    taskDate ? `для даты ${taskDate}...` : 'для сегодняшней даты...'
  );
  try {
    if (taskDate) {
      await runPlannerExportJobForDate(taskDate);
    } else {
      await runPlannerExportJob();
    }
    console.log('[PlannerDebug] Выгрузка завершена.');
  } catch (e) {
    console.error('[PlannerDebug] Ошибка при выгрузке:', e);
  } finally {
    closeDb();
  }
}

main().catch((e) => {
  console.error('[PlannerDebug] Fatal error:', e);
  process.exit(1);
});

