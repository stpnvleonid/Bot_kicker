/**
 * Job 5: Планер учебных задач.
 * Утро (10:00): предложить запланировать до 6 задач.
 * Вечер (20:00): показать задачи и дать отметить статус (planned/completed/partly_done/cancelled).
 * 20:00 (МСК): напоминание тем, у кого остались задачи в статусе «запланировано».
 * 20:00–02:00 (МСК): каждые 15 мин проверка — если все задачи обновлены, экспорт в таблицу раньше.
 * 02:00 (МСК): экспорт за вчера в любом случае.
 *
 * GOOGLE_APPLICATION_CREDENTIALS используются те же, выгрузка в Google Sheets будет добавлена отдельно.
 */

import { getDb } from '../db';
import { writePlannerDay } from '../google/planner-sheets';

const PLANNER_TZ = 'Europe/Moscow';

export const PLANNER_MAX_TASKS = 6;

export function todayIsoDate(): string {
  // Храним дату в виде YYYY-MM-DD (UTC). Для логики «сегодня» используем одну и ту же функцию везде.
  return new Date().toISOString().slice(0, 10);
}

/** Дата в формате YYYY-MM-DD по Москве. */
export function getDateInMoscow(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: PLANNER_TZ });
}

/** Час (0–23) по Москве. */
export function getMoscowHour(d: Date = new Date()): number {
  return parseInt(d.toLocaleString('en-US', { timeZone: PLANNER_TZ, hour: 'numeric', hour12: false }), 10);
}

/** Дата, которую «закрываем» в окне 20:00–02:00 МСК: в 20–23 это сегодня МСК, в 0–1 — вчера МСК. Вне окна — null. */
export function getClosingTaskDate(): string | null {
  const d = new Date();
  const hour = getMoscowHour(d);
  const today = getDateInMoscow(d);
  if (hour >= 20) return today;
  if (hour <= 1) return getDateInMoscow(new Date(d.getTime() - 86400000));
  return null;
}

/** Вчера по Москве (для экспорта в 02:00). */
export function getYesterdayMoscow(): string {
  return getDateInMoscow(new Date(Date.now() - 86400000));
}

export function isPlannerActiveToday(): boolean {
  // Планер не работает по воскресеньям.
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: PLANNER_TZ,
    weekday: 'short',
  }).format(new Date());
  return weekday !== 'Sun';
}

/** Утренний опрос: предложить студентам запланировать задачи. */
export function runPlannerMorningJob(): void {
  const db = getDb();
  const taskDate = getDateInMoscow();

  if (!isPlannerActiveToday()) {
    console.log('[Planner] Morning: planner disabled on Sunday, skipping.');
    return;
  }

  // Студенты с включённым планером (исключение: утренний инвайт отправляем даже при notify_dm=0,
  // чтобы пользователь гарантированно получил точку входа в планирование дня).
  const students = db
    .prepare(
      `SELECT id, telegram_user_id, first_name
       FROM students
       WHERE planner_enabled = 1 AND dm_blocked = 0`
    )
    .all() as Array<{ id: number; telegram_user_id: number; first_name: string }>;

  if (!students.length) {
    console.log('[Planner] Morning: no students with planner_enabled');
    return;
  }

  console.log(`[Planner] Morning: sending invite for date ${taskDate} to ${students.length} students`);

  const text =
    'Доброе утро! Давай запланируем до 6 задач на сегодня.\n\n' +
    'Выбери количество задач (1–6). Если передумаешь по ходу — можно ввести меньшую часть и потом написать /skip, чтобы закончить.';

  const sendStmt = db.prepare(
    `INSERT INTO send_queue (type, chat_id, message_thread_id, text, event_id, student_id, notification_type, status)
     VALUES ('dm', ?, NULL, ?, NULL, ?, 'planner_invite', 'pending')`
  );

  for (const s of students) {
    sendStmt.run(s.telegram_user_id, text, s.id);
  }
}

