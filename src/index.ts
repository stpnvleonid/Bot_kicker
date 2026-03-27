/**
 * Точка входа: Telegram-бот (polling) + планировщик джобов + воркер очереди отправки.
 */

import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import { getConfig } from './config';
import { getDb, closeDb } from './db';
import { runMigrations } from './db/migrate';
import {
  enableFetchProxyFallback,
  getTelegramNodeFetchAgents,
  getTelegramSocksProxyUrlsForLogs,
  isTelegramProxyEnabled,
  validateTelegramSocksProxyEnv,
} from './net/internal-proxy';
import { initLogger } from './net/logger';
import {
  handleStart,
  handleHelp,
  handleSettings,
  handleSettingsCallback,
  handleAddAdmin,
  handleAdminHelpSectionCallback,
  handleAdminDebtsSubjectCallback,
  handleAdminExamsMonitorCallback,
  handleSubjects,
  handleSubjectsCallback,
  handleLinkGroup,
  handleLinkTopic,
  handleChatId,
  handleCheckTopics,
  handleSubscribers,
  handleSelect,
  handlePush,
  handleDebts,
  handleExportExamsWeek,
  handleExamsMonitorWeek,
  handlePushReport,
  handlePushCallback,
  handleConfirmReminder,
  handlePlannerCount,
  handlePlannerInfo,
  handlePlannerStartToday,
  handlePlannerEditTask,
  handlePlannerDeleteTask,
  handlePlannerAddTask,
  handlePlannerEditDone,
  handlePlannerRemind,
  handlePlannerUpcoming,
  handlePlannerText,
  handlePlannerStatus,
  handlePlannerDoneSummary,
  handlePlannerDoneToggle,
  handlePlannerBackToTasks,
  handleGroups,
  handleEvents,
  handleSyncNow,
  handleStatus,
  handlePlannerEveningNow,
  handlePlannerExportNow,
  BOT_VERSION,
  handlePlannerExamUpload,
  handlePlannerExamPhoto,
  handlePlannerExamCompletionDateText,
  handlePlannerExamAdminConfirm,
  handlePlannerExamAdminReject,
} from './bot/commands';
import { runCalendarSyncJob } from './jobs/calendar-sync';
import { runNotificationSchedulerJob } from './jobs/notification-scheduler';
import { runSendQueueWorkerIteration } from './jobs/send-queue-worker';
import { runCleanupArchiveJob } from './jobs/cleanup-archive';
import { runExamsSubmissionsBackfillJob } from './jobs/exams-backfill';
import { runExamsGapCheckJob } from './jobs/exams-gap-check';
import {
  runPlannerMorningJob,
  runPlannerEveningJob,
  runPlannerEndOfDayReminder,
  runPlannerExportIfAllUpdated,
  runPlannerFinalExport,
  runPlannerFullExportJobForDate,
  getClosingTaskDate,
  getDateInMoscow,
} from './jobs/planner';

const IS_PROD = process.env.NODE_ENV === 'production';

const PID_FILE = path.resolve('.bot.pid');

/** Проверка: если есть включённые календари — нужен GOOGLE_APPLICATION_CREDENTIALS и существующий файл. */
function validateCalendarConfig(): boolean {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM calendar_config WHERE enabled = 1').all() as Array<{ id: number }>;
  if (rows.length === 0) return true;
  const config = getConfig();
  const keyPath = config.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath || !keyPath.trim()) {
    console.warn('[Startup] GOOGLE_APPLICATION_CREDENTIALS не задан, но есть включённые календари.');
    return false;
  }
  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) {
    console.warn('[Startup] Файл ключа календаря не найден:', resolved);
    return false;
  }
  return true;
}

