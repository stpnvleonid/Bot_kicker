/**
 * Job 3: Воркер очереди отправки сообщений.
 * См. TECHNICAL_DESIGN_TELEGRAM.md § 5.3
 */

import { getDb } from '../db';
import { selectPendingExamSubmissionsForStudent } from './planner-exams';

const BATCH_SIZE = 10;
const GLOBAL_RATE = 25; // messages per second max
const DM_RATE_MS = 1500; // min interval per user for DM

let lastRunMs = 0;
const lastDmByUser = new Map<number, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitGlobalRate(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRunMs;
  if (elapsed < 1000 / GLOBAL_RATE) {
    const wait = 1000 / GLOBAL_RATE - elapsed;
    await sleep(wait);
  }
  lastRunMs = Date.now();
}

async function waitDmRate(chatId: number): Promise<void> {
  const last = lastDmByUser.get(chatId) ?? 0;
  const now = Date.now();
  if (now - last < DM_RATE_MS) {
    await sleep(DM_RATE_MS - (now - last));
  }
  lastDmByUser.set(chatId, Date.now());
}

export async function runSendQueueWorkerIteration(bot: {
  telegram: {
    sendMessage: (
      chatId: number,
      text: string,
      opts?: {
        message_thread_id?: number;
        reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      }
    ) => Promise<{ message_id: number }>;
    deleteMessage: (chatId: number, messageId: number) => Promise<true> | Promise<void> | Promise<unknown>;
  };
}): Promise<void> {
  const db = getDb();
  const MAX_RETRIES = 3;
  // Бэкофф: после первой ошибки подождать ~10s, затем удваивать до ~5 минут.
  const BASE_BACKOFF_SECONDS = 10;
  const MAX_BACKOFF_SECONDS = 300;

  const rows = db.prepare(
    `SELECT id, type, chat_id, message_thread_id, text, event_id, student_id, notification_type, selection_id,
            retry_count, next_attempt_at
     FROM send_queue
     WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
     ORDER BY COALESCE(next_attempt_at, created_at), created_at
     LIMIT ?`
  ).all(BATCH_SIZE) as Array<{
    id: number;
    type: string;
    chat_id: number;
    message_thread_id: number | null;
    text: string;
    event_id: number | null;
    student_id: number | null;
    notification_type: string | null;
    selection_id: number | null;
    retry_count: number;
    next_attempt_at: string | null;
  }>;

  for (const task of rows) {
    await waitGlobalRate();
    if (task.type === 'dm') await waitDmRate(task.chat_id);

    db.prepare("UPDATE send_queue SET status = 'processing', claimed_at = datetime('now') WHERE id = ?").run(task.id);

    try {
      // Специальные задачи на удаление предыдущих напоминаний в ЛС по событию.
      if (
        task.type === 'dm' &&
        task.event_id != null &&
        task.student_id != null &&
        task.notification_type === 'delete_dm_reminder_24h'
      ) {
        try {
          const row = db
            .prepare(
              `SELECT message_id
               FROM event_dm_messages
               WHERE event_id = ? AND student_id = ? AND notification_type = 'reminder_24h'`
            )
            .get(task.event_id, task.student_id) as { message_id: number } | undefined;

          if (row) {
            await bot.telegram.deleteMessage(task.chat_id, row.message_id);
            db.prepare(
              `DELETE FROM event_dm_messages
               WHERE event_id = ? AND student_id = ? AND notification_type = 'reminder_24h'`
            ).run(task.event_id, task.student_id);
          }

          db.prepare("UPDATE send_queue SET status = 'sent', updated_at = datetime('now') WHERE id = ?").run(task.id);
        } catch (e) {
          const message = String((e as { message?: string })?.message ?? e);
          db.prepare(
            "UPDATE send_queue SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(message, task.id);
        }
        continue;
      }

      const opts: { message_thread_id?: number; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } = {};
      if (task.message_thread_id) opts.message_thread_id = task.message_thread_id;
      if (task.type === 'dm') {
        if (
          task.event_id != null &&
          task.student_id != null &&
          (task.notification_type === 'reminder_24h' || task.notification_type === 'reminder_1h')
        ) {
          opts.reply_markup = {
            inline_keyboard: [[{ text: 'Буду на занятии', callback_data: `confirm_15m_${task.event_id}_${task.student_id}` }]],
          };
        } else if (task.notification_type === 'planner_invite' && task.student_id != null) {
          opts.reply_markup = {
            inline_keyboard: [
              [
                { text: '1', callback_data: 'planner_count_1' },
                { text: '2', callback_data: 'planner_count_2' },
                { text: '3', callback_data: 'planner_count_3' },
              ],
              [
                { text: '4', callback_data: 'planner_count_4' },
                { text: '5', callback_data: 'planner_count_5' },
                { text: '6', callback_data: 'planner_count_6' },
              ],
              [{ text: 'Сегодня без задач', callback_data: 'planner_skip_day' }],
            ],
          };
        } else if (task.notification_type === 'planner_task' && task.event_id != null) {
          const taskId = task.event_id;
          opts.reply_markup = {
            inline_keyboard: [
              [
                { text: '✅ Выполнена', callback_data: `planner_task_${taskId}_completed` },
                { text: '🟡 Частично', callback_data: `planner_task_${taskId}_partly` },
              ],
              [{ text: '❌ Отменена', callback_data: `planner_task_${taskId}_cancelled` }],
            ],
          };
        } else if (task.notification_type === 'planner_done_summary_auto' && task.student_id != null) {
          // Автоматический экран «Отметь выполненные задачи на сегодня» за дату.
          // Дату берём из текста enqueue (в формате: ... (${taskDate}) ...), fallback — на текущую.
          const db2 = getDb();
          const todayIso = new Date().toISOString().slice(0, 10);
          const match = task.text.match(/\((\d{4}-\d{2}-\d{2})\)/);
          const taskDate = match?.[1] ?? todayIso;

          const tasks = db2
            .prepare(
              `SELECT id, idx, text, status, task_date
               FROM daily_tasks
               WHERE student_id = ? AND task_date = ?
               ORDER BY idx`
            )
            .all(task.student_id, taskDate) as Array<{ id: number; idx: number; text: string; status: string; task_date: string }>;

          const statusLabel = (s: string): string => {
            if (s === 'completed') return '✅';
            if (s === 'partly_done') return '🟡';
            if (s === 'cancelled') return '❌';
            return '⬜';
          };

          const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
          const lines: string[] = [`Отметь выполненные задачи на сегодня (${taskDate}):`, ''];

          if (tasks.length) {
            lines.push(...tasks.map((t) => `${t.idx}. ${t.text} ${statusLabel(t.status)}`));
            lines.push('');
            lines.push(
              'Нажимай на кнопки под каждой задачей, чтобы отметить, что сделано полностью или частично. В любой момент можно вернуться к списку задач или набрать /planner, чтобы обновить состояние.'
            );

            keyboard.push(
              ...tasks.map((t) => [
                { text: `✅ ${t.idx}`, callback_data: `planner_done_set_completed_${t.id}` },
                { text: `🟡 ${t.idx}`, callback_data: `planner_done_set_partly_${t.id}` },
              ])
            );
          } else {
            lines.push('Планерные задачи отсутствуют.');
            lines.push('');
          }

          // Mandatory "exams" (Урок + ДЗ) with photo evidence + admin moderation.
          try {
            const exam = await selectPendingExamSubmissionsForStudent({
              studentId: task.student_id,
              screenDateIso: taskDate,
              matchLessonDateOnly: true,
              maxLessons: 2,
              maxHomeworks: 2,
            });

            if (exam.selected.length > 0) {
              lines.push('Обязательные "exams" на модерации:', '');
              for (const s of exam.selected) {
                const st = s.status === 'rejected' ? 'отклонено' : 'в ожидании';
                const lastConfirmed = s.lastConfirmedCompletionDateLabel ? ` (последнее подтверждено: ${s.lastConfirmedCompletionDateLabel})` : '';
                const completionDate = s.completionDateLabel ? ` (дата сдачи: ${s.completionDateLabel})` : '';
                lines.push(`• ${s.itemTitle} — ${st}${completionDate}${lastConfirmed}`);
              }
              if (exam.selected.length >= 4) {
                lines.push('', 'Если обязательных больше, остальные появятся в следующих напоминаниях.');
              }
              keyboard.push(
                ...exam.selected.map((s) => [
                  {
                    text: s.status === 'rejected' ? '↩ Фото заново' : '📸 Отправить фото',
                    callback_data: `planner_exam_upload_${s.id}`,
                  },
                ])
              );
            }
          } catch (e: unknown) {
            console.error('[Planner] Failed to build exams mandatory section:', e);
          }

          keyboard.push([{ text: 'Вернуться к задачам', callback_data: 'planner_back_to_tasks' }]);

          task.text = lines.join('\n');
          opts.reply_markup = { inline_keyboard: keyboard };
        }
      }
      const result = await bot.telegram.sendMessage(task.chat_id, task.text, opts);
      db
        .prepare("UPDATE send_queue SET status = 'sent', next_attempt_at = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(task.id);

      if (task.type === 'chat' && task.event_id != null && task.notification_type) {
        db.prepare(
          `INSERT INTO event_chat_messages (event_id, chat_id, message_id, thread_id, role)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          task.event_id,
          task.chat_id,
          result.message_id,
          task.message_thread_id ?? null,
          task.notification_type
        );
      }
      if (task.type === 'dm' && task.event_id != null && task.student_id != null && task.notification_type) {
        db.prepare(
          `INSERT OR IGNORE INTO event_dm_log (event_id, student_id, notification_type) VALUES (?, ?, ?)`
        ).run(task.event_id, task.student_id, task.notification_type);
        db.prepare(
          `INSERT OR REPLACE INTO event_dm_messages (event_id, student_id, chat_id, message_id, notification_type)
           VALUES (?, ?, ?, ?, ?)`
        ).run(task.event_id, task.student_id, task.chat_id, result.message_id, task.notification_type);
        db.prepare("UPDATE students SET last_dm_at = datetime('now') WHERE id = ?").run(task.student_id);
      }

      // Логирование факта доставки для рассылок /push (selection_id не NULL).
      if (task.type === 'dm' && task.selection_id != null && task.student_id != null) {
        db.prepare(
          `INSERT INTO push_log (selection_id, student_id, message_text, success)
           VALUES (?, ?, ?, 1)`
        ).run(task.selection_id, task.student_id, task.text);
      }
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string; errno?: string };
      const message = String(err?.message ?? e);
      const isBlocked = err.code === 403 && message.toLowerCase().includes('blocked');
      const isRateLimited = err.code === 429 || message.includes('Too Many Requests');
      const isConnReset = err.errno === 'ECONNRESET' || message.includes('ECONNRESET');

      if (isBlocked && task.student_id) {
        db.prepare('UPDATE students SET dm_blocked = 1 WHERE id = ?').run(task.student_id);
      }

      if (isRateLimited || isConnReset) {
        // При 429/сетевой ошибке — ретрай через backoff и с ограничением MAX_RETRIES.
        const nextRetryCount = (task.retry_count ?? 0) + 1;
        if (nextRetryCount > MAX_RETRIES) {
          db.prepare(
            "UPDATE send_queue SET status = 'failed', next_attempt_at = NULL, error_message = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(`max retries reached (${MAX_RETRIES}) — ${message}`, task.id);
        } else {
          const backoffSeconds = Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * Math.pow(2, nextRetryCount - 1));
          db.prepare(
            `UPDATE send_queue
             SET status = 'pending',
                 retry_count = ?, next_attempt_at = datetime('now', '+' || ? || ' seconds'),
                 error_message = ?, claimed_at = NULL,
                 updated_at = datetime('now')
             WHERE id = ?`
          ).run(nextRetryCount, backoffSeconds, message, task.id);
        }
      } else {
        db.prepare(
          "UPDATE send_queue SET status = 'failed', next_attempt_at = NULL, error_message = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(message, task.id);

        // Невосстановимая ошибка отправки для /push: фиксируем неудачу.
        if (task.type === 'dm' && task.selection_id != null && task.student_id != null) {
          db.prepare(
            `INSERT INTO push_log (selection_id, student_id, message_text, success)
             VALUES (?, ?, ?, 0)`
          ).run(task.selection_id, task.student_id, task.text);
        }
      }
    }
  }
}