/** Админский перезапуск утреннего опроса: только для тех, у кого на дату ещё нет задач. */
export function runPlannerMorningRemind(taskDate?: string): { date: string; count: number } {
  const db = getDb();
  const targetDate = taskDate || getDateInMoscow();

  const students = db
    .prepare(
      `SELECT s.id, s.telegram_user_id, s.first_name
       FROM students s
       WHERE s.planner_enabled = 1 AND s.notify_dm = 1 AND s.dm_blocked = 0
         AND NOT EXISTS (
           SELECT 1 FROM daily_tasks dt
           WHERE dt.student_id = s.id AND dt.task_date = ?
         )`
    )
    .all(targetDate) as Array<{ id: number; telegram_user_id: number; first_name: string }>;

  if (!students.length) {
    console.log('[Planner] MorningRemind: no students without plans for', targetDate);
    return { date: targetDate, count: 0 };
  }

  const text =
    'Давай запланируем до 6 задач на сегодня.\n\n' +
    'Выбери количество задач (1–6). Если передумаешь по ходу — можно ввести меньшую часть и потом написать /skip, чтобы закончить.';

  const sendStmt = db.prepare(
    `INSERT INTO send_queue (type, chat_id, message_thread_id, text, event_id, student_id, notification_type, status)
     VALUES ('dm', ?, NULL, ?, NULL, ?, 'planner_invite', 'pending')`
  );

  for (const s of students) {
    sendStmt.run(s.telegram_user_id, text, s.id);
  }

  console.log('[Planner] MorningRemind: sent planner_invite for date', targetDate, 'to', students.length, 'students');
  return { date: targetDate, count: students.length };
}

/** Вечерний опрос: отправить студентам экран «Отметь выполненные задачи на сегодня». */
export function runPlannerEveningJob(): void {
  const db = getDb();
  const taskDate = getDateInMoscow();

  if (!isPlannerActiveToday()) {
    console.log('[Planner] Evening: planner disabled on Sunday, skipping.');
    return;
  }

  runPlannerEveningJobForDate(taskDate);
}

/** Вечерний опрос за конкретную дату: отправить студентам экран «Отметь выполненные задачи на сегодня». */
export function runPlannerEveningJobForDate(taskDate: string): void {
  const db = getDb();

  const students = db
    .prepare(
      `SELECT DISTINCT st.id AS student_id, st.telegram_user_id
       FROM students st
       WHERE st.planner_enabled = 1
         AND st.dm_blocked = 0
         AND (
           EXISTS (
             SELECT 1
             FROM daily_tasks dt
             WHERE dt.student_id = st.id
               AND dt.task_date = ?
               AND dt.status IN ('planned','partly_done','completed')
           )
           OR EXISTS (
             SELECT 1
             FROM planner_exam_submissions pes
             WHERE pes.student_id = st.id
               AND pes.lesson_date = ?
               AND pes.status IN ('pending','rejected')
           )
         )`
    )
    .all(taskDate, taskDate) as Array<{ student_id: number; telegram_user_id: number }>;

  if (!students.length) {
    console.log('[Planner] EveningForDate: no tasks or exams for', taskDate);
    return;
  }

  const alreadyQueuedStmt = db.prepare(
    `SELECT 1
     FROM send_queue
     WHERE type = 'dm'
       AND notification_type = 'planner_done_summary_auto'
       AND student_id = ?
       AND status IN ('pending','processing','sent')
       AND text LIKE ?`
  );

  const prefix = `Отметь выполненные задачи на сегодня (${taskDate})`;

  const sendStmt = db.prepare(
    `INSERT INTO send_queue (type, chat_id, message_thread_id, text, event_id, student_id, notification_type, status)
     VALUES ('dm', ?, NULL, ?, NULL, ?, 'planner_done_summary_auto', 'pending')`
  );

  for (const s of students) {
    const exists = alreadyQueuedStmt.get(s.student_id, `${prefix}%`);
    if (exists) continue;

    const text = `${prefix} — я покажу список и кнопки статусов.`;
    sendStmt.run(s.telegram_user_id, text, s.student_id);
  }

  console.log(
    '[Planner] EveningForDate: enqueued planner_done_summary_auto for',
    students.length,
    'students on',
    taskDate
  );
}

/** Напоминание студентам, у которых за дату есть задачи в статусе «запланировано»: обновить статус до 02:00. */
export function runPlannerRemindUnfinished(taskDate: string): void {
  const db = getDb();
  const students = db
    .prepare(
      `SELECT DISTINCT s.id, s.telegram_user_id, s.first_name
       FROM daily_tasks dt
       JOIN students s ON s.id = dt.student_id
       WHERE dt.task_date = ? AND dt.status = 'planned'
         AND s.dm_blocked = 0`
    )
    .all(taskDate) as Array<{ id: number; telegram_user_id: number; first_name: string }>;
  if (!students.length) {
    console.log('[Planner] RemindUnfinished: no students with planned tasks for', taskDate);
    return;
  }
  const text =
    'Напоминание: у тебя есть задачи со статусом «запланировано». ' +
    'Пожалуйста, отметь выполненные, частично выполненные или отменённые через /planner → «Выполнено». ' +
    'До 02:00 данные перенесутся в таблицу; после этого день будет закрыт.';
  const stmt = db.prepare(
    `INSERT INTO send_queue (type, chat_id, message_thread_id, text, event_id, student_id, notification_type, status)
     VALUES ('dm', ?, NULL, ?, NULL, ?, 'planner_remind_status', 'pending')`
  );
  for (const s of students) {
    stmt.run(s.telegram_user_id, text, s.id);
  }
  console.log('[Planner] RemindUnfinished: sent reminder to', students.length, 'students for', taskDate);
}