/** Проверка: чтобы Job’ы экспорта планера в Google Sheets работали без падений. */
function validatePlannerConfig(): boolean {
  const config = getConfig();
  const sheetId = config.PLANNER_SHEET_ID;
  if (!sheetId || !sheetId.trim()) {
    console.warn('[Startup] PLANNER_SHEET_ID не задан или пустой — экспорт планера в Sheets отключён.');
    return false;
  }

  const keyPath = config.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath || !keyPath.trim()) {
    console.warn('[Startup] GOOGLE_APPLICATION_CREDENTIALS не задан — экспорт планера в Sheets отключён.');
    return false;
  }
  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) {
    console.warn(
      '[Startup] Файл ключа Google не найден для планера:',
      resolved,
      '(проверьте том ./secrets в Docker и путь в .env).'
    );
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  // Включаем структурированные логи в начале, чтобы поймать все startup-ошибки.
  initLogger();
  const config = getConfig();

  // Сохраняем PID процесса бота, чтобы его можно было остановить через npm stop
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), { encoding: 'utf8' });
  } catch (e) {
    console.error('Cannot write PID file', e);
  }

  // Ensure DB and migrations
  getDb();
  runMigrations();

  const calendarOk = validateCalendarConfig();
  if (!calendarOk) {
    console.warn('[Startup] Календарь не настроен или ключ отсутствует — Job1 не будет запускаться по расписанию.');
  }

  const plannerOk = validatePlannerConfig();
  if (!plannerOk) {
    console.warn('[Startup] Planner export в Google Sheets не настроен — экспортные Job5 (ранний/финальный/2h) будут пропущены.');
  }

  console.log('[Startup] Bot version:', BOT_VERSION);
  console.log(
    '[Startup] Telegram API:',
    isTelegramProxyEnabled()
      ? 'SOCKS proxy enabled (see TELEGRAM_SOCKS_PROXY_*)'
      : 'direct (no SOCKS; set TELEGRAM_SOCKS_PROXY_ENABLED=1 to use local proxy)'
  );
  validateTelegramSocksProxyEnv();

  // First try to route outgoing HTTP/HTTPS via the internal SOCKS5 proxy.
  // If all proxies are unavailable/unreachable, retry requests directly (only Telegram API).
  enableFetchProxyFallback();

  // Telegraf → node-fetch → свой agent; global fetch не используется для Bot API.
  // Берём список агентов в порядке приоритета из TELEGRAM_SOCKS_PROXY_URLS и перебираем на старте.
  const telegramHttpAgents = await getTelegramNodeFetchAgents();
  const telegramProxyUrls = getTelegramSocksProxyUrlsForLogs();
  const bot = new Telegraf(
    config.BOT_TOKEN,
    telegramHttpAgents.length ? { telegram: { agent: telegramHttpAgents[0] as any } } : {}
  );
  if (telegramHttpAgents.length) {
    const mapped = telegramProxyUrls.length
      ? telegramProxyUrls.map((u, i) => `${i + 1}) ${u}`).join(' | ')
      : `${telegramHttpAgents.length} item(s)`;
    console.log('[Startup] Telegraf: SOCKS agents attached (priority order):', mapped);
  }

  // Хэндлы для фоновых задач, чтобы корректно останавливать их при завершении процесса.
  let job1CalendarSync: cron.ScheduledTask | null = null;
  let job2Notification: cron.ScheduledTask | null = null;
  let job5Morning: cron.ScheduledTask | null = null;
  let job5Evening: cron.ScheduledTask | null = null;
  let job5Remind: cron.ScheduledTask | null = null;
  let job5EarlyExport: cron.ScheduledTask | null = null;
  let job5Export: cron.ScheduledTask | null = null;
  let job5TwoHourExport: cron.ScheduledTask | null = null;
  let job4Cleanup: cron.ScheduledTask | null = null;
  let job6ExamsBackfill: cron.ScheduledTask | null = null;
  let job7ExamsGapCheck: cron.ScheduledTask | null = null;
  let job3Interval: NodeJS.Timeout | null = null;

  // Глобальное логирование всех апдейтов (действий пользователя) — в проде можно приглушить.
  bot.use(async (ctx, next) => {
    if (!IS_PROD) {
      try {
        const from = ctx.from
          ? `from_id=${ctx.from.id} username=@${ctx.from.username ?? ''}`
          : 'from=unknown';
        const chat = ctx.chat ? `chat_id=${ctx.chat.id} type=${ctx.chat.type}` : 'chat=unknown';

        if ('message' in ctx && ctx.message && 'text' in ctx.message) {
          console.log('[Update] message', from, chat, `text="${ctx.message.text}"`);
        } else if ('callbackQuery' in ctx && ctx.callbackQuery && 'data' in ctx.callbackQuery) {
          console.log(
            '[Update] callback',
            from,
            chat,
            `id=${ctx.callbackQuery.id} data="${ctx.callbackQuery.data}"`
          );
        } else {
          console.log('[Update] other', from, chat);
        }
      } catch (e) {
        console.error('[Update] log error:', e);
      }
    }

    return next();
  });

  // Глобальный журнал callback'ов: защищаемся от повторной обработки одного и того же callback_query.id.
  bot.use(async (ctx, next) => {
    const cb = ctx.callbackQuery;
    if (!cb || !('id' in cb)) {
      return next();
    }

    const cbId = cb.id;
    const db = getDb();
    try {
      db.prepare(
        `INSERT INTO callback_log (id, created_at) VALUES (?, datetime('now'))`
      ).run(cbId);
      // Вставка прошла — первый раз видим этот callback, продолжаем цепочку.
      return next();
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (msg.includes('UNIQUE constraint failed') || msg.includes('PRIMARY KEY')) {
        // Этот callback уже обрабатывался ранее — просто подтверждаем его и не выполняем хендлеры ещё раз.
        if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
          await ctx.answerCbQuery().catch(() => {});
        }
        return;
      }
      console.error('[CallbackLog] unexpected error while inserting callback_log:', e);
      // При неожиданных ошибках не блокируем обработку — лучше продвинуться дальше.
      return next();
    }
  });

  // Глобальный перехват и логирование ошибок Telegraf.
  bot.catch((err, ctx) => {
    const from = ctx?.from
      ? `from_id=${ctx.from.id} username=@${ctx.from.username ?? ''}`
      : 'from=unknown';
    const chat = ctx?.chat ? `chat_id=${ctx.chat.id} type=${ctx.chat.type}` : 'chat=unknown';
    console.error('[Bot error]', from, chat, err);
  });

  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('settings', handleSettings);
  bot.command('subjects', handleSubjects);
  bot.command('planner', handlePlannerInfo);
  bot.command('planner_remind', handlePlannerRemind);
  bot.command('planner_upcoming', handlePlannerUpcoming);
  bot.command('planner_export_now', handlePlannerExportNow);
  bot.action(/^subj_/, handleSubjectsCallback);
  bot.action(/^settings:/, handleSettingsCallback);
  bot.command('link_group', handleLinkGroup);
  bot.command('link_topic', handleLinkTopic);
  bot.command('chat_id', handleChatId);
  bot.command('check_topics', handleCheckTopics);
  bot.command('subscribers', handleSubscribers);
  bot.command('select', handleSelect);
  bot.command('push', handlePush);
  bot.command('debts', handleDebts);
  bot.command('export_exams_week', handleExportExamsWeek);
  bot.command('exams_monitor_week', handleExamsMonitorWeek);
  bot.command('push_report', handlePushReport);
  bot.command('groups', handleGroups);
  bot.command('events', handleEvents);
  bot.command('sync_now', handleSyncNow);
  bot.command('status', handleStatus);
  bot.command('planner_evening_now', handlePlannerEveningNow);
  bot.command('add_admin', handleAddAdmin);
  bot.action(/^adm_debt:/, handleAdminDebtsSubjectCallback);
  bot.action(/^adm_exams_report:/, handleAdminExamsMonitorCallback);
  bot.action(/^admin_help:/, handleAdminHelpSectionCallback);
  bot.action(/^push_confirm_/, handlePushCallback);
  bot.action(/^confirm_15m_/, handleConfirmReminder);
  bot.action('planner_start_today', handlePlannerStartToday);
  // Важно: /^planner_edit_/ перехватывал и спец-кнопки вроде `planner_edit_done`.
  // Поэтому ограничиваем только callback'ы с числовым taskId.
  bot.action(/^planner_edit_\d+$/, handlePlannerEditTask);
  bot.action(/^planner_del_/, handlePlannerDeleteTask);
  bot.action('planner_add_task', handlePlannerAddTask);
  bot.action('planner_edit_done', handlePlannerEditDone);
  bot.action(/^planner_count_/, handlePlannerCount);
  bot.action(/^planner_skip_day$/, handlePlannerCount);
  bot.action(/^planner_task_/, handlePlannerStatus);
  bot.action('planner_done_summary', handlePlannerDoneSummary);
  bot.action(/^planner_done_set_/, handlePlannerDoneToggle);
  bot.action('planner_back_to_tasks', handlePlannerBackToTasks);
  bot.action(/^planner_exam_upload_/, handlePlannerExamUpload);
  bot.action(/^planner_exam_admin_confirm_/, handlePlannerExamAdminConfirm);
  bot.action(/^planner_exam_admin_reject_/, handlePlannerExamAdminReject);
  // Сначала дата для exams-модерации: иначе handlePlannerText перехватывает текст и не вызывает next() — второй хендлер не срабатывал.
  bot.on('text', handlePlannerExamCompletionDateText);
  bot.on('text', handlePlannerText);
  bot.on('photo', handlePlannerExamPhoto);

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Подсказка при таймауте/сетевой ошибке к api.telegram.org (часто блокировка хоста). */
  const logTelegramBlockedHint = (err?: unknown): void => {
    const msg = String((err as { message?: string })?.message ?? err ?? '');
    const proxyOn = isTelegramProxyEnabled();
    if (msg.includes('127.0.0.1:1080')) {
      console.error(
        '[Startup] Hint: отказ в соединении с **127.0.0.1:1080** — внутри Docker это **сам контейнер**, не прокси на хосте. ' +
          'Укажите в TELEGRAM_SOCKS_PROXY_URLS **внешний** SOCKS5 (IP/DNS прокси), например socks5h://user:pass@37.x.x.x:443. ' +
          'Не полагайтесь на 127.0.0.1 без явного URL. См. docs/CONFIG.md'
      );
      return;
    }
    console.error(
      '[Startup] Hint: не удаётся достучаться до api.telegram.org (таймаут / сеть). ' +
        (proxyOn
          ? 'SOCKS включён — проверьте TELEGRAM_SOCKS_PROXY_URLS (доступность хоста/порта, логин/пароль, тип = SOCKS5).'
          : 'Сейчас режим **direct** — в .env задайте TELEGRAM_SOCKS_PROXY_ENABLED=1 и TELEGRAM_SOCKS_PROXY_URLS=socks5h://... (см. docs/CONFIG.md). ' +
            'Проверка: docker compose exec bot env | grep TELEGRAM')
    );
  };

  const isLikelyTelegramNetworkFailure = (e: unknown): boolean => {
    const msg = String((e as { message?: string })?.message ?? e);
    const type = String((e as { type?: string })?.type ?? '');
    return (
      type === 'request-timeout' ||
      type === 'system' ||
      msg.includes('api.telegram.org') ||
      msg.includes('timeout') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('EAI_AGAIN') ||
      msg.includes('ECONNRESET')
    );
  };

  /**
   * Важно: `bot.launch()` при long polling **никогда не резолвится** — внутри бесконечный цикл getUpdates.
   * Поэтому нельзя `await bot.launch()` и ждать строку «бот запущен» — код после await никогда не выполнится.
   * Схема: getMe + deleteWebhook (с ретраями) → cron/воркер → `void bot.launch().catch(...)`.
   */
  const dropPendingUpdates =
    process.env.TELEGRAM_DROP_PENDING_UPDATES === '1' || process.env.TELEGRAM_DROP_PENDING_UPDATES === 'true';

  const connectTelegramWithRetry = async (maxAttempts: number): Promise<void> => {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (telegramHttpAgents.length) {
          const idx = (attempt - 1) % telegramHttpAgents.length;
          // node-fetch path inside Telegraf reads this agent option.
          (bot.telegram as any).options.agent = telegramHttpAgents[idx];
          const proxyLabel = telegramProxyUrls[idx] ?? `#${idx + 1}`;
          console.log(
            '[Startup] getMe via SOCKS',
            `${idx + 1}/${telegramHttpAgents.length}:`,
            proxyLabel
          );
        }
        bot.botInfo = await bot.telegram.getMe();
        const u = bot.botInfo.username ?? '';
        console.log('[Startup] Telegram OK', u ? `@${u}` : '(no username)');
        return;
      } catch (e) {
        lastErr = e;
        const delayMs = Math.min(10000, 500 * attempt * attempt); // ~0.5s, 2s, 4.5s, 8s, 10s
        console.error('[Startup] getMe failed. Attempt', attempt, 'of', maxAttempts, '— retry in', delayMs, 'ms:', e);
        if (attempt === 1 && isLikelyTelegramNetworkFailure(e)) {
          logTelegramBlockedHint(e);
        }
        await sleep(delayMs);
      }
    }
    throw lastErr;
  };

  // Ретраим только getMe; deleteWebhook + long polling делает `launch()` (его нельзя await — см. ниже).
  try {
    console.log('[Startup] Connecting to Telegram (getMe)...');
    await connectTelegramWithRetry(5);
    console.log('[Startup] Bot started (polling) — registering background jobs...');
  } catch (e) {
    console.error('[Startup] Fatal: cannot connect to Telegram after retries:', e);
    if (isLikelyTelegramNetworkFailure(e)) {
      logTelegramBlockedHint(e);
    }
    process.exit(1);
  }

  // Job 1: каждые 30 минут (только если календарь настроен)
  if (calendarOk) {
    job1CalendarSync = cron.schedule('*/30 * * * *', () => {
      runCalendarSyncJob().catch((e) => console.error('Job1:', e));
    });
    console.log('Cron: Job1 calendar sync every 30 min');
  }

  // Job 2: планировщик уведомлений — раз в минуту,
  // чтобы «окна» 15 и 5 минут гарантированно попадали в запуск
  job2Notification = cron.schedule('* * * * *', () => {
    runNotificationSchedulerJob().catch((e) => console.error('Job2:', e));
  });
  console.log('Cron: Job2 notification scheduler every 1 min');

  // Job 5: планер учебных задач — 10:00 и 20:00 (см. comments в 2.txt)
  job5Morning = cron.schedule('0 10 * * *', () => {
    runPlannerMorningJob();
  }, { timezone: 'Europe/Moscow' });
  job5Evening = cron.schedule('0 20 * * *', () => {
    runPlannerEveningJob();
  }, { timezone: 'Europe/Moscow' });
  // 20:00 МСК: напоминание обновить статус задач (экспорт не запускаем)
  job5Remind = cron.schedule('0 20 * * *', () => {
    runPlannerEndOfDayReminder();
  }, { timezone: 'Europe/Moscow' });

  if (plannerOk) {
    // Каждые 15 мин (МСК): если все задачи обновлены — экспорт раньше (окно 20:00–02:00)
    job5EarlyExport = cron.schedule(
      '*/15 * * * *',
      () => {
        const closing = getClosingTaskDate();
        if (closing)
          runPlannerExportIfAllUpdated(closing).catch((e) => console.error('Job5 early export:', e));
      },
      { timezone: 'Europe/Moscow' }
    );

    // 02:00 МСК: экспорт за вчера в любом случае
    job5Export = cron.schedule(
      '0 2 * * *',
      () => {
        runPlannerFinalExport().catch((e) => console.error('Job5 export:', e));
      },
      { timezone: 'Europe/Moscow' }
    );

    // Каждые 2 часа (МСК): пересчёт отчёта по текущему дню как дополнительный страховочный экспорт.
    job5TwoHourExport = cron.schedule(
      '0 */2 * * *',
      () => {
        const todayMoscow = getDateInMoscow();
        runPlannerFullExportJobForDate(todayMoscow).catch((e) => console.error('Job5 2h export:', e));
      },
      { timezone: 'Europe/Moscow' }
    );
  }

  console.log(
    'Cron: Job5 planner at 10:00, 20:00 (evening + remind);' +
      (plannerOk ? ' */15 early export; 02:00 final export; */2h full export (Moscow)' : ' planner export disabled') +
      ''
  );

  // Job 3: воркер очереди каждые 5 секунд
  job3Interval = setInterval(() => {
    runSendQueueWorkerIteration(bot).catch((e) => console.error('Job3:', e));
  }, 5000);
  console.log('Worker: Job3 send queue every 5s');

  // Job 4: раз в сутки в 03:00
  job4Cleanup = cron.schedule('0 3 * * *', () => {
    runCleanupArchiveJob().catch((e) => console.error('Job4:', e));
  });
  console.log('Cron: Job4 cleanup daily at 03:00');

  // Job 6: backfill exams submissions каждый час (идемпотентный).
  job6ExamsBackfill = cron.schedule('0 * * * *', () => {
    runExamsSubmissionsBackfillJob().catch((e) => console.error('Job6:', e));
  });
  console.log('Cron: Job6 exams submissions backfill hourly');

  // Job 7: check gap-инварианта каждые 2 часа.
  job7ExamsGapCheck = cron.schedule('15 */2 * * *', () => {
    runExamsGapCheckJob().catch((e) => console.error('Job7:', e));
  });
  console.log('Cron: Job7 exams gaps check every 2h');

  // Long polling не await — `launch()` внутри ждёт бесконечный цикл getUpdates и никогда не резолвится.
  console.log('[Startup] Starting long polling (deleteWebhook + getUpdates loop)...');
  void bot.launch({ dropPendingUpdates: dropPendingUpdates }).catch((e) => {
    console.error('[Startup] Fatal: Telegram polling stopped with error:', e);
    process.exit(1);
  });

  const shutdown = (reason: string): void => {
    console.log('[Shutdown] Received', reason, '- stopping bot and background jobs...');
    bot.stop(reason);

    if (job1CalendarSync) job1CalendarSync.stop();
    if (job2Notification) job2Notification.stop();
    if (job5Morning) job5Morning.stop();
    if (job5Evening) job5Evening.stop();
    if (job5Remind) job5Remind.stop();
    if (job5EarlyExport) job5EarlyExport.stop();
    if (job5Export) job5Export.stop();
    if (job5TwoHourExport) job5TwoHourExport.stop();
    if (job4Cleanup) job4Cleanup.stop();
    if (job6ExamsBackfill) job6ExamsBackfill.stop();
    if (job7ExamsGapCheck) job7ExamsGapCheck.stop();
    if (job3Interval) {
      clearInterval(job3Interval);
      job3Interval = null;
    }

    closeDb();

    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }

    // Явно завершаем процесс, чтобы не оставалось висящих таймеров.
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