/** Если по дате ни у кого нет задач в статусе «запланировано» — выполнить экспорт (ранний перенос до 02:00). */
export async function runPlannerExportIfAllUpdated(taskDate: string): Promise<void> {
  const db = getDb();
  const hasPlanned = db
    .prepare(
      `SELECT 1 FROM daily_tasks WHERE task_date = ? AND status = 'planned' LIMIT 1`
    )
    .get(taskDate);
  if (hasPlanned) return;
  console.log('[Planner] ExportIfAllUpdated: all tasks updated for', taskDate, ', running export');
  await runPlannerFullExportJobForDate(taskDate);
}

/** Конец дня (20:00 МСК): только напоминание, экспорт не запускаем. */
export function runPlannerEndOfDayReminder(): void {
  if (!isPlannerActiveToday()) return;
  const taskDate = getDateInMoscow();
  runPlannerRemindUnfinished(taskDate);
}

/** Финальный экспорт в 02:00 МСК: вчера по Москве, в любом случае. */
export async function runPlannerFinalExport(): Promise<void> {
  const taskDate = getYesterdayMoscow();
  console.log('[Planner] FinalExport: exporting for', taskDate);
  await runPlannerFullExportJobForDate(taskDate);
}

/** Ночная выгрузка задач планера в Google Sheets. */
export async function runPlannerExportJobForDate(taskDate: string): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT dt.id, dt.student_id, dt.task_date, dt.text, dt.status,
              s.first_name, s.last_name
       FROM daily_tasks dt
       JOIN students s ON s.id = dt.student_id
       WHERE dt.task_date = ? AND dt.status IN ('completed','partly_done')
         AND NOT EXISTS (SELECT 1 FROM daily_tasks_exports de WHERE de.task_id = dt.id)
       ORDER BY dt.task_date, dt.student_id, dt.idx`
    )
    .all(taskDate) as Array<{
    id: number;
    student_id: number;
    task_date: string;
    text: string;
    status: 'completed' | 'partly_done';
    first_name: string;
    last_name: string | null;
  }>;

  if (!rows.length) {
    console.log('[Planner] Export: no tasks to export for', taskDate);
    return;
  }

  // Агрегируем задачи по студенту за день.
  const byStudent = new Map<
    number,
    {
      studentId: number;
      fullName: string;
      lastName: string;
      firstName: string;
      tasks: Array<{ text: string; status: 'completed' | 'partly_done' }>;
    }
  >();

  for (const r of rows) {
    const rawLastName = (r.last_name ?? '').trim();
    const rawFirstName = (r.first_name ?? '').trim();
    const fullName = rawLastName || rawFirstName || '(без имени)';
    const lastName = rawLastName || '';
    const firstName = rawFirstName || '';
    let entry = byStudent.get(r.student_id);
    if (!entry) {
      entry = { studentId: r.student_id, fullName, lastName, firstName, tasks: [] };
      byStudent.set(r.student_id, entry);
    }
    entry.tasks.push({ text: r.text, status: r.status });
  }

  const aggregates: {
    studentId: number;
    fullName: string;
    lastName: string;
    firstName: string;
    tasks: Array<{ text: string; status: 'completed' | 'partly_done' }>;
    dayStatus: string;
  }[] = [];

  for (const { studentId, fullName, lastName, firstName, tasks } of byStudent.values()) {
    const hasPartly = tasks.some((t) => t.status === 'partly_done');
    const hasCompleted = tasks.some((t) => t.status === 'completed');

    let dayStatus = 'Не сделано';
    if (hasPartly) {
      dayStatus = 'Частично';
    } else if (hasCompleted) {
      dayStatus = 'Сделано';
    }

    aggregates.push({ studentId, fullName, lastName, firstName, tasks, dayStatus });
  }

  try {
    const written = await writePlannerDay(taskDate, aggregates);
    if (!written) {
      console.warn(
        '[Planner] Export: writePlannerDay wrote nothing to sheet for',
        taskDate,
        '— tasks will not be marked as exported'
      );
      return;
    }
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO daily_tasks_exports (task_id, sheet_row)
       VALUES (?, NULL)`
    );
    for (const r of rows) {
      insertStmt.run(r.id);
    }
    console.log(
      '[Planner] Export: exported',
      rows.length,
      'tasks for',
      taskDate,
      'sheet rows touched:',
      written
    );
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (msg.includes('protected') || msg.includes('protection') || msg.includes('You are trying to edit')) {
      console.error(
        '[Planner] Export error: в таблице включена защита листа/диапазонов. ' +
          'Снимите защиту с областей, куда пишет бот (столбцы с задачами и результатом по дням), ' +
          'или в настройках защиты добавьте сервисный аккаунт (client_email из JSON) в список редакторов. Подробнее: docs/CONFIG.md'
      );
    } else {
      console.error('[Planner] Export error:', e);
    }
  }
}

/** Полный экспорт задач планера за дату в Google Sheets: пересчитывает день целиком, без учёта daily_tasks_exports. */
export async function runPlannerFullExportJobForDate(taskDate: string): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT dt.id, dt.student_id, dt.task_date, dt.text, dt.status,
              s.first_name, s.last_name
       FROM daily_tasks dt
       JOIN students s ON s.id = dt.student_id
       WHERE dt.task_date = ? AND dt.status IN ('planned','completed','partly_done')
       ORDER BY dt.task_date, dt.student_id, dt.idx`
    )
    .all(taskDate) as Array<{
    id: number;
    student_id: number;
    task_date: string;
    text: string;
    status: 'planned' | 'completed' | 'partly_done';
    first_name: string;
    last_name: string | null;
  }>;

  if (!rows.length) {
    console.log('[Planner] FullExport: no tasks to export for', taskDate);
    return;
  }

  const byStudent = new Map<
    number,
    {
      studentId: number;
      fullName: string;
      lastName: string;
      firstName: string;
      tasks: Array<{ text: string; status: 'planned' | 'completed' | 'partly_done' }>;
    }
  >();

  for (const r of rows) {
    const rawLastName = (r.last_name ?? '').trim();
    const rawFirstName = (r.first_name ?? '').trim();
    const fullName = rawLastName || rawFirstName || '(без имени)';
    const lastName = rawLastName || '';
    const firstName = rawFirstName || '';
    let entry = byStudent.get(r.student_id);
    if (!entry) {
      entry = { studentId: r.student_id, fullName, lastName, firstName, tasks: [] };
      byStudent.set(r.student_id, entry);
    }
    entry.tasks.push({ text: r.text, status: r.status });
  }

  const aggregates: {
    studentId: number;
    fullName: string;
    lastName: string;
    firstName: string;
    tasks: Array<{ text: string; status: 'planned' | 'completed' | 'partly_done' }>;
    dayStatus: string;
  }[] = [];

  for (const { studentId, fullName, lastName, firstName, tasks } of byStudent.values()) {
    const hasPartly = tasks.some((t) => t.status === 'partly_done');
    const hasCompleted = tasks.some((t) => t.status === 'completed');

    let dayStatus = 'Не сделано';
    if (hasPartly) {
      dayStatus = 'Частично';
    } else if (hasCompleted) {
      dayStatus = 'Сделано';
    }

    aggregates.push({ studentId, fullName, lastName, firstName, tasks, dayStatus });
  }

  try {
    const written = await writePlannerDay(taskDate, aggregates);
    if (!written) {
      console.warn(
        '[Planner] FullExport: writePlannerDay wrote nothing to sheet for',
        taskDate
      );
      return;
    }
    console.log(
      '[Planner] FullExport: exported',
      rows.length,
      'tasks for',
      taskDate,
      'sheet rows touched:',
      written
    );
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (msg.includes('protected') || msg.includes('protection') || msg.includes('You are trying to edit')) {
      console.error(
        '[Planner] FullExport error: в таблице включена защита листа/диапазонов. ' +
          'Снимите защиту с областей, куда пишет бот (столбцы с задачами и результатом по дням), ' +
          'или в настройках защиты добавьте сервисный аккаунт (client_email из JSON) в список редакторов. Подробнее: docs/CONFIG.md'
      );
    } else {
      console.error('[Planner] FullExport error:', e);
    }
  }
}

export async function runPlannerExportJob(): Promise<void> {
  const taskDate = getDateInMoscow();
  return runPlannerExportJobForDate(taskDate);
}


