/**
 * Обработчики команд бота: /start, /settings, /subjects, админ /link_group, /link_topic, /select, /push, /debts, /groups, /events, /sync_now, /status.
 */

import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db';
import { confirmExamSubmission, getSubmissionForModeration, rejectExamSubmission, setExamCompletionDate, upsertExamEvidence } from '../db/planner-exams';
import { SUBJECT_TOPIC_NAMES } from '../config/subjects';
import { getConfig } from '../config';
import { runCalendarSyncJob } from '../jobs/calendar-sync';
import {
  PLANNER_MAX_TASKS,
  getDateInMoscow,
  runPlannerMorningRemind,
  runPlannerFullExportJobForDate,
  runPlannerEveningJobForDate,
} from '../jobs/planner';
import { selectPendingExamSubmissionsForStudent } from '../jobs/planner-exams';
import { parseRuDateFromCaption, parseRuDdMmToIso } from '../utils/parse-ru-dd-mm';
import { DEBTS_MENU_SUBJECT_KEYS, getAttendanceDebtsBySubject } from '../google/attendance-debts';
import { exportExamsWeekCsv } from '../jobs/exams-export';

export const BOT_VERSION = 'planner-back-button-v1';

const PUSH_LIMIT_PER_HOUR = 60;
const EVENTS_DISPLAY_TZ = 'Europe/Moscow';

/** Ожидающее подтверждение рассылки: admin_telegram_id → { selectionId, text } */
const pendingPushByAdmin = new Map<number, { selectionId: number; text: string }>();

/** Состояние «редактирую текст задачи»: telegram_user_id → { taskId, studentId, taskDate } */
const plannerEditingTask = new Map<number, { taskId: number; studentId: number; taskDate: string }>();
/** Состояние «добавляю новую задачу»: telegram_user_id → { studentId, taskDate } */
const plannerAddingTask = new Map<number, { studentId: number; taskDate: string }>();
/** Состояние «ожидаю ФИО после /start»: telegram_user_id → { studentId } */
const startAwaitingFio = new Map<number, { studentId: number }>();

/**
 * Mandatory "exams" evidence flow:
 * 1) plannerExamAwaitingPhoto: пользователь нажал кнопку и должен прислать фото
 * 2) Дата: в подписи к фото (предпочтительно) или отдельным сообщением DD MM
 */
const plannerExamAwaitingPhoto = new Map<number, { submissionId: number }>();
const plannerExamAwaitingCompletionDate = new Map<number, { submissionId: number }>();

/** Унифицированные безопасные вызовы Telegram API с простыми ретраями. */
async function safeAnswerCbQuery(ctx: Context, text?: string): Promise<void> {
  try {
    await ctx.answerCbQuery(text);
  } catch (e) {
    // Игнорируем любые ошибки answerCbQuery — это чисто UX.
  }
}

async function safeReply(
  ctx: Context,
  text: string,
  extra?: Parameters<Context['reply']>[1]
): Promise<void> {
  const maxAttempts = 3;
  let attempt = 0;
  // Простейший backoff: 0ms, 300ms, 700ms.
  const delays = [0, 300, 700];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await ctx.reply(text, extra as any);
      return;
    } catch (e: any) {
      attempt += 1;
      if (attempt >= maxAttempts) {
        // На последнем шаге просто сдаёмся — логирование останется на уровне процесса.
        return;
      }
      const delay = delays[attempt] ?? 700;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function safeEditMessageText(
  ctx: Context,
  text: string,
  extra?: Parameters<Context['editMessageText']>[1]
): Promise<void> {
  const maxAttempts = 3;
  let attempt = 0;
  const delays = [0, 300, 700];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await ctx.editMessageText(text, extra as any);
      return;
    } catch (e: any) {
      // message is not modified / message to edit not found — считаем нефатальными
      const msg = typeof e?.message === 'string' ? e.message : '';
      if (msg.includes('message is not modified') || msg.includes('MESSAGE_NOT_MODIFIED')) {
        return;
      }
      attempt += 1;
      if (attempt >= maxAttempts) {
        return;
      }
      const delay = delays[attempt] ?? 700;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Удаляет сообщение, с которым пришёл callback (чтобы не забивать чат). Только для лички пользователя. */
async function deleteCallbackMessage(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb?.message || !('message_id' in cb.message)) return;
  const chatId = ctx.chat?.id ?? (cb.message as { chat?: { id?: number } }).chat?.id;
  if (!chatId) return;
  const messageId = (cb.message as { message_id: number }).message_id;
  await ctx.telegram.deleteMessage(chatId, messageId).catch(() => {});
}

function plannerToday(): string {
  return getDateInMoscow();
}

async function buildMandatoryExamsPreview(studentId: number, taskDateIso: string): Promise<string[]> {
  const exam = await selectPendingExamSubmissionsForStudent({
    studentId,
    screenDateIso: taskDateIso,
    maxLessons: 2,
    maxHomeworks: 2,
    markPromptedAt: false, // утром только показываем, не сдвигаем ротацию top-4
  }).catch((e) => {
    console.error('[Planner] Failed to build mandatory exams preview:', e);
    return { selected: [], totalLessons: 0, totalHomeworks: 0, totalPending: 0 };
  });

  if (!exam.totalPending) return [];

  const lines: string[] = [];
  lines.push(`Обязательные exams на сегодня: ${exam.totalPending} (Урок: ${exam.totalLessons}, ДЗ: ${exam.totalHomeworks})`);
  for (const s of exam.selected) {
    lines.push(`• ${s.itemTitle}`);
  }
  if (exam.totalPending > exam.selected.length) {
    lines.push('Остальные обязательные задачи подтянутся в следующих напоминаниях.');
  }
  return lines;
}

/** Текст и клавиатура экрана «Отметь выполненные задачи на сегодня (дата)». */
async function buildPlannerDoneSummaryPayload(
  studentId: number,
  taskDateIso: string,
  options?: { markPromptedAt?: boolean }
): Promise<{ text: string; inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }> {
  const markPromptedAt = options?.markPromptedAt !== false;
  const db = getDb();
  const tasks = db
    .prepare(
      `SELECT id, idx, text, status
       FROM daily_tasks
       WHERE student_id = ? AND task_date = ?
       ORDER BY idx`
    )
    .all(studentId, taskDateIso) as Array<{ id: number; idx: number; text: string; status: string }>;

  const statusLabel = (s: string): string => {
    if (s === 'completed') return '✅';
    if (s === 'partly_done') return '🟡';
    if (s === 'cancelled') return '❌';
    return '⬜';
  };

  const exam = await selectPendingExamSubmissionsForStudent({
    studentId,
    screenDateIso: taskDateIso,
    maxLessons: 2,
    maxHomeworks: 2,
    markPromptedAt,
  }).catch((e) => {
    console.error('[Planner] Failed to build exams mandatory section:', e);
    return { selected: [], totalLessons: 0, totalHomeworks: 0, totalPending: 0 };
  });

  const lines = [`Отметь выполненные задачи на сегодня (${taskDateIso}):`, ''];
  if (tasks.length) {
    lines.push(...tasks.map((t) => `${t.idx}. ${t.text} ${statusLabel(t.status)}`));
    lines.push('');
    lines.push('Нажимай на кнопки под каждой задачей, чтобы отметить, что сделано полностью или частично.');
  } else {
    lines.push('Планерных задач на сегодня нет.');
  }
  lines.push('Также ниже есть обязательные "exams" (Урок + ДЗ): их подтверждает админ после получения фото.');
  lines.push('Кнопка 📸 отправляет фото-подтверждение по соответствующей строке exams.');
  if (exam.selected.length) {
    lines.push('');
    lines.push('Обязательные "exams" на модерации:');
    for (const s of exam.selected) {
      const st = s.status === 'rejected' ? 'отклонено' : 'в ожидании';
      const completionDate = s.completionDateLabel ? ` (дата сдачи: ${s.completionDateLabel})` : '';
      const lastConfirmed = s.lastConfirmedCompletionDateLabel ? ` (последнее подтверждено: ${s.lastConfirmedCompletionDateLabel})` : '';
      lines.push(`• ${s.itemTitle} — ${st}${completionDate}${lastConfirmed}`);
    }
    if (exam.totalPending > exam.selected.length) {
      lines.push('Остальные обязательные задачи подтянутся в следующих напоминаниях.');
    }
  }

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
    ...tasks.map((t) => [
      { text: `✅ Полностью ${t.idx}`, callback_data: `planner_done_set_completed_${t.id}` },
      { text: `🟡 Частично ${t.idx}`, callback_data: `planner_done_set_partly_${t.id}` },
      { text: '❌ Отмена!', callback_data: `planner_done_set_cancelled_${t.id}` },
    ]),
    ...exam.selected.map((s) => [
      {
        text: s.status === 'rejected' ? '↩ Фото заново' : `📸 Фото ${s.itemTitle}`,
        callback_data: `planner_exam_upload_${s.id}`,
      },
    ]),
    [{ text: 'Вернуться к задачам', callback_data: 'planner_back_to_tasks' }],
  ];

  return { text: lines.join('\n'), inline_keyboard: keyboard };
}

async function getOrCreateStudentId(ctx: Context): Promise<number | null> {
  if (!ctx.from) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT id FROM students WHERE telegram_user_id = ?')
    .get(ctx.from.id) as { id: number } | undefined;
  if (row) return row.id;
  return null;
}

/** Кнопки разделов админ-помощи (/help у админа). */
const ADMIN_HELP_SECTIONS = [
  { id: 'routing', label: 'Связь/Топики' },
  { id: 'broadcasts', label: 'Рассылки' },
  { id: 'calendar', label: 'Календарь/События' },
  { id: 'planner', label: 'Планер' },
  { id: 'debts', label: 'Успеваемость' },
  { id: 'admins', label: 'Админ-аккаунты' },
] as const;

function buildAdminHelpMainKeyboard() {
  const s = ADMIN_HELP_SECTIONS;
  return {
    inline_keyboard: [
      [Markup.button.callback(s[0].label, `admin_help:sec:${s[0].id}`), Markup.button.callback(s[1].label, `admin_help:sec:${s[1].id}`)],
      [Markup.button.callback(s[2].label, `admin_help:sec:${s[2].id}`), Markup.button.callback(s[3].label, `admin_help:sec:${s[3].id}`)],
      [Markup.button.callback(s[4].label, `admin_help:sec:${s[4].id}`), Markup.button.callback(s[5].label, `admin_help:sec:${s[5].id}`)],
    ],
  };
}

export async function handleHelp(ctx: Context): Promise<void> {
  const isAdminUser = ctx.from ? isAdmin(ctx.from.id) : false;

  if (ctx.from) {
    console.log(
      '[User] /help',
      `telegram_user_id=${ctx.from.id}`,
      `username=@${ctx.from.username ?? ''}`,
      `is_admin=${isAdminUser}`
    );
  }

  const commonLines = [
    'Я бот календаря. Что умею:',
    '',
    '/start — зарегистрироваться и привязаться к группе',
    '/settings — настройки ЛС и тихих часов',
    '/subjects — выбрать предметы для личных уведомлений',
    '/planner — как работает планер учебных задач',
    '',
  ];

  if (!isAdminUser) {
    await ctx.reply(
      [
        ...commonLines,
        '',
        'Чтобы получать ЛС: выберите предметы через /subjects и включите уведомления в /settings.',
      ].join('\n')
    );
    return;
  }

  await ctx.reply(
    [
      ...commonLines,
      '',
      'Админам: выбери раздел (всё структурировано по группам команд).',
    ].join('\n'),
    { reply_markup: buildAdminHelpMainKeyboard() }
  );
}

function getAdminHelpSectionText(sectionId: string): { title: string; lines: string[] } {
  switch (sectionId) {
    case 'routing':
      return {
        title: 'Связь / маршрутизация (топики, ветки, группы)',
        lines: [
          '/link_group <Название> — привязать чат к группе и календарю',
          '/link_topic <предмет> — привязать топик к предмету',
          '/groups — список групп и chat_id',
          '/chat_id — показать chat_id (и topic_id в топике)',
          '/check_topics — проверить привязку топиков (чтобы сообщения шли в ветки, а не в General)',
          '/subscribers — кто подписан на бота и календарь «2 курс»',
        ],
      };
    case 'broadcasts':
      return {
        title: 'Рассылки в ЛС (/select → /push)',
        lines: [
          '/select C=Имя — выборка по курсу/группе',
          '/select E=ID — выборка по событию',
          '/select G=<предмет> — выборка по предмету (по всей базе)',
          '/push Текст — рассылка в ЛС (с подтверждением)',
          '/push_report [selection_id] — отчёт по доставке рассылки',
        ],
      };
    case 'calendar':
      return {
        title: 'Календарь и события',
        lines: ['/sync_now — ручная синхронизация календаря', '/events [N] — ближайшие события', '/status — состояние очередей и синхронизации'],
      };
    case 'planner':
      return {
        title: 'Планер учебных задач',
        lines: [
          '/planner_remind [YYYY-MM-DD] — повторно отправить приглашение планера',
          '/planner_evening_now [YYYY-MM-DD] — вручную отправить экран «Отметь выполненные задачи» за дату',
          '/planner_export_now [YYYY-MM-DD] — полный экспорт планера в Google Таблицу',
          '/planner_upcoming — показать события на ближайшие 24 часа (с предметами)',
          '/planner — как работает планер',
        ],
      };
    case 'debts':
      return {
        title: 'Успеваемость',
        lines: [
          '/export_exams_week YYYY-MM-DD — CSV по вебинарам/ДЗ exams (Пн–Сб, expected/confirmed, только student_id).',
          '/debts <предмет> — долги из вкладки «Посещаемость» (Google Sheets).',
          '',
          'Ниже — быстрый выбор предмета.',
        ],
      };
    case 'admins':
      return {
        title: 'Админ-аккаунты',
        lines: ['/add_admin <@username|user_id> — добавить админа', 'Также работает: ответь на сообщение пользователя и вызови /add_admin'],
      };
    default:
      return {
        title: 'Админская помощь',
        lines: [],
      };
  }
}

export async function handleAdminHelpSectionCallback(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (data === 'admin_help:back') {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('Команда только для администраторов.');
      return;
    }

    const commonLines = [
      'Я бот календаря. Что умею:',
      '',
      '/start — зарегистрироваться и привязаться к группе',
      '/settings — настройки ЛС и тихих часов',
      '/subjects — выбрать предметы для личных уведомлений',
      '/planner — как работает планер учебных задач',
      '',
    ];

    await ctx
      .editMessageText(
        [...commonLines, 'Админам: выбери раздел (всё структурировано по группам команд).'].join('\n'),
        { reply_markup: buildAdminHelpMainKeyboard() }
      )
      .catch(() => {});
    await ctx.answerCbQuery();
    return;
  }

  if (!data.startsWith('admin_help:sec:')) return;
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Команда только для администраторов.');
    return;
  }

  const sectionId = data.slice('admin_help:sec:'.length);
  const { title, lines } = getAdminHelpSectionText(sectionId);

  const commonLines = [
    'Я бот календаря. Что умею:',
    '',
    '/start — зарегистрироваться и привязаться к группе',
    '/settings — настройки ЛС и тихих часов',
    '/subjects — выбрать предметы для личных уведомлений',
    '/planner — как работает планер учебных задач',
    '',
  ];

  const text = [...commonLines, title, '', ...lines].join('\n');

  if (sectionId === 'debts') {
    const row1 = DEBTS_MENU_SUBJECT_KEYS.slice(0, 3).map((k) =>
      Markup.button.callback(SUBJECT_TOPIC_NAMES[k] ?? k, `adm_debt:${k}`)
    );
    const row2 = DEBTS_MENU_SUBJECT_KEYS.slice(3, 6).map((k) =>
      Markup.button.callback(SUBJECT_TOPIC_NAMES[k] ?? k, `adm_debt:${k}`)
    );
    await ctx
      .editMessageText(text, {
        reply_markup: {
          inline_keyboard: [row1, row2, [Markup.button.callback('« Назад к разделам', 'admin_help:back')]],
        },
      })
      .catch(() => {});
  } else {
    await ctx.editMessageText(text, { reply_markup: buildAdminHelpMainKeyboard() }).catch(() => {});
  }
  await ctx.answerCbQuery();
}

export async function handleAddAdmin(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text || '' : '';
  const match = /\/add_admin\s+(.+)/s.exec(text);

  const db = getDb();

  let targetUserId: number | null = null;

  const tryResolveByArg = async (arg: string): Promise<number | null> => {
    const v = arg.trim();
    if (!v) return null;

    // @username или username
    if (v.startsWith('@') || /^[a-zA-Z0-9_]+$/.test(v)) {
      try {
        const chat = await ctx.telegram.getChat(v.startsWith('@') ? v : `@${v}`);
        const id = (chat as { id?: number }).id;
        return typeof id === 'number' ? id : null;
      } catch {
        // fallthrough
      }
    }

    // user_id (число)
    const n = parseInt(v.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  if (match?.[1]) {
    targetUserId = await tryResolveByArg(match[1]);
  } else if (ctx.message && 'reply_to_message' in ctx.message) {
    const from = (ctx.message as any).reply_to_message?.from;
    const id = typeof from?.id === 'number' ? from.id : null;
    targetUserId = id;
  }

  if (!targetUserId) {
    await ctx.reply('Использование: /add_admin <@username|user_id> или ответь на сообщение пользователя и вызови /add_admin');
    return;
  }

  try {
    const res = db.prepare('INSERT OR IGNORE INTO admins (telegram_user_id) VALUES (?)').run(targetUserId);
    if ('changes' in res && (res as any).changes === 0) {
      await ctx.reply(`Пользователь уже администратор: telegram_user_id=${targetUserId}`);
    } else {
      await ctx.reply(`Добавил админа: telegram_user_id=${targetUserId}`);
    }
  } catch (e) {
    await ctx.reply('Не удалось добавить админа: ' + String(e));
  }
}

export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const db = getDb();
  const uid = ctx.from.id;
  const username = ctx.from.username ?? null;
  const firstName = ctx.from.first_name ?? '';
  const lastName = ctx.from.last_name ?? '';

  const existedBefore = !!db.prepare('SELECT 1 FROM students WHERE telegram_user_id = ?').get(uid);

  // Всегда обновляем/создаём запись студента (и в ЛС, и в группе),
  // но ФИО существующего студента не перезаписываем данными из Telegram-профиля.
  db.prepare(
    `INSERT INTO students (telegram_user_id, telegram_username, first_name, last_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       telegram_username = excluded.telegram_username,
       first_name = students.first_name,
       last_name = students.last_name,
       updated_at = datetime('now')`
  ).run(uid, username, firstName, lastName);

  if (ctx.chat?.type === 'private') {
    await ctx.reply(
      'Привет! Я сумасшедший бот - помощник Леонида: присылаю события из расписания в личку. ' +
        'Буду писать, когда меня попросит Лео и помогать ему вас пушить! =D ' +
        'А для вас я предоставляю функции лёгкого планирования прямо с телефона через Телеграм.\n\n' +
        `Текущая версия бота: ${BOT_VERSION}\n\n` +
        'Основные команды всегда под рукой внизу:\n' +
        '— /help — справка\n' +
        '— /settings — настройки ЛС и тихих часов\n' +
        '— /subjects — выбрать предметы для уведомлений\n' +
        '— /planner — планер учебных задач',
      Markup.keyboard([
        ['/help', '/settings'],
        ['/subjects', '/planner'],
      ]).resize()
    );

    // Подсказка про /subjects (минимально, чтобы не спамить):
    // показываем только на первом `/start` для нового студента, если предметы ещё не выбраны.
    if (!existedBefore) {
      const studentId = db
        .prepare('SELECT id, first_name, last_name FROM students WHERE telegram_user_id = ?')
        .get(uid) as { id: number; first_name: string | null; last_name: string | null } | undefined;
      if (studentId) {
        const hasSubjects = !!db
          .prepare(
            'SELECT 1 FROM student_subjects WHERE student_id = ? LIMIT 1'
          )
          .get(studentId.id);
        if (!hasSubjects) {
          await ctx.reply('Чтобы получать уведомления по предметам, выберите их: нажмите /subjects и отметьте нужные.');
        }

        // ФИО запрашиваем только один раз — при первом /start и только если Telegram не дал полные данные.
        const storedFirst = (studentId.first_name ?? '').trim();
        const storedLast = (studentId.last_name ?? '').trim();
        if (!storedFirst || !storedLast) {
          startAwaitingFio.set(uid, { studentId: studentId.id });
          await ctx.reply(
            'Перед первым использованием планера укажите ФИО одним сообщением в формате:\n`Фамилия Имя`.\n\n' +
              'Это нужно для корректного сопоставления в таблице планирования.'
          );
        }
      }
    }

    return;
  }

  // В группе: привязать пользователя к группе, чтобы получать ЛС по событиям этой группы
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    const chatId = ctx.chat.id;
    const group = db.prepare('SELECT id FROM groups WHERE telegram_chat_id = ?').get(chatId) as { id: number } | undefined;
    if (group) {
      const student = db.prepare('SELECT id FROM students WHERE telegram_user_id = ?').get(uid) as { id: number } | undefined;
      if (student) {
        db.prepare('INSERT OR IGNORE INTO student_groups (student_id, group_id) VALUES (?, ?)').run(student.id, group.id);
        await ctx.reply('Вы добавлены в группу для уведомлений. Чтобы получать напоминания в личку — напишите боту в ЛС /start и выберите предметы: /subjects');
      }
    }
  }
}

export async function handleSettings(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Настройки доступны только в личных сообщениях с ботом.');
    return;
  }
  if (!ctx.from) return;
  console.log(
    '[User] /settings',
    `telegram_user_id=${ctx.from.id}`,
    `username=@${ctx.from.username ?? ''}`
  );
  const db = getDb();
  const student = db
    .prepare(
      'SELECT id, notify_dm, notify_quiet_hours_start, notify_quiet_hours_end FROM students WHERE telegram_user_id = ?'
    )
    .get(ctx.from.id) as
    | {
        id: number;
        notify_dm: number;
        notify_quiet_hours_start: string | null;
        notify_quiet_hours_end: string | null;
      }
    | undefined;
  if (!student) {
    await ctx.reply('Сначала нажмите /start, затем откройте настройки ещё раз.');
    return;
  }

  const dmLabel = student.notify_dm ? 'ЛС: ✅ включены' : 'ЛС: ❌ выключены';
  const quietLabel =
    student.notify_quiet_hours_start && student.notify_quiet_hours_end
      ? `Тихие часы: ${student.notify_quiet_hours_start}–${student.notify_quiet_hours_end}`
      : 'Тихие часы: выкл';

  await ctx.reply('Настройки уведомлений:', {
    reply_markup: {
      inline_keyboard: [
        [Markup.button.callback(dmLabel, 'settings:dm:toggle')],
        [Markup.button.callback(quietLabel, 'settings:quiet:cycle')],
      ],
    },
  });
}

/** Выбор предметов для ЛС: по каким предметам присылать уведомления. */
export async function handleSubjects(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Выбор предметов доступен только в личке с ботом.');
    return;
  }
  if (!ctx.from) return;
  console.log(
    '[User] /subjects',
    `telegram_user_id=${ctx.from.id}`,
    `username=@${ctx.from.username ?? ''}`
  );
  const db = getDb();
  const student = db.prepare('SELECT id FROM students WHERE telegram_user_id = ?').get(ctx.from.id) as { id: number } | undefined;
  if (!student) {
    await ctx.reply('Сначала нажмите /start.');
    return;
  }
  const selected = new Set(
    (db.prepare('SELECT subject_key FROM student_subjects WHERE student_id = ?').all(student.id) as Array<{ subject_key: string }>).map((r) => r.subject_key)
  );
  const rows = SUBJECT_KEYS.map((key) => [
    Markup.button.callback(
      (selected.has(key) ? '✓ ' : '○ ') + SUBJECT_TOPIC_NAMES[key],
      `subj_${key}`
    ),
  ]);
  await ctx.reply('Выберите предметы, по которым присылать уведомления в ЛС (нажмите для переключения):', {
    reply_markup: { inline_keyboard: rows },
  });
}

export async function handleSubjectsCallback(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (!data.startsWith('subj_')) return;
  const subjectKey = data.slice(5);
  if (!SUBJECT_TOPIC_NAMES[subjectKey]) return;
  const db = getDb();
  const student = db.prepare('SELECT id FROM students WHERE telegram_user_id = ?').get(ctx.from.id) as { id: number } | undefined;
  if (!student) {
    await ctx.answerCbQuery('Сначала /start');
    return;
  }
  try {
    const has = db.prepare('SELECT 1 FROM student_subjects WHERE student_id = ? AND subject_key = ?').get(student.id, subjectKey);
    if (has) {
      db.prepare('DELETE FROM student_subjects WHERE student_id = ? AND subject_key = ?').run(student.id, subjectKey);
    } else {
      db.prepare('INSERT INTO student_subjects (student_id, subject_key) VALUES (?, ?)').run(student.id, subjectKey);
    }
  } catch {
    await ctx.answerCbQuery('Ошибка (миграции применены?)');
    return;
  }
  const selected = new Set(
    (db.prepare('SELECT subject_key FROM student_subjects WHERE student_id = ?').all(student.id) as Array<{ subject_key: string }>).map((r) => r.subject_key)
  );
  const rows = SUBJECT_KEYS.map((key) => [
    Markup.button.callback(
      (selected.has(key) ? '✓ ' : '○ ') + SUBJECT_TOPIC_NAMES[key],
      `subj_${key}`
    ),
  ]);
  await ctx.editMessageReplyMarkup({ inline_keyboard: rows }).catch(() => {});
  await ctx.answerCbQuery(selected.size ? `Выбрано: ${[...selected].map((k) => SUBJECT_TOPIC_NAMES[k]).join(', ')}` : 'Ничего не выбрано');
}

export async function handleSettingsCallback(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (!data.startsWith('settings:')) return;

  const db = getDb();
  const student = db
    .prepare(
      'SELECT id, notify_dm, notify_quiet_hours_start, notify_quiet_hours_end FROM students WHERE telegram_user_id = ?'
    )
    .get(ctx.from.id) as
    | {
        id: number;
        notify_dm: number;
        notify_quiet_hours_start: string | null;
        notify_quiet_hours_end: string | null;
      }
    | undefined;
  if (!student) {
    await ctx.answerCbQuery('Сначала /start');
    return;
  }

  if (data === 'settings:dm:toggle') {
    const next = student.notify_dm ? 0 : 1;
    db.prepare('UPDATE students SET notify_dm = ?, updated_at = datetime(\'now\') WHERE id = ?').run(next, student.id);
    student.notify_dm = next;
    await ctx.answerCbQuery(next ? 'Личные уведомления включены' : 'Личные уведомления выключены');
  } else if (data === 'settings:quiet:cycle') {
    if (student.notify_quiet_hours_start && student.notify_quiet_hours_end) {
      // Выключаем тихие часы
      db.prepare(
        'UPDATE students SET notify_quiet_hours_start = NULL, notify_quiet_hours_end = NULL, updated_at = datetime(\'now\') WHERE id = ?'
      ).run(student.id);
      student.notify_quiet_hours_start = null;
      student.notify_quiet_hours_end = null;
      await ctx.answerCbQuery('Тихие часы выключены');
    } else {
      // Включаем дефолтные тихие часы 22:00–08:00 по Москве
      db.prepare(
        'UPDATE students SET notify_quiet_hours_start = ?, notify_quiet_hours_end = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).run('22:00', '08:00', student.id);
      student.notify_quiet_hours_start = '22:00';
      student.notify_quiet_hours_end = '08:00';
      await ctx.answerCbQuery('Тихие часы: 22:00–08:00');
    }
  } else {
    return;
  }

  const dmLabel = student.notify_dm ? 'ЛС: ✅ включены' : 'ЛС: ❌ выключены';
  const quietLabel =
    student.notify_quiet_hours_start && student.notify_quiet_hours_end
      ? `Тихие часы: ${student.notify_quiet_hours_start}–${student.notify_quiet_hours_end}`
      : 'Тихие часы: выкл';

  await ctx.editMessageReplyMarkup({
    inline_keyboard: [
      [Markup.button.callback(dmLabel, 'settings:dm:toggle')],
      [Markup.button.callback(quietLabel, 'settings:quiet:cycle')],
    ],
  }).catch(() => {});
}

/** Планер: выбор количества задач (1–6) или пропуск дня через inline-кнопки. */
export async function handlePlannerCount(ctx: Context): Promise<void> {
  try {
    const cb = ctx.callbackQuery;
    if (!cb || !('data' in cb) || !ctx.from) return;
    const data = cb.data as string;
    if (!data.startsWith('planner_count_') && data !== 'planner_skip_day') return;

    const db = getDb();
    const studentId = await getOrCreateStudentId(ctx);
    if (!studentId) {
      await ctx.answerCbQuery('Сначала нажмите /start');
      return;
    }
    const taskDate = plannerToday();

    if (data === 'planner_skip_day') {
      db.prepare(
        `INSERT INTO planner_sessions (student_id, task_date, total_tasks, next_index, status)
         VALUES (?, ?, 0, 0, 'done')
         ON CONFLICT(student_id, task_date) DO UPDATE SET total_tasks = 0, next_index = 0, status = 'done'`
      ).run(studentId, taskDate);
      const mandatory = await selectPendingExamSubmissionsForStudent({
        studentId,
        screenDateIso: taskDate,
        maxLessons: 2,
        maxHomeworks: 2,
        markPromptedAt: false,
      }).catch(() => ({ selected: [], totalLessons: 0, totalHomeworks: 0, totalPending: 0 }));
      await ctx.answerCbQuery('Сегодня без задач.').catch(() => {});
      await deleteCallbackMessage(ctx);
      await ctx.reply(
        `Хорошо, сегодня без планерных задач.\n` +
          `Обязательные exams остаются: ${mandatory.totalPending} (Урок: ${mandatory.totalLessons}, ДЗ: ${mandatory.totalHomeworks}).\n` +
          `Их можно отмечать на экране "Выполнено" с отправкой evidence админу.`
      );
      return;
    }

    const countStr = data.replace('planner_count_', '');
    const count = parseInt(countStr, 10);
    if (Number.isNaN(count) || count < 1 || count > PLANNER_MAX_TASKS) {
      await ctx.answerCbQuery('Неверное количество задач.').catch(() => {});
      return;
    }

    db.prepare(
      `INSERT INTO planner_sessions (student_id, task_date, total_tasks, next_index, status)
       VALUES (?, ?, ?, 1, 'collecting')
       ON CONFLICT(student_id, task_date) DO UPDATE SET total_tasks = excluded.total_tasks, next_index = 1, status = 'collecting'`
    ).run(studentId, taskDate, count);
    // Если пользователь уменьшил число задач (было 5, выбрал 3) — удаляем лишние записи за этот день
    db.prepare(
      `DELETE FROM daily_tasks WHERE student_id = ? AND task_date = ? AND idx > ?`
    ).run(studentId, taskDate, count);

    await ctx.answerCbQuery(`Планируем ${count} задач(и).`).catch(() => {});
    await deleteCallbackMessage(ctx);
    const mandatory = await selectPendingExamSubmissionsForStudent({
      studentId,
      screenDateIso: taskDate,
      maxLessons: 2,
      maxHomeworks: 2,
      markPromptedAt: false,
    }).catch(() => ({ selected: [], totalLessons: 0, totalHomeworks: 0, totalPending: 0 }));
    await ctx.reply(
      `Итого на день: ${count} планерных + ${mandatory.totalPending} обязательных exams = ${count + mandatory.totalPending} задач(и).\n\n` +
        'Задача 1?\n\nНапиши её своими словами. Если задач окажется меньше — в любой момент можешь написать /skip, чтобы закончить ввод.'
    );
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (msg.includes('query is too old') || msg.includes('query ID is invalid')) {
      // Старый callback от Telegram, просто игнорируем.
      return;
    }
    console.error('[Planner] handlePlannerCount error:', e);
  }
}

/** Планер: справка по тому, как он работает + показ текущих планов, если они уже есть. */
export async function handlePlannerInfo(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Про планер рассказываю только в личке, напишите мне /planner в ЛС.');
    return;
  }

  if (!ctx.from) return;
  console.log(
    '[Planner] /planner called',
    `telegram_user_id=${ctx.from.id}`,
    `username=@${ctx.from.username ?? ''}`
  );
  const db = getDb();
  const student = db
    .prepare('SELECT id FROM students WHERE telegram_user_id = ?')
    .get(ctx.from.id) as { id: number } | undefined;

  const today = plannerToday();
  let todayTasks: Array<{ idx: number; text: string; status: string }> = [];

  if (student) {
    todayTasks = db
      .prepare(
        `SELECT idx, text, status
         FROM daily_tasks
         WHERE student_id = ? AND task_date = ?
         ORDER BY idx`
      )
      .all(student.id, today) as Array<{ idx: number; text: string; status: string }>;
  }

  if (todayTasks.length > 0) {
    const statusLabel = (s: string): string => {
      if (s === 'completed') return '✅';
      if (s === 'partly_done') return '🟡';
      if (s === 'cancelled') return '❌';
      return '✏️';
    };

    console.log(
      '[Planner] /planner show today tasks',
      `telegram_user_id=${ctx.from.id}`,
      `tasks=${todayTasks.length}`
    );

    const lines = [
      `Твои планы на сегодня (${today}):`,
      '',
      ...todayTasks.map((t) => `${t.idx}. ${t.text} ${statusLabel(t.status)}`),
      '',
      'Можно изменить планы на сегодня или продолжить пользоваться планером как обычно.',
    ];

    await ctx.reply(lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            Markup.button.callback('Изменить планы', 'planner_start_today'),
            Markup.button.callback('Отметить выполнение', 'planner_done_summary'),
          ],
        ],
      },
    });
    return;
  }

  console.log(
    '[Planner] /planner no tasks for today',
    `telegram_user_id=${ctx.from.id}`
  );
  await ctx.reply(
    [
      'Планер учебных задач:',
      '',
      '— В 10:00 я предложу запланировать до 6 задач на день.',
      '— Выберите количество задач, потом по очереди напишите текст каждой задачи.',
      '— Если задач меньше, чем выбрали, можно в любой момент написать /skip, чтобы закончить ввод.',
      '— В 20:00 я пришлю задачи и попрошу отметить статус: выполнена, частично или отменена.',
      '',
      'Если уведомления в ЛС выключены или бот заблокирован, планер работать не будет.',
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('Запланировать задачи на сегодня', 'planner_start_today')],
        ],
      },
    }
  );
}

/** Планер: экран «Выполнено» — отметка выполненных / частично выполненных задач и возврат к списку. */
export async function handlePlannerDoneSummary(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  if (cb.data !== 'planner_done_summary') return;

  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер работает только в личке.');
    return;
  }

  const db = getDb();
  const student = db
    .prepare('SELECT id FROM students WHERE telegram_user_id = ?')
    .get(ctx.from.id) as { id: number } | undefined;
  if (!student) {
    await safeAnswerCbQuery(ctx);
    await safeReply(ctx, 'Сначала нажмите /start, чтобы я вас зарегистрировал.');
    return;
  }

  const today = plannerToday();
  const payload = await buildPlannerDoneSummaryPayload(student.id, today);
  await safeAnswerCbQuery(ctx);
  await deleteCallbackMessage(ctx);
  await safeReply(ctx, payload.text, {
    reply_markup: {
      inline_keyboard: payload.inline_keyboard,
    },
  });
}

/** Планер: обязательные "exams" — студент нажал "Отправить фото" */
export async function handlePlannerExamUpload(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  if (!cb.data.startsWith('planner_exam_upload_')) return;

  const submissionId = parseInt(cb.data.replace('planner_exam_upload_', ''), 10);
  if (!Number.isFinite(submissionId)) {
    await safeAnswerCbQuery(ctx, 'Ошибка данных.');
    return;
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT pes.id
       FROM planner_exam_submissions pes
       JOIN students s ON s.id = pes.student_id
       WHERE pes.id = ? AND s.telegram_user_id = ?`
    )
    .get(submissionId, ctx.from.id) as { id: number } | undefined;

  if (!row) {
    await safeAnswerCbQuery(ctx, 'Эта запись не принадлежит вам.');
    return;
  }

  plannerExamAwaitingPhoto.set(ctx.from.id, { submissionId });
  await safeAnswerCbQuery(ctx);
  await deleteCallbackMessage(ctx);
  await safeReply(
    ctx,
    'Отправь фото или скрин с доказательством. Лучше сразу укажи дату выполнения в подписи к снимку (например `07 03` или `7 марта`). Если без даты в подписи — после фото отправь дату одним сообщением в том же формате.'
  );
}

/** Сохранить дату и разослать админам на модерацию (общий путь: подпись к фото или текст DD MM). */
async function finalizeExamSubmissionToAdmins(ctx: Context, submissionId: number, iso: string): Promise<void> {
  setExamCompletionDate(submissionId, iso);
  plannerExamAwaitingCompletionDate.delete(ctx.from!.id);
  plannerExamAwaitingPhoto.delete(ctx.from!.id);

  const moderation = getSubmissionForModeration(submissionId);
  if (!moderation) {
    await safeReply(ctx, 'Ошибка: запись не найдена.');
    return;
  }

  const { submission, student } = moderation;
  const evidenceFileId = submission.evidence_file_id;
  if (!evidenceFileId) {
    await safeReply(ctx, 'Ошибка: доказательство не найдено. Попробуй начать заново.');
    return;
  }

  const subjectLabel = submission.subject_key ? (SUBJECT_TOPIC_NAMES[submission.subject_key] ?? submission.subject_key) : '(предмет не определён)';
  const itemTitle = `${subjectLabel} ${submission.kind === 'lesson' ? 'Урок' : 'ДЗ'} ${new Date(`${submission.lesson_date}T00:00:00.000Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
  const studentName = `${student.last_name ?? ''} ${student.first_name ?? ''}`.trim();

  const adminCaption = [
    `Модерация: ${itemTitle}`,
    `ФИО: ${studentName}${student.telegram_username ? ` (@${student.telegram_username})` : ''}`,
    `Дата выполнения: ${submission.completion_date ?? iso}`,
    `Статус: ${submission.status}`,
  ]
    .filter(Boolean)
    .join('\n');

  const db = getDb();
  const admins = db.prepare('SELECT telegram_user_id FROM admins').all() as Array<{ telegram_user_id: number }>;
  if (!admins.length) {
    await safeReply(ctx, 'Нет админов для модерации. Сообщи администратору о проблеме.');
    const todayNoAdmin = plannerToday();
    const summaryNoAdmin = await buildPlannerDoneSummaryPayload(submission.student_id, todayNoAdmin, { markPromptedAt: false });
    await safeReply(ctx, summaryNoAdmin.text, {
      reply_markup: { inline_keyboard: summaryNoAdmin.inline_keyboard },
    });
    return;
  }

  const replyMarkup = {
    inline_keyboard: [
      [
        Markup.button.callback('✅ Подтвердить', `planner_exam_admin_confirm_${submissionId}`),
        Markup.button.callback('❌ Отклонить', `planner_exam_admin_reject_${submissionId}`),
      ],
    ],
  };

  for (const a of admins) {
    try {
      await ctx.telegram.sendPhoto(a.telegram_user_id, evidenceFileId, { caption: adminCaption, reply_markup: replyMarkup as any });
    } catch (e) {
      console.error('[Planner] sendPhoto to admin failed', a.telegram_user_id, e);
    }
  }

  const today = plannerToday();
  const summary = await buildPlannerDoneSummaryPayload(submission.student_id, today, { markPromptedAt: false });
  const text = `✅ Фото и дата отправлены на модерацию админам.\n\n${summary.text}`;
  await safeReply(ctx, text, {
    reply_markup: {
      inline_keyboard: summary.inline_keyboard,
    },
  });
}

/** Планер: обязательные "exams" — принимаем фото */
export async function handlePlannerExamPhoto(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private' || !ctx.from) return;
  const st = plannerExamAwaitingPhoto.get(ctx.from.id);
  if (!st) return;
  if (!ctx.message || !('photo' in ctx.message)) return;

  const photos = (ctx.message as any).photo;
  if (!Array.isArray(photos) || photos.length === 0) return;

  const best = photos[photos.length - 1] as { file_id?: string };
  const fileId = best?.file_id;
  if (!fileId) return;

  const messageId = (ctx.message as any).message_id as number | undefined;
  if (typeof messageId !== 'number') return;

  const caption = (ctx.message as any).caption as string | null | undefined;

  upsertExamEvidence(st.submissionId, { fileId, messageId, caption });

  plannerExamAwaitingPhoto.delete(ctx.from.id);

  const ref = new Date();
  const isoFromCaption = parseRuDateFromCaption(caption, ref);
  if (isoFromCaption) {
    await finalizeExamSubmissionToAdmins(ctx, st.submissionId, isoFromCaption);
    return;
  }

  plannerExamAwaitingCompletionDate.set(ctx.from.id, { submissionId: st.submissionId });
  await safeReply(
    ctx,
    'Фото сохранено без даты в подписи. Укажи дату в подписи к новому фото или одним сообщением сюда (например `07 03` или `7 марта`).'
  );
}

/** Планер: обязательные "exams" — принимаем дату выполнения (DD MM), если не было в подписи */
export async function handlePlannerExamCompletionDateText(ctx: Context, next: () => Promise<void>): Promise<void> {
  if (ctx.chat?.type !== 'private' || !ctx.from) return next();
  if (!('text' in (ctx.message || {}))) return next();

  const st = plannerExamAwaitingCompletionDate.get(ctx.from.id);
  if (!st) return next();

  const input = (ctx.message as any).text as string;
  const iso = parseRuDdMmToIso(input, new Date());
  if (!iso) {
    await safeReply(ctx, 'Не понял дату. Пример: `07 марта`, `07 03` или подпись к фото с такой датой.');
    return;
  }

  await finalizeExamSubmissionToAdmins(ctx, st.submissionId, iso);
}

/** Админ: подтвердить обязательное "exams" */
export async function handlePlannerExamAdminConfirm(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  if (!cb.data.startsWith('planner_exam_admin_confirm_')) return;
  if (!isAdmin(ctx.from.id)) {
    await safeAnswerCbQuery(ctx, 'Команда только для администраторов.');
    return;
  }

  const submissionId = parseInt(cb.data.replace('planner_exam_admin_confirm_', ''), 10);
  if (!Number.isFinite(submissionId)) {
    await safeAnswerCbQuery(ctx, 'Ошибка данных.');
    return;
  }

  confirmExamSubmission(submissionId, ctx.from.id);
  const moderation = getSubmissionForModeration(submissionId);

  await safeAnswerCbQuery(ctx, 'Подтверждено.');

  if (moderation) {
    const { submission, student } = moderation;
    const subjectLabel = submission.subject_key ? (SUBJECT_TOPIC_NAMES[submission.subject_key] ?? submission.subject_key) : '(предмет)';
    const itemTitle = `${subjectLabel} ${submission.kind === 'lesson' ? 'Урок' : 'ДЗ'} ${new Date(`${submission.lesson_date}T00:00:00.000Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
    await ctx.telegram.sendMessage(
      student.telegram_user_id,
      `✅ Подтверждено: ${itemTitle}\n` +
        `Последнее подтвержденное: ${submission.last_confirmed_completion_date ?? submission.completion_date ?? ''}`
    );
  }
}

/** Админ: отклонить обязательное "exams" */
export async function handlePlannerExamAdminReject(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  if (!cb.data.startsWith('planner_exam_admin_reject_')) return;
  if (!isAdmin(ctx.from.id)) {
    await safeAnswerCbQuery(ctx, 'Команда только для администраторов.');
    return;
  }

  const submissionId = parseInt(cb.data.replace('planner_exam_admin_reject_', ''), 10);
  if (!Number.isFinite(submissionId)) {
    await safeAnswerCbQuery(ctx, 'Ошибка данных.');
    return;
  }

  rejectExamSubmission(submissionId, ctx.from.id);
  const moderation = getSubmissionForModeration(submissionId);

  await safeAnswerCbQuery(ctx, 'Отклонено.');

  if (moderation) {
    const { submission, student } = moderation;
    const subjectLabel = submission.subject_key ? (SUBJECT_TOPIC_NAMES[submission.subject_key] ?? submission.subject_key) : '(предмет)';
    const itemTitle = `${subjectLabel} ${submission.kind === 'lesson' ? 'Урок' : 'ДЗ'} ${new Date(`${submission.lesson_date}T00:00:00.000Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
    await ctx.telegram.sendMessage(
      student.telegram_user_id,
      `❌ Отклонено: ${itemTitle}\n` +
        `Можно отправить фото и дату заново на экране "Выполнено".`
    );
  }
}

/** Планер: установка статуса задачи на «выполнено», «частично» или «отменено» из экрана «Выполнено». */
export async function handlePlannerDoneToggle(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (
    !data.startsWith('planner_done_set_completed_') &&
    !data.startsWith('planner_done_set_partly_') &&
    !data.startsWith('planner_done_set_cancelled_')
  ) return;

  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер работает только в личке.');
    return;
  }

  const taskId = parseInt(
    data
      .replace('planner_done_set_completed_', '')
      .replace('planner_done_set_partly_', '')
      .replace('planner_done_set_cancelled_', ''),
    10
  );
  if (Number.isNaN(taskId)) {
    await safeAnswerCbQuery(ctx, 'Ошибка данных.');
    return;
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT dt.id, dt.student_id, dt.task_date, dt.idx, dt.text, dt.status, s.telegram_user_id
       FROM daily_tasks dt
       JOIN students s ON s.id = dt.student_id
       WHERE dt.id = ?`
    )
    .get(taskId) as
    | {
        id: number;
        student_id: number;
        task_date: string;
        idx: number;
        text: string;
        status: string;
        telegram_user_id: number;
      }
    | undefined;

  if (!row || row.telegram_user_id !== ctx.from.id) {
    await safeAnswerCbQuery(ctx, 'Эта задача принадлежит другому пользователю.');
    return;
  }

  // Устанавливаем статус в зависимости от нажатой кнопки.
  let nextStatus = row.status;
  if (data.startsWith('planner_done_set_completed_')) {
    nextStatus = 'completed';
  } else if (data.startsWith('planner_done_set_partly_')) {
    nextStatus = 'partly_done';
  } else if (data.startsWith('planner_done_set_cancelled_')) {
    nextStatus = 'cancelled';
  }

  if (nextStatus !== row.status) {
    db.prepare('UPDATE daily_tasks SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
      nextStatus,
      row.id
    );
  }

  // Перерисовываем экран «Выполнено» с актуальными статусами.
  const payload = await buildPlannerDoneSummaryPayload(row.student_id, row.task_date, { markPromptedAt: true });

  await safeEditMessageText(ctx, payload.text, {
    reply_markup: {
      inline_keyboard: payload.inline_keyboard,
    },
  });
  await safeAnswerCbQuery(ctx, 'Статус обновлён.');
}

/** Планер: возврат к списку задач (экран из /planner). */
export async function handlePlannerBackToTasks(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  if (cb.data !== 'planner_back_to_tasks') return;

  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер работает только в личке.');
    return;
  }

  const db = getDb();
  const student = db
    .prepare('SELECT id FROM students WHERE telegram_user_id = ?')
    .get(ctx.from.id) as { id: number } | undefined;
  if (!student) {
    await safeAnswerCbQuery(ctx);
    await safeReply(ctx, 'Сначала нажмите /start, чтобы я вас зарегистрировал.');
    return;
  }

  const today = plannerToday();
  const tasks = db
    .prepare(
      `SELECT idx, text, status
       FROM daily_tasks
       WHERE student_id = ? AND task_date = ?
       ORDER BY idx`
    )
    .all(student.id, today) as Array<{ idx: number; text: string; status: string }>;

  if (!tasks.length) {
    await safeAnswerCbQuery(ctx, 'На сегодня задач нет.');
    return;
  }

  const statusLabel = (s: string): string => {
    if (s === 'completed') return '✅';
    if (s === 'partly_done') return '🟡';
    if (s === 'cancelled') return '❌';
    return '✏️';
  };

  const lines = [
    `Твои планы на сегодня (${today}):`,
    '',
    ...tasks.map((t) => `${t.idx}. ${t.text} ${statusLabel(t.status)}`),
    '',
    'Можно изменить планы на сегодня или продолжить пользоваться планером как обычно.',
  ];

  const keyboard = [
    [
      Markup.button.callback('Изменить планы', 'planner_start_today'),
      Markup.button.callback('Отметить выполнение', 'planner_done_summary'),
    ],
  ];

  await safeAnswerCbQuery(ctx);
  await deleteCallbackMessage(ctx);
  await safeReply(ctx, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

/** Планер: ручной запуск планирования на сегодня из ЛС. Если уже есть задачи — показываем экран «что изменить»; иначе — выбор количества. */
export async function handlePlannerStartToday(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  if (cb.data !== 'planner_start_today') return;

  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер работает только в личке.');
    return;
  }

  const db = getDb();
  const studentId = await getOrCreateStudentId(ctx);
  if (!studentId) {
    await safeAnswerCbQuery(ctx);
    await safeReply(ctx, 'Сначала нажмите /start, чтобы я вас зарегистрировал.');
    return;
  }

  db.prepare('UPDATE students SET planner_enabled = 1 WHERE id = ?').run(studentId);

  const taskDate = plannerToday();
  const editList = buildPlannerEditListContent(db, studentId, taskDate);
  const mandatoryPreview = await buildMandatoryExamsPreview(studentId, taskDate);

  await safeAnswerCbQuery(ctx, 'Обновляю планы на сегодня…');
  await deleteCallbackMessage(ctx);

  if (editList) {
    if (mandatoryPreview.length) {
      await safeReply(ctx, mandatoryPreview.join('\n'));
    }
    await safeReply(ctx, editList.text, { reply_markup: { inline_keyboard: editList.inline_keyboard } });
    return;
  }

  await safeReply(
    ctx,
    [
      'Давай спланируем задачи на сегодня.',
      '',
      ...mandatoryPreview,
      ...(mandatoryPreview.length ? ['', 'Твоя часть планирования: выбери количество планерных задач (1–6).'] : ['Выбери количество планерных задач (1–6).']),
      'Если задач окажется меньше — всегда можно написать /skip, чтобы закончить ввод. Если бот вдруг подвис — просто набери /planner, я покажу актуальные задачи.',
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [
            Markup.button.callback('1', 'planner_count_1'),
            Markup.button.callback('2', 'planner_count_2'),
            Markup.button.callback('3', 'planner_count_3'),
          ],
          [
            Markup.button.callback('4', 'planner_count_4'),
            Markup.button.callback('5', 'planner_count_5'),
            Markup.button.callback('6', 'planner_count_6'),
          ],
          [Markup.button.callback('Сегодня без задач', 'planner_skip_day')],
        ],
      },
    }
  );
}

/** Планер: «Изменить» задачу — просим прислать новый текст, сохраняем в состояние. */
export async function handlePlannerEditTask(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (!data.startsWith('planner_edit_')) return;
  const taskId = parseInt(data.replace('planner_edit_', ''), 10);
  if (Number.isNaN(taskId)) return;
  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер только в личке.');
    return;
  }
  const db = getDb();
  const studentId = await getOrCreateStudentId(ctx);
  if (!studentId) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const task = db
    .prepare(
      `SELECT id, idx, text, student_id FROM daily_tasks WHERE id = ? AND student_id = ?`
    )
    .get(taskId, studentId) as { id: number; idx: number; text: string; student_id: number } | undefined;
  if (!task) {
    await safeAnswerCbQuery(ctx, 'Задача не найдена.');
    return;
  }
  plannerEditingTask.set(ctx.from.id, { taskId: task.id, studentId, taskDate: plannerToday() });
  await safeAnswerCbQuery(ctx, 'Жду новый текст задачи…');
  await deleteCallbackMessage(ctx);
  await safeReply(
    ctx,
    `Напиши новый текст для задачи ${task.idx}.\n\nСейчас: «${task.text}»\n\nИли отправь /cancel, чтобы оставить как есть. Если бот подвис — набери /planner, и я покажу актуальный список задач.`
  );
}

/** Планер: «Удалить» задачу — удаляем из БД и показываем обновлённый список или главный экран. */
export async function handlePlannerDeleteTask(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (!data.startsWith('planner_del_')) return;
  const taskId = parseInt(data.replace('planner_del_', ''), 10);
  if (Number.isNaN(taskId)) return;
  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер только в личке.');
    return;
  }
  const db = getDb();
  const studentId = await getOrCreateStudentId(ctx);
  if (!studentId) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const task = db.prepare('SELECT id, student_id FROM daily_tasks WHERE id = ? AND student_id = ?').get(taskId, studentId);
  if (!task) {
    await safeAnswerCbQuery(ctx, 'Задача не найдена.');
    return;
  }
  const taskDate = plannerToday();
  db.prepare('DELETE FROM daily_tasks WHERE id = ?').run(taskId);
  await safeAnswerCbQuery(ctx, 'Задача удалена.');
  await deleteCallbackMessage(ctx);
  const editList = buildPlannerEditListContent(db, studentId, taskDate);
  if (editList) {
    await safeReply(ctx, editList.text, { reply_markup: { inline_keyboard: editList.inline_keyboard } });
  } else {
    await safeReply(ctx, 'Задач на сегодня не осталось. Можешь запланировать новые:', {
      reply_markup: {
        inline_keyboard: [[Markup.button.callback('Запланировать задачи на сегодня', 'planner_start_today')]],
      },
    });
  }
}

/** Планер: «Добавить задачу» — включаем режим ввода одной новой задачи (до 6 всего). */
export async function handlePlannerAddTask(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || cb.data !== 'planner_add_task' || !ctx.from) return;
  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер только в личке.');
    return;
  }
  const db = getDb();
  const studentId = await getOrCreateStudentId(ctx);
  if (!studentId) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  const taskDate = plannerToday();
  const count = db
    .prepare('SELECT COUNT(*) as c FROM daily_tasks WHERE student_id = ? AND task_date = ?')
    .get(studentId, taskDate) as { c: number };
  if (count.c >= PLANNER_MAX_TASKS) {
    await safeAnswerCbQuery(ctx, `Максимум ${PLANNER_MAX_TASKS} задач.`);
    return;
  }
  plannerAddingTask.set(ctx.from.id, { studentId, taskDate });
  await safeAnswerCbQuery(ctx, 'Жду текст новой задачи…');
  await deleteCallbackMessage(ctx);
  await safeReply(ctx, 'Напиши текст новой задачи. Или /cancel, чтобы отменить. Если бот подвис — набери /planner, и я покажу актуальный список задач.');
}

/** Планер: «Готово» — удаляем окно редактирования и отправляем новое сообщение «Твои планы на сегодня». */
export async function handlePlannerEditDone(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || cb.data !== 'planner_edit_done' || !ctx.from) return;
  if (ctx.chat?.type !== 'private') {
    await safeAnswerCbQuery(ctx, 'Планер только в личке.');
    return;
  }
  plannerEditingTask.delete(ctx.from.id);
  plannerAddingTask.delete(ctx.from.id);
  const db = getDb();
  const studentId = await getOrCreateStudentId(ctx);
  if (!studentId) {
    await safeAnswerCbQuery(ctx);
    return;
  }
  await safeAnswerCbQuery(ctx);
  await deleteCallbackMessage(ctx);
  const today = plannerToday();
  const todayTasks = db
    .prepare(
      `SELECT idx, text, status FROM daily_tasks WHERE student_id = ? AND task_date = ? ORDER BY idx`
    )
    .all(studentId, today) as Array<{ idx: number; text: string; status: string }>;
  if (todayTasks.length === 0) {
    await safeReply(ctx, 'Задач на сегодня нет. Можешь запланировать:', {
      reply_markup: {
        inline_keyboard: [[Markup.button.callback('Запланировать задачи на сегодня', 'planner_start_today')]],
      },
    });
    return;
  }
  const statusLabel = (s: string): string => {
    if (s === 'completed') return '✅';
    if (s === 'partly_done') return '🟡';
    if (s === 'cancelled') return '❌';
    return '✏️';
  };
  const lines = [
    `Твои планы на сегодня (${today}):`,
    '',
    ...todayTasks.map((t) => `${t.idx}. ${t.text} ${statusLabel(t.status)}`),
    '',
    'Можно изменить планы на сегодня или продолжить пользоваться планером как обычно. Если бот подвисал — это актуальная версия задач.',
  ];
  await safeReply(ctx, lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [
          Markup.button.callback('Изменить планы', 'planner_start_today'),
          Markup.button.callback('Отметить выполнение', 'planner_done_summary'),
        ],
      ],
    },
  });
}

/** Админ: повторно вызвать планирование на дату для тех, кто ещё не внёс планы. */
export async function handlePlannerRemind(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/planner_remind\s+(\d{4}-\d{2}-\d{2})/.exec(text || '');
  const dateArg = match?.[1];
  const taskDate = dateArg || plannerToday();

  const { date, count } = runPlannerMorningRemind(taskDate);
  if (count === 0) {
    await ctx.reply(`Никого не нашёл без планов на ${date}. Возможно, все уже заполнили задачи.`);
  } else {
    await ctx.reply(`Отправил приглашение планера на ${date} всем студентам без планов (${count} чел.).`);
  }
}

/** Админ: вручную запустить вечерний опрос (экран «Отметь выполненные задачи на сегодня») за дату. */
export async function handlePlannerEveningNow(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/planner_evening_now\s+(\d{4}-\d{2}-\d{2})/.exec(text || '');
  const taskDate = match?.[1] || plannerToday();
  await ctx.reply(`Запускаю вечерний опрос (экран «Выполнено») за дату ${taskDate}...`);
  try {
    runPlannerEveningJobForDate(taskDate);
    await ctx.reply(`Вечерний опрос за ${taskDate} поставлен в очередь отправки.`);
  } catch (e) {
    console.error('[Planner] /planner_evening_now error:', e);
    await ctx.reply(`Ошибка при запуске вечернего опроса за ${taskDate}. Подробности в логах бота.`);
  }
}

/** Админ: принудительный полный экспорт планера за дату в таблицу. */
export async function handlePlannerExportNow(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/planner_export_now\s+(\d{4}-\d{2}-\d{2})/.exec(text || '');
  const taskDate = match?.[1] || plannerToday();
  await ctx.reply(`Запускаю полный экспорт планера за дату ${taskDate} в таблицу...`);
  try {
    await runPlannerFullExportJobForDate(taskDate);
    await ctx.reply(`Полный экспорт планера за ${taskDate} завершён (см. лог бота и таблицу).`);
  } catch (e) {
    console.error('[Planner] /planner_export_now error:', e);
    await ctx.reply(`Ошибка при полном экспорте планера за ${taskDate}. Подробности в логах бота.`);
  }
}

/** Админ: обзор событий на ближайшие 24 часа. */
export async function handlePlannerUpcoming(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const db = getDb();
  const nowIso = new Date().toISOString();
  const endIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, title, description, start_at
       FROM calendar_events
       WHERE status = 'active' AND start_at >= ? AND start_at <= ?
       ORDER BY start_at`
    )
    .all(nowIso, endIso) as Array<{ id: number; title: string; description: string | null; start_at: string }>;

  if (!rows.length) {
    await ctx.reply('В ближайшие 24 часа нет активных событий.');
    return;
  }

  const DISPLAY_TZ_LOCAL = EVENTS_DISPLAY_TZ || 'Europe/Moscow';
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('ru-RU', {
      timeZone: DISPLAY_TZ_LOCAL,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const lines: string[] = [];
  lines.push('План событий на ближайшие 24 часа:', '');
  for (const ev of rows) {
    const subjectRows = db
      .prepare('SELECT subject_key FROM event_subjects WHERE event_id = ?')
      .all(ev.id) as Array<{ subject_key: string }>;
    const subjectKeys = subjectRows.map((r) => r.subject_key);
    const subjectLabels = subjectKeys.length
      ? subjectKeys.map((s) => SUBJECT_TOPIC_NAMES[s] || s).join(', ')
      : '(не рассылается)';
    lines.push(
      `• [#${ev.id}] ${fmt(ev.start_at)} — ${ev.title || 'Без названия'} (предметы: ${subjectLabels})`
    );
  }

  const text = lines.join('\n');
  if (text.length <= 4000) {
    await ctx.reply(text);
  } else {
    // На всякий случай: если список очень длинный, режем на две части.
    const mid = Math.floor(lines.length / 2);
    const part1 = lines.slice(0, mid).join('\n');
    const part2 = lines.slice(mid).join('\n');
    await ctx.reply(part1);
    await ctx.reply(part2);
  }
}

/** Планер: обработка текстовых ответов в ЛС (создание задач, /skip, редактирование/добавление из экрана «Изменить планы»). */
export async function handlePlannerText(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private' || !ctx.from) return;
  if (!('text' in (ctx.message || {}))) return;
  const text = (ctx.message as { text: string }).text.trim();

  const db = getDb();
  const studentId = await getOrCreateStudentId(ctx);
  if (!studentId) return;

  const awaitingFio = startAwaitingFio.get(ctx.from.id);
  if (awaitingFio) {
    if (text === '/cancel') {
      startAwaitingFio.delete(ctx.from.id);
      await ctx.reply('Ок, отменил ввод ФИО. Нажмите /planner, когда будете готовы.');
      return;
    }
    if (text.startsWith('/')) return;

    const fio = text.replace(/\s+/g, ' ').trim();
    const parts = fio.split(' ');
    if (parts.length < 2) {
      await ctx.reply('Пожалуйста, отправьте ФИО в формате: `Фамилия Имя` (минимум два слова).');
      return;
    }
    const lastName = parts[0] ?? '';
    const firstName = parts.slice(1).join(' ').trim();
    const hasLetters = /[A-Za-zА-Яа-яЁё]/.test(fio);
    if (!hasLetters) {
      await ctx.reply('Похоже, это не ФИО. Пример: `Иванов Иван`.');
      return;
    }
    if (!lastName || !firstName) {
      await ctx.reply('Не удалось распознать ФИО. Пример: `Иванов Иван`.');
      return;
    }

    db.prepare(
      `UPDATE students
       SET first_name = ?, last_name = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(firstName, lastName, awaitingFio.studentId);
    startAwaitingFio.delete(ctx.from.id);
    await ctx.reply(
      'ФИО сохранено. Спасибо!'
    );
    return;
  }

  // Режим «редактирую текст задачи»: обновляем задачу или /cancel
  const editing = plannerEditingTask.get(ctx.from.id);
  if (editing) {
    if (text === '/cancel') {
      plannerEditingTask.delete(ctx.from.id);
      const editList = buildPlannerEditListContent(db, editing.studentId, editing.taskDate);
      if (editList) {
        await ctx.reply(editList.text, { reply_markup: { inline_keyboard: editList.inline_keyboard } });
      } else {
        await ctx.reply('Задач на сегодня не осталось. Нажми /planner.');
      }
      return;
    }
    db.prepare(
      `UPDATE daily_tasks SET text = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(text, editing.taskId);
    plannerEditingTask.delete(ctx.from.id);
    const editList = buildPlannerEditListContent(db, editing.studentId, editing.taskDate);
    if (editList) {
      await ctx.reply('Текст задачи обновлён.\n\n' + editList.text, { reply_markup: { inline_keyboard: editList.inline_keyboard } });
    } else {
      await ctx.reply('Текст задачи обновлён. Задач на сегодня больше не осталось. Нажми /planner.');
    }
    return;
  }

  // Режим «добавляю новую задачу»: вставляем задачу или /cancel
  const adding = plannerAddingTask.get(ctx.from.id);
  if (adding) {
    if (text === '/cancel') {
      plannerAddingTask.delete(ctx.from.id);
      const editList = buildPlannerEditListContent(db, adding.studentId, adding.taskDate);
      if (editList) {
        await ctx.reply(editList.text, { reply_markup: { inline_keyboard: editList.inline_keyboard } });
      } else {
        await ctx.reply('Нажми /planner.');
      }
      return;
    }
    const count = db
      .prepare('SELECT COUNT(*) as c FROM daily_tasks WHERE student_id = ? AND task_date = ?')
      .get(adding.studentId, adding.taskDate) as { c: number };
    if (count.c >= PLANNER_MAX_TASKS) {
      await ctx.reply(`Максимум ${PLANNER_MAX_TASKS} задач. Нажми «Готово» в списке задач.`);
      return;
    }
    const maxIdx = db
      .prepare('SELECT COALESCE(MAX(idx), 0) as m FROM daily_tasks WHERE student_id = ? AND task_date = ?')
      .get(adding.studentId, adding.taskDate) as { m: number };
    const nextIdx = maxIdx.m + 1;
    db.prepare(
      `INSERT INTO daily_tasks (student_id, task_date, idx, text, status) VALUES (?, ?, ?, ?, 'planned')`
    ).run(adding.studentId, adding.taskDate, nextIdx, text);
    plannerAddingTask.delete(ctx.from.id);
    const editList = buildPlannerEditListContent(db, adding.studentId, adding.taskDate);
    if (editList) {
      await ctx.reply('Задача добавлена.\n\n' + editList.text, { reply_markup: { inline_keyboard: editList.inline_keyboard } });
    } else {
      await ctx.reply('Задача добавлена. Нажми /planner.');
    }
    return;
  }

  // Команды (кроме /skip) не перехватываем.
  if (text.startsWith('/') && text !== '/skip') return;

  const taskDate = plannerToday();
  const session = db
    .prepare(
      `SELECT student_id, task_date, total_tasks, next_index, status
       FROM planner_sessions
       WHERE student_id = ? AND task_date = ?`
    )
    .get(studentId, taskDate) as
    | { student_id: number; task_date: string; total_tasks: number; next_index: number; status: string }
    | undefined;

  if (!session || session.status !== 'collecting') return;

  const idx = session.next_index;
  if (text === '/skip') {
    db.prepare(
      `UPDATE planner_sessions
       SET status = 'done'
       WHERE student_id = ? AND task_date = ?`
    ).run(studentId, taskDate);
    await ctx.reply(
      'Ок, на сегодня достаточно задач. В 20:00 я напомню отметить, что получилось сделать.'
    );
    return;
  }

  if (!text) {
    await ctx.reply('Текст задачи пустой. Напишите, что именно хотите сделать, или используйте /skip.');
    return;
  }

  if (idx > PLANNER_MAX_TASKS || idx > session.total_tasks) {
    // На всякий случай закрываем сессию, чтобы не было лишних записей.
    db.prepare(
      `UPDATE planner_sessions
       SET status = 'done'
       WHERE student_id = ? AND task_date = ?`
    ).run(studentId, taskDate);
    return;
  }

  // Постановка новой задачи: одна строка в daily_tasks на каждый введённый текст (idx = 1..total_tasks).
  // При повторном вводе за тот же день (Изменить планы) — обновляем текст и сбрасываем status в 'planned'.
  db.prepare(
    `INSERT INTO daily_tasks (student_id, task_date, idx, text, status)
     VALUES (?, ?, ?, ?, 'planned')
     ON CONFLICT(student_id, task_date, idx) DO UPDATE SET text = excluded.text, status = 'planned', updated_at = datetime('now')`
  ).run(studentId, taskDate, idx, text);

  const nextIndex = idx + 1;
  if (nextIndex > session.total_tasks) {
    db.prepare(
      `UPDATE planner_sessions
       SET next_index = ?, status = 'done'
       WHERE student_id = ? AND task_date = ?`
    ).run(nextIndex, studentId, taskDate);
    await ctx.reply(
      `Записал ${session.total_tasks} задач(и) на сегодня. В 20:00 напомню отметить, что получилось сделать.`
    );
  } else {
    db.prepare(
      `UPDATE planner_sessions
       SET next_index = ?
       WHERE student_id = ? AND task_date = ?`
    ).run(nextIndex, studentId, taskDate);
    await ctx.reply(
      `Задача ${nextIndex}?\n\nНапиши её своими словами. Если задач больше нет — можно написать /skip, чтобы закончить ввод.`
    );
  }
}

/** Планер: обработка выбора статуса задачи (completed / partly_done / cancelled). */
export async function handlePlannerStatus(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (!data.startsWith('planner_task_')) return;

  const parts = data.split('_'); // ['planner','task','<id>','status']
  if (parts.length < 4) return;
  const taskId = parseInt(parts[2], 10);
  const statusKey = parts[3];
  let newStatus: 'completed' | 'partly_done' | 'cancelled';
  if (statusKey === 'completed') newStatus = 'completed';
  else if (statusKey === 'partly') newStatus = 'partly_done';
  else if (statusKey === 'cancelled') newStatus = 'cancelled';
  else return;

  const db = getDb();
  const task = db
    .prepare(
      `SELECT dt.id, dt.student_id, dt.task_date, dt.text, s.telegram_user_id
       FROM daily_tasks dt
       JOIN students s ON s.id = dt.student_id
       WHERE dt.id = ?`
    )
    .get(taskId) as
    | { id: number; student_id: number; task_date: string; text: string; telegram_user_id: number }
    | undefined;
  if (!task || task.telegram_user_id !== ctx.from.id) {
    await ctx.answerCbQuery('Эта задача принадлежит другому пользователю.');
    return;
  }

  db.prepare('UPDATE daily_tasks SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
    newStatus,
    taskId
  );

  const statusText =
    newStatus === 'completed'
      ? 'Отмечено как выполнено.'
      : newStatus === 'partly_done'
        ? 'Отмечено как частично выполнено.'
        : 'Отмечено как отменённое.';
  await ctx.answerCbQuery(statusText);
  await deleteCallbackMessage(ctx);
  await ctx.reply(statusText).catch(() => {});

  if (newStatus === 'cancelled') {
    await ctx.reply(
      `Задача «${task.text}» помечена как отменённая. Если хочешь, напиши коротко, почему отменил — это поможет в дальнейшем планировании.`
    );
  }
}

function isAdmin(telegramUserId: number): boolean {
  const row = getDb().prepare('SELECT 1 FROM admins WHERE telegram_user_id = ?').get(telegramUserId);
  return !!row;
}

export async function handleLinkGroup(ctx: Context): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId || !isAdmin(fromId)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/link_group\s+(.+)/.exec(text || '');
  const name = match?.[1]?.trim();
  if (!name) {
    await ctx.reply('Использование: /link_group Название группы');
    return;
  }
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat.type === 'private') {
    await ctx.reply('Вызовите команду в группе, которую нужно привязать.');
    return;
  }
  const db = getDb();
  // Привязать группу к календарю по имени: ищем calendar_config с таким же name
  const calendarRow = db.prepare('SELECT id FROM calendar_config WHERE name = ? AND enabled = 1').get(name) as { id: number } | undefined;
  const calendarConfigId = calendarRow?.id ?? null;

  const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(name) as { id: number } | undefined;
  const groupId = existing?.id;
  if (existing) {
    db.prepare('UPDATE groups SET telegram_chat_id = ?, calendar_config_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(chatId, calendarConfigId, existing.id);
  } else {
    const r = db.prepare('INSERT INTO groups (name, telegram_chat_id, calendar_config_id) VALUES (?, ?, ?)').run(name, chatId, calendarConfigId);
    // lastInsertRowid для better-sqlite3
    const insertedId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
    // groupId для вставки event_groups ниже (в SQLite last_insert_rowid() привязан к соединению)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gid = (r as any).lastInsertRowid ?? insertedId.id;
    if (calendarConfigId) {
      const eventIds = db.prepare('SELECT id FROM calendar_events WHERE calendar_config_id = ?').all(calendarConfigId) as Array<{ id: number }>;
      for (const e of eventIds) {
        db.prepare('INSERT OR IGNORE INTO event_groups (event_id, group_id) VALUES (?, ?)').run(e.id, gid);
      }
    }
    const calMsg = calendarConfigId ? ` Календарь «${name}» привязан.` : ' Укажи в БД groups.calendar_config_id для этой группы.';
    await ctx.reply(`Группа «${name}» создана и привязана к этому чату.${calMsg}`);
    return;
  }

  if (calendarConfigId && groupId) {
    const eventIds = db.prepare('SELECT id FROM calendar_events WHERE calendar_config_id = ?').all(calendarConfigId) as Array<{ id: number }>;
    for (const e of eventIds) {
      db.prepare('INSERT OR IGNORE INTO event_groups (event_id, group_id) VALUES (?, ?)').run(e.id, groupId);
    }
  }
  const calMsg = calendarConfigId ? ` Календарь «${name}» привязан — события будут приходить сюда.` : ' Привяжи календарь в БД (groups.calendar_config_id), иначе события сюда не пойдут.';
  await ctx.reply(`Группа «${name}» привязана к этому чату (обновлено).${calMsg}`);
}

const SUBJECT_KEYS = Object.keys(SUBJECT_TOPIC_NAMES);
const SUBJECT_ALIASES: Record<string, string> = {
  русский: 'russian',
  русскийязык: 'russian',
  russian: 'russian',
  физика: 'physics',
  physics: 'physics',
  общество: 'society',
  обществознание: 'society',
  society: 'society',
  информатика: 'informatics',
  инфа: 'informatics',
  informatics: 'informatics',
  english: 'english',
  английский: 'english',
  математика: 'math',
  math: 'math',
};

function resolveSubjectKey(input: string): string | null {
  const lower = input.trim().toLowerCase();
  if (SUBJECT_TOPIC_NAMES[lower]) return lower;
  const compact = lower.replace(/\s+/g, '');
  const alias = SUBJECT_ALIASES[compact] ?? SUBJECT_ALIASES[lower];
  if (alias) return alias;
  for (const [key, name] of Object.entries(SUBJECT_TOPIC_NAMES)) {
    if (name.toLowerCase() === lower) return key;
  }
  return null;
}

function debtTypeFromAssignment(assignment: string): string {
  const normalized = assignment.replace(/\s+/g, ' ').trim();
  const left = normalized.split('—')[0]?.trim() ?? normalized;
  return left || 'Другое';
}

function formatDebtTypeCompact(assignments: string[]): string {
  if (!assignments.length) return '—';
  const counts = new Map<string, number>();
  for (const a of assignments) {
    const t = debtTypeFromAssignment(a);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const items = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  return items.map(([t, c]) => `${t}: ${c}`).join(', ');
}

const DEBTS_MENU_KEY_SET = new Set<string>(DEBTS_MENU_SUBJECT_KEYS);

async function sendDebtsReport(ctx: Context, subjectKey: string, opts: { announce?: boolean } = {}): Promise<void> {
  const { announce = true } = opts;
  const subjectLabel = SUBJECT_TOPIC_NAMES[subjectKey] ?? subjectKey;
  if (announce) {
    await ctx.reply(`Собираю долги по предмету «${subjectLabel}» из вкладки «Посещаемость»...`);
  }
  try {
    const report = await getAttendanceDebtsBySubject(subjectKey, subjectLabel);
    const header = [
      `Долги по предмету: ${report.subjectLabel}`,
      `Учеников во вкладке: ${report.stats.totalRows}`,
      `Сопоставлено с БД: ${report.stats.matchedRows}`,
      `Не сопоставлено с БД: ${report.stats.unmatchedRows}`,
      ...(report.stats.matchedWithoutSubjectInBot > 0
        ? [
            `Без предмета в /subjects (но ФИО найдено): ${report.stats.matchedWithoutSubjectInBot}`,
          ]
        : []),
      `Всего долгов «Не сдал»: ${report.stats.totalDebts}`,
      '',
    ].join('\n');
    await ctx.reply(header);
    if (!report.students.length) {
      await ctx.reply('По сопоставленным ученикам долгов «Не сдал» не найдено.');
      return;
    }
    const lines: string[] = [];
    for (const [i, s] of report.students.entries()) {
      const assignments = s.debts.map((d) => d.assignment);
      const debtList = assignments.join(', ');
      const compactTypes = formatDebtTypeCompact(assignments);
      const subjHint = s.hasSubjectInBot ? '' : ' [нет в /subjects]';
      lines.push(`${i + 1}. ${s.fullName}${s.telegramUsername ? ` (@${s.telegramUsername})` : ''}${subjHint} — ${s.debts.length}`);
      lines.push(`   Типы: ${compactTypes}`);
      lines.push(`   ${debtList}`);
    }
    let chunk = '';
    for (const line of lines) {
      const next = chunk ? `${chunk}\n${line}` : line;
      if (next.length > 3900) {
        await ctx.reply(chunk);
        chunk = line;
      } else {
        chunk = next;
      }
    }
    if (chunk) {
      await ctx.reply(chunk);
    }
  } catch (e) {
    console.error('[Attendance] /debts error:', e);
    await ctx.reply('Ошибка при чтении долгов из Google Sheets. Проверьте ATTENDANCE_SHEET_ID и доступ сервисного аккаунта.');
  }
}

export async function handleDebts(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/debts\s+(.+)/i.exec(text || '');
  const input = match?.[1]?.trim();
  if (!input) {
    await ctx.reply('Использование: /debts <предмет> (например: /debts russian или /debts Русский). Раздел «Долги» в /help — кнопки предметов.');
    return;
  }
  const subjectKey = resolveSubjectKey(input);
  if (!subjectKey) {
    await ctx.reply('Неизвестный предмет. Используйте ключ (russian, physics, ...) или русское название.');
    return;
  }
  await sendDebtsReport(ctx, subjectKey, { announce: true });
}

/** Кнопка предмета в разделе «Долги» админ-помощи. */
export async function handleAdminDebtsSubjectCallback(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (!data.startsWith('adm_debt:')) return;
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('Только для администраторов.');
    return;
  }
  const key = data.slice('adm_debt:'.length);
  if (!DEBTS_MENU_KEY_SET.has(key)) {
    await ctx.answerCbQuery('Неизвестный предмет.');
    return;
  }
  const label = SUBJECT_TOPIC_NAMES[key] ?? key;
  await ctx.answerCbQuery(`Загрузка: ${label}`);
  await sendDebtsReport(ctx, key, { announce: false });
}

/** Админ: экспорт CSV по "exams" за неделю (Пн–Сб) вокруг даты. */
export async function handleExportExamsWeek(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/export_exams_week\s+(\d{4}-\d{2}-\d{2})/i.exec(text || '');
  const weekDateIso = match?.[1];
  if (!weekDateIso) {
    await ctx.reply('Использование: /export_exams_week YYYY-MM-DD');
    return;
  }

  try {
    const res = exportExamsWeekCsv({ weekDateIso });
    await ctx.reply(`Экспортирую exams CSV за неделю ${res.weekStart} — ${res.weekEnd} (строк: ${res.rows})...`);
    await ctx.replyWithDocument(
      { source: res.filePath, filename: res.fileName } as any,
      { caption: `exams CSV ${res.weekStart} — ${res.weekEnd} (rows=${res.rows})` } as any
    );
  } catch (e) {
    console.error('[ExamsExport] /export_exams_week error:', e);
    await ctx.reply('Ошибка экспорта exams CSV. Подробности в логах.');
  }
}

/** Привязать текущий топик к предмету. Вызвать в группе, внутри нужного топика: /link_topic math или /link_topic Математика */
export async function handleLinkTopic(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const chatId = ctx.chat?.id;
  const threadId = ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : undefined;
  if (!chatId || ctx.chat?.type === 'private') {
    await ctx.reply('Вызовите команду в группе (внутри нужного топика).');
    return;
  }
  if (threadId == null) {
    await ctx.reply('Вызовите команду внутри топика (темы), который нужно привязать к предмету.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/link_topic\s+(.+)/.exec(text || '');
  const input = match?.[1]?.trim();
  if (!input) {
    const list = SUBJECT_KEYS.map((k) => `${k} или ${SUBJECT_TOPIC_NAMES[k]}`).join(', ');
    await ctx.reply(`Использование: /link_topic <предмет>\nПредметы: ${list}`);
    return;
  }
  const subjectKey = resolveSubjectKey(input);
  if (!subjectKey) {
    await ctx.reply('Неизвестный предмет. Доступны: ' + Object.entries(SUBJECT_TOPIC_NAMES).map(([k, n]) => `${k}/${n}`).join(', '));
    return;
  }
  const db = getDb();
  const group = db.prepare('SELECT id FROM groups WHERE telegram_chat_id = ?').get(chatId) as { id: number } | undefined;
  if (!group) {
    await ctx.reply('Сначала привяжите группу к чату: /link_group Название группы');
    return;
  }
  try {
    db.prepare(
      `INSERT INTO group_topics (group_id, subject_key, topic_id, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(group_id, subject_key) DO UPDATE SET topic_id = excluded.topic_id, updated_at = datetime('now')`
    ).run(group.id, subjectKey, threadId);
  } catch (e) {
    await ctx.reply('Ошибка (таблица group_topics есть? Выполните миграции).');
    return;
  }
  await ctx.reply(`Топик привязан к предмету «${SUBJECT_TOPIC_NAMES[subjectKey]}».`);
}

/** Форматирует список студентов (имя, @username) по списку id. */
function formatStudentList(db: ReturnType<typeof getDb>, studentIds: number[]): string {
  if (studentIds.length === 0) return '—';
  const placeholders = studentIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, first_name, telegram_username FROM students WHERE id IN (${placeholders}) ORDER BY first_name, id`
    )
    .all(...studentIds) as Array<{ id: number; first_name: string; telegram_username: string | null }>;
  return rows.map((s, i) => `${i + 1}. ${s.first_name || '—'}${s.telegram_username ? ` (@${s.telegram_username})` : ''}`).join('\n');
}

/** Контент экрана «Изменить планы»: список задач с кнопками Изменить/Удалить, Добавить задачу, Назад. Возвращает null, если задач нет. */
function buildPlannerEditListContent(
  db: ReturnType<typeof getDb>,
  studentId: number,
  taskDate: string
): { text: string; inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | null {
  const tasks = db
    .prepare(
      `SELECT id, idx, text FROM daily_tasks WHERE student_id = ? AND task_date = ? ORDER BY idx`
    )
    .all(studentId, taskDate) as Array<{ id: number; idx: number; text: string }>;
  if (tasks.length === 0) return null;
  const lines = [
    'Твои задачи на сегодня. Выбери, что изменить:',
    '',
    ...tasks.map((t) => `${t.idx}. ${t.text}`),
    '',
  ];
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = tasks.map((t) => [
    Markup.button.callback(`Изменить ${t.idx}`, `planner_edit_${t.id}`),
    Markup.button.callback(`Удалить ${t.idx}`, `planner_del_${t.id}`),
  ]);
  const bottomRow: Array<{ text: string; callback_data: string }> = [];
  if (tasks.length < PLANNER_MAX_TASKS) bottomRow.push(Markup.button.callback('Добавить задачу', 'planner_add_task'));
  bottomRow.push(Markup.button.callback('Назад к задачам', 'planner_edit_done'));
  keyboard.push(bottomRow);
  return { text: lines.join('\n'), inline_keyboard: keyboard };
}

export async function handleSubscribers(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const db = getDb();
  const groupName = '2 курс';
  const group = db.prepare('SELECT id, name FROM groups WHERE name = ?').get(groupName) as { id: number; name: string } | undefined;
  if (!group) {
    await ctx.reply(`Группа «${groupName}» не найдена. Список групп: /groups`);
    return;
  }
  const rows = db
    .prepare(
      `SELECT s.id, s.telegram_user_id, s.first_name, s.telegram_username
       FROM student_groups sg
       JOIN students s ON s.id = sg.student_id
       WHERE sg.group_id = ?
       ORDER BY s.first_name, s.id`
    )
    .all(group.id) as Array<{ id: number; telegram_user_id: number; first_name: string; telegram_username: string | null }>;
  const lines = [
    `Подписчики на бота и календарь «${group.name}»: ${rows.length} чел.`,
    '',
    ...rows.map((s, i) => `${i + 1}. ${s.first_name || '—'}${s.telegram_username ? ` @${s.telegram_username}` : ''} (id ${s.telegram_user_id})`),
  ];
  const text = lines.join('\n');
  if (text.length > 4000) {
    await ctx.reply(lines.slice(0, 2).join('\n') + '\n… (список слишком длинный, показ первых 50)');
    const short = rows.slice(0, 50).map((s, i) => `${i + 1}. ${s.first_name || '—'}${s.telegram_username ? ` @${s.telegram_username}` : ''} (id ${s.telegram_user_id})`);
    await ctx.reply(short.join('\n'));
  } else {
    await ctx.reply(text);
  }
}

export async function handleSelect(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/select\s+([A-Za-z]+)=(.+)/i.exec(text || '');
  const key = match?.[1]?.toLowerCase();
  const value = match?.[2]?.trim();
  if (!key || !value) {
    await ctx.reply('Использование: /select C=Название курса (группы), /select E=ID события или /select G=<предмет>');
    return;
  }
  const db = getDb();
  const chatId = ctx.chat?.id ?? 0;

  // /select C=Название — выборка по курсу/группе (как раньше /select group=)
  if (key === 'c') {
    const group = db.prepare('SELECT id FROM groups WHERE name = ?').get(value) as { id: number } | undefined;
    if (!group) {
      await ctx.reply(`Группа «${value}» не найдена. Список: /groups`);
      return;
    }
    const rows = db
      .prepare('SELECT DISTINCT student_id FROM student_groups WHERE group_id = ?')
      .all(group.id) as Array<{ student_id: number }>;
    const studentIds = rows.map((r) => r.student_id);
    db.prepare(
      `INSERT INTO selections (created_by_telegram_user_id, chat_id, criteria, student_ids)
       VALUES (?, ?, ?, ?)`
    ).run(ctx.from.id, chatId, `group=${value}`, JSON.stringify(studentIds));
    const listText = formatStudentList(db, studentIds);
    const msg = `Выборка: ${studentIds.length} человек (группа «${value}»). Теперь /push Текст сообщения\n\nВ выборке:\n${listText}`;
    if (msg.length > 4096) {
      await ctx.reply(`Выборка: ${studentIds.length} человек (группа «${value}»). Теперь /push Текст сообщения`);
      const chunk = listText.length > 4000 ? listText.slice(0, 3970) + '\n… (лимит сообщения)' : listText;
      await ctx.reply('В выборке:\n' + chunk);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  // /select E=ID или /select event=ID — выборка по событию (как раньше)
  if (key === 'e' || key === 'event') {
    const eventId = parseInt(value, 10);
    if (Number.isNaN(eventId)) {
      await ctx.reply('Укажите числовой ID события, например: /select event=42');
      return;
    }
    const event = db.prepare('SELECT id FROM calendar_events WHERE id = ? AND status = ?').get(eventId, 'active') as { id: number } | undefined;
    if (!event) {
      await ctx.reply(`Событие #${eventId} не найдено или не активно.`);
      return;
    }
    const subjectKeys = (db.prepare('SELECT subject_key FROM event_subjects WHERE event_id = ?').all(eventId) as Array<{ subject_key: string }>).map((r) => r.subject_key);
    let studentIds: number[];
    if (subjectKeys.length > 0) {
      const placeholders = subjectKeys.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT DISTINCT s.id FROM event_groups eg
           JOIN student_groups sg ON sg.group_id = eg.group_id
           JOIN students s ON s.id = sg.student_id
           WHERE eg.event_id = ? AND s.notify_dm = 1 AND s.dm_blocked = 0
           AND EXISTS (SELECT 1 FROM student_subjects ss WHERE ss.student_id = s.id AND ss.subject_key IN (${placeholders}))`
        )
        .all(eventId, ...subjectKeys) as Array<{ id: number }>;
      studentIds = rows.map((r) => r.id);
      if (studentIds.length === 0) {
        const fallback = db
          .prepare(
            `SELECT DISTINCT s.id FROM event_groups eg
             JOIN student_groups sg ON sg.group_id = eg.group_id
             JOIN students s ON s.id = sg.student_id
             WHERE eg.event_id = ? AND s.notify_dm = 1 AND s.dm_blocked = 0`
          )
          .all(eventId) as Array<{ id: number }>;
        studentIds = fallback.map((r) => r.id);
      }
    } else {
      const rows = db
        .prepare(
          `SELECT DISTINCT s.id FROM event_groups eg
           JOIN student_groups sg ON sg.group_id = eg.group_id
           JOIN students s ON s.id = sg.student_id
           WHERE eg.event_id = ? AND s.notify_dm = 1 AND s.dm_blocked = 0`
        )
        .all(eventId) as Array<{ id: number }>;
      studentIds = rows.map((r) => r.id);
    }
    db.prepare(
      `INSERT INTO selections (created_by_telegram_user_id, chat_id, criteria, student_ids)
       VALUES (?, ?, ?, ?)`
    ).run(ctx.from.id, chatId, `event=${eventId}`, JSON.stringify(studentIds));
    const listTextE = formatStudentList(db, studentIds);
    const msgE = `Выборка: ${studentIds.length} человек (событие #${eventId}). Теперь /push Текст сообщения\n\nВ выборке:\n${listTextE}`;
    if (msgE.length > 4096) {
      await ctx.reply(`Выборка: ${studentIds.length} человек (событие #${eventId}). Теперь /push Текст сообщения`);
      const chunkE = listTextE.length > 4000 ? listTextE.slice(0, 3970) + '\n… (лимит сообщения)' : listTextE;
      await ctx.reply('В выборке:\n' + chunkE);
    } else {
      await ctx.reply(msgE);
    }
    return;
  }

  // /select G=<предмет> — все студенты, выбравшие этот предмет в /subjects (по всей базе).
  if (key === 'g') {
    const subjectInput = value;
    const subjectKey = resolveSubjectKey(subjectInput);
    if (!subjectKey) {
      await ctx.reply('Неизвестный предмет. Используйте ключ (math, physics, russian, …) или название (Математика, Физика, …).');
      return;
    }
    const rows = db
      .prepare(
        `SELECT DISTINCT s.id
         FROM student_subjects ss
         JOIN students s ON s.id = ss.student_id
         WHERE ss.subject_key = ?
           AND s.notify_dm = 1 AND s.dm_blocked = 0`
      )
      .all(subjectKey) as Array<{ id: number }>;
    const studentIds = rows.map((r) => r.id);
    db.prepare(
      `INSERT INTO selections (created_by_telegram_user_id, chat_id, criteria, student_ids)
       VALUES (?, ?, ?, ?)`
    ).run(ctx.from.id, chatId, `group_subject=${subjectKey}`, JSON.stringify(studentIds));
    const listTextG = formatStudentList(db, studentIds);
    const msgG = `Выборка: ${studentIds.length} человек (предмет «${SUBJECT_TOPIC_NAMES[subjectKey]}» по всей базе). Теперь /push Текст сообщения\n\nВ выборке:\n${listTextG}`;
    if (msgG.length > 4096) {
      await ctx.reply(`Выборка: ${studentIds.length} человек (предмет «${SUBJECT_TOPIC_NAMES[subjectKey]}» по всей базе). Теперь /push Текст сообщения`);
      const chunkG = listTextG.length > 4000 ? listTextG.slice(0, 3970) + '\n… (лимит сообщения)' : listTextG;
      await ctx.reply('В выборке:\n' + chunkG);
    } else {
      await ctx.reply(msgG);
    }
  }
}

export async function handlePush(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/push\s+(.+)/s.exec(text || '');
  const messageText = match?.[1]?.trim();
  if (!messageText) {
    await ctx.reply('Использование: /push Текст сообщения (сначала сделайте /select group=... или /select event=...)');
    return;
  }
  const db = getDb();
  const last = db
    .prepare(
      'SELECT id, student_ids FROM selections WHERE created_by_telegram_user_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(ctx.from.id) as { id: number; student_ids: string } | undefined;
  if (!last) {
    await ctx.reply('Сначала сделайте выборку: /select group=Название или /select event=ID');
    return;
  }
  const studentIds: number[] = JSON.parse(last.student_ids || '[]');
  if (studentIds.length === 0) {
    await ctx.reply('В выборке 0 человек. Сделайте новую выборку /select.');
    return;
  }
  const countLastHour = db
    .prepare(
      `SELECT COUNT(*) as c
       FROM send_queue sq
       JOIN selections s ON s.id = sq.selection_id
       WHERE s.created_by_telegram_user_id = ?
         AND sq.selection_id IS NOT NULL
         AND sq.created_at > datetime('now', '-1 hour')`
    )
    .get(ctx.from.id) as { c: number };
  if (countLastHour.c + studentIds.length > PUSH_LIMIT_PER_HOUR) {
    const remaining = PUSH_LIMIT_PER_HOUR - countLastHour.c;
    const remainingText = remaining > 0 ? `Максимум сейчас можно отправить: ${remaining}.` : 'Сейчас лимит исчерпан, подождите.';
    await ctx.reply(
      `Лимит: не более ${PUSH_LIMIT_PER_HOUR} сообщений в час. Уже поставлено в очередь за последний час: ${countLastHour.c}. В выборке: ${studentIds.length}.\n${remainingText}`
    );
    return;
  }
  pendingPushByAdmin.set(ctx.from.id, { selectionId: last.id, text: messageText });
  const preview = messageText.length > 200 ? messageText.slice(0, 197) + '…' : messageText;
  await ctx.reply(
    `Отправить сообщение ${studentIds.length} людям?\n` +
      `(selection_id=${last.id}, потом можно посмотреть /push_report ${last.id})\n\n` +
      '---\n' +
      `${preview}\n` +
      '---',
    {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('Да', 'push_confirm_yes'), Markup.button.callback('Отмена', 'push_confirm_no')],
        ],
      },
    },
  );
}

/** Отчёт по доставке рассылки /push: кому доставлено, кому нет, кому ещё не отправлено. */
export async function handlePushReport(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/push_report\s*(\d+)?/.exec(text || '');
  const requestedId = match && match[1] ? parseInt(match[1], 10) : null;

  const db = getDb();

  const selection = requestedId
    ? (db
        .prepare(
          'SELECT id, student_ids, created_at, criteria FROM selections WHERE id = ? AND created_by_telegram_user_id = ?'
        )
        .get(requestedId, ctx.from.id) as
        | { id: number; student_ids: string; created_at: string; criteria: string | null }
        | undefined)
    : (db
        .prepare(
          'SELECT id, student_ids, created_at, criteria FROM selections WHERE created_by_telegram_user_id = ? ORDER BY created_at DESC LIMIT 1'
        )
        .get(ctx.from.id) as
        | { id: number; student_ids: string; created_at: string; criteria: string | null }
        | undefined);

  if (!selection) {
    await ctx.reply(
      requestedId
        ? `Выборка с id=${requestedId} не найдена или не принадлежит вам.`
        : 'Выборок пока не было. Сначала сделайте /select и /push.'
    );
    return;
  }

  const studentIds: number[] = JSON.parse(selection.student_ids || '[]');
  if (studentIds.length === 0) {
    await ctx.reply('В этой выборке нет студентов (0 человек).');
    return;
  }

  const placeholders = studentIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         s.id,
         s.first_name,
         s.last_name,
         s.telegram_username,
         (
           SELECT success
           FROM push_log pl
           WHERE pl.selection_id = ? AND pl.student_id = s.id
           ORDER BY pl.sent_at DESC, pl.id DESC
           LIMIT 1
         ) AS success
       FROM students s
       WHERE s.id IN (${placeholders})
       ORDER BY s.last_name, s.first_name, s.id`
    )
    .all(selection.id, ...studentIds) as Array<{
    id: number;
    first_name: string | null;
    last_name: string | null;
    telegram_username: string | null;
    success: 0 | 1 | null;
  }>;

  const delivered: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];

  for (const s of rows) {
    const name = `${s.first_name || ''} ${s.last_name || ''}`.trim() || '—';
    const user = s.telegram_username ? ` (@${s.telegram_username})` : '';
    const label = `${name}${user}`;
    if (s.success === 1) {
      delivered.push(label);
    } else if (s.success === 0) {
      failed.push(label);
    } else {
      pending.push(label);
    }
  }

  const total = rows.length;
  const deliveredCount = delivered.length;
  const failedCount = failed.length;
  const pendingCount = pending.length;

  const headerLines = [
    `Отчёт по рассылке /push для selection_id=${selection.id}:`,
    selection.criteria ? `Критерий: ${selection.criteria}` : '',
    `Всего в выборке: ${total}`,
    `✅ Доставлено: ${deliveredCount}`,
    `❌ Не доставлено: ${failedCount}`,
    `⏳ В очереди / без статуса: ${pendingCount}`,
    '',
  ].filter(Boolean);

  const sections: string[] = [];
  if (deliveredCount > 0) {
    sections.push('✅ Доставлено:\n' + delivered.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }
  if (failedCount > 0) {
    sections.push('❌ Не доставлено:\n' + failed.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }
  if (pendingCount > 0) {
    sections.push('⏳ В очереди / неизвестно:\n' + pending.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }

  const fullText = headerLines.join('\n') + (sections.length ? '\n' + sections.join('\n\n') : '');

  if (fullText.length <= 4000) {
    await ctx.reply(fullText);
    return;
  }

  // Если отчёт слишком длинный — шлём несколькими сообщениями.
  await ctx.reply(headerLines.join('\n'));
  for (const section of sections) {
    if (section.length <= 4000) {
      await ctx.reply(section);
    } else {
      // Очень большая секция (много людей) — режем по строкам.
      const lines = section.split('\n');
      let chunk: string[] = [];
      let chunkLen = 0;
      for (const line of lines) {
        if (chunkLen + line.length + 1 > 4000) {
          await ctx.reply(chunk.join('\n'));
          chunk = [line];
          chunkLen = line.length + 1;
        } else {
          chunk.push(line);
          chunkLen += line.length + 1;
        }
      }
      if (chunk.length) {
        await ctx.reply(chunk.join('\n'));
      }
    }
  }
}

export async function handlePushCallback(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (data !== 'push_confirm_yes' && data !== 'push_confirm_no') return;
  const pending = pendingPushByAdmin.get(ctx.from.id);
  if (data === 'push_confirm_no') {
    pendingPushByAdmin.delete(ctx.from.id);
    await ctx.answerCbQuery('Отменено');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    return;
  }
  if (!pending) {
    await ctx.answerCbQuery('Сессия истекла. Сделайте /push заново.');
    return;
  }
  pendingPushByAdmin.delete(ctx.from.id);
  const db = getDb();
  const sel = db.prepare('SELECT student_ids, created_by_telegram_user_id FROM selections WHERE id = ?').get(pending.selectionId) as { student_ids: string; created_by_telegram_user_id: number } | undefined;
  if (!sel) {
    await ctx.answerCbQuery('Выборка не найдена.');
    return;
  }
  const studentIds: number[] = JSON.parse(sel.student_ids || '[]');
  if (studentIds.length === 0) {
    await ctx.answerCbQuery('В выборке 0 человек.');
    return;
  }
  const placeholders = studentIds.map(() => '?').join(',');
  const students = db
    .prepare(`SELECT id, telegram_user_id FROM students WHERE id IN (${placeholders})`)
    .all(...studentIds) as Array<{ id: number; telegram_user_id: number }>;
  for (const s of students) {
    db.prepare(
      `INSERT INTO send_queue (type, chat_id, message_thread_id, text, event_id, student_id, notification_type, status, selection_id)
       VALUES ('dm', ?, NULL, ?, NULL, ?, NULL, 'pending', ?)`
    ).run(s.telegram_user_id, pending.text, s.id, pending.selectionId);
  }
  await ctx.answerCbQuery(`В очередь добавлено ${students.length} сообщений.`);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
}

export async function handleEvents(ctx: Context): Promise<void> {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const match = /\/events\s*(\d*)/.exec(text || '');
  const limit = Math.min(50, Math.max(1, parseInt(match?.[1] || '10', 10) || 10));
  const db = getDb();
  const nowIso = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT id, title, start_at, end_at FROM calendar_events
       WHERE status = 'active' AND start_at >= ?
       ORDER BY start_at LIMIT ?`
    )
    .all(nowIso, limit) as Array<{ id: number; title: string; start_at: string; end_at: string }>;
  if (rows.length === 0) {
    await ctx.reply('Ближайших событий нет.');
    return;
  }
  const tz = getConfig().TZ || EVENTS_DISPLAY_TZ;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const lines = rows.map((e) => `#${e.id} ${e.title || 'Без названия'} — ${fmt(e.start_at)}`);
  await ctx.reply('Ближайшие события:\n' + lines.join('\n'));
}

export async function handleSyncNow(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  await ctx.reply('Запускаю синхронизацию календаря…');
  try {
    await runCalendarSyncJob({ force: true });
    await ctx.reply('Синхронизация завершена.');
  } catch (e) {
    await ctx.reply('Ошибка синхронизации: ' + String(e));
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }

  const db = getDb();
  const config = getConfig();

  // "Degraded mode" состояния расписаний — дублируем логику из src/index.ts,
  // чтобы админам было видно почему Job1/Job5 пропускаются.
  const calendarEnabled = (db.prepare("SELECT COUNT(*) as c FROM calendar_config WHERE enabled = 1").get() as { c: number }).c;
  const calendarKeyPath = config.GOOGLE_APPLICATION_CREDENTIALS ? path.resolve(config.GOOGLE_APPLICATION_CREDENTIALS) : null;
  const calendarOk =
    calendarEnabled === 0 ||
    (!!config.GOOGLE_APPLICATION_CREDENTIALS &&
      !!calendarKeyPath &&
      fs.existsSync(calendarKeyPath));

  const plannerOk = (() => {
    const sheetId = config.PLANNER_SHEET_ID;
    if (!sheetId || !sheetId.trim()) return false;
    const keyPath = config.GOOGLE_APPLICATION_CREDENTIALS ? path.resolve(config.GOOGLE_APPLICATION_CREDENTIALS) : null;
    if (!keyPath) return false;
    return fs.existsSync(keyPath);
  })();

  const sendQueueCounts = db
    .prepare('SELECT status, COUNT(*) as c FROM send_queue GROUP BY status')
    .all() as Array<{ status: string; c: number }>;
  const pending = sendQueueCounts.find((r) => r.status === 'pending')?.c ?? 0;
  const processing = sendQueueCounts.find((r) => r.status === 'processing')?.c ?? 0;
  const failed = sendQueueCounts.find((r) => r.status === 'failed')?.c ?? 0;

  const notificationQueuePending = (db.prepare("SELECT COUNT(*) as c FROM notification_queue WHERE status = 'pending'").get() as { c: number })
    .c;

  const calendarSyncError = (db.prepare(
    "SELECT COUNT(*) as c FROM calendar_config WHERE enabled = 1 AND sync_error = 1"
  ).get() as { c: number }).c;

  const locksActive = db
    .prepare("SELECT COUNT(*) as c FROM job_locks WHERE expires_at > datetime('now')")
    .get() as { c: number };

  const safeGetJobHealth = (jobName: string): { last_success_at: string | null; last_error_at: string | null; last_error_message: string | null } | null => {
    try {
      return (
        db
          .prepare(
            'SELECT last_success_at, last_error_at, last_error_message FROM job_health WHERE job_name = ?'
          )
          .get(jobName) as { last_success_at: string | null; last_error_at: string | null; last_error_message: string | null } | undefined
      ) ?? null;
    } catch {
      return null;
    }
  };

  const job1Health = safeGetJobHealth('job1_calendar_sync');
  const job2Health = safeGetJobHealth('job2_notification_scheduler');

  const formatJobHealth = (h: typeof job1Health): string => {
    if (!h) return 'n/a';
    const success = h.last_success_at ?? '—';
    const errAt = h.last_error_at ?? '—';
    return `success=${success} last_error=${errAt}`;
  };

  const trunc = (s: string): string => (s.length > 140 ? s.slice(0, 137) + '...' : s);
  const job1ErrMsg = job1Health?.last_error_message ? ` (${trunc(job1Health.last_error_message)})` : '';
  const job2ErrMsg = job2Health?.last_error_message ? ` (${trunc(job2Health.last_error_message)})` : '';

  const text = [
    'Status',
    `send_queue: pending=${pending} processing=${processing} failed=${failed}`,
    `notification_queue(pending)=${notificationQueuePending}`,
    `calendar_config(sync_error)=${calendarSyncError}/${calendarEnabled}`,
    `degraded: calendarOk=${calendarOk ? 'yes' : 'no'} plannerOk=${plannerOk ? 'yes' : 'no'}`,
    `Job1 calendar sync: ${calendarOk ? 'scheduled' : 'disabled (calendar config missing)'}`,
    `Job5 exports to Sheets: ${plannerOk ? 'scheduled' : 'disabled (planner config missing)'}`,
    `job_locks(active)=${locksActive.c}`,
    `job1_calendar_sync: ${formatJobHealth(job1Health)}${job1ErrMsg}`,
    `job2_notification_scheduler: ${formatJobHealth(job2Health)}${job2ErrMsg}`,
  ].join('\n');

  await ctx.reply(text);
}

export async function handleGroups(ctx: Context): Promise<void> {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply('Команда только для администраторов.');
    return;
  }
  const rows = getDb().prepare('SELECT id, name, telegram_chat_id FROM groups').all() as Array<{ id: number; name: string; telegram_chat_id: number }>;
  if (rows.length === 0) {
    await ctx.reply('Групп пока нет. Добавьте через /link_group в нужном чате.');
    return;
  }
  const list = rows.map((r) => `${r.name} (chat_id: ${r.telegram_chat_id})`).join('\n');
  await ctx.reply(`Группы:\n${list}`);
}

/** Показать привязки топиков к предметам в этой группе. Чтобы сообщения шли в ветки, а не в General — вызовите /link_topic в каждом топике. */
export async function handleCheckTopics(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId || ctx.chat?.type === 'private') {
    await ctx.reply('Вызовите команду в группе, для которой привязаны топики.');
    return;
  }
  const db = getDb();
  const group = db.prepare('SELECT id, name FROM groups WHERE telegram_chat_id = ?').get(chatId) as { id: number; name: string } | undefined;
  if (!group) {
    await ctx.reply('Эта группа не привязана. Сначала /link_group Название в этом чате.');
    return;
  }
  const rows = db
    .prepare('SELECT subject_key, topic_id FROM group_topics WHERE group_id = ? ORDER BY subject_key')
    .all(group.id) as Array<{ subject_key: string; topic_id: number }>;
  if (rows.length === 0) {
    await ctx.reply(
      'Топики по предметам не привязаны — поэтому сообщения уходят в General.\n\n' +
        'Чтобы напоминания шли в ветки: зайдите в каждый топик (Математика, Физика и т.д.) и выполните там:\n/link_topic математика\n/link_topic физика\nи т.п. Список предметов: math, informatics, physics, society, russian, english (или по-русски: Математика, Информатика, …).'
    );
    return;
  }
  const list = rows.map((r) => `  ${r.subject_key} → topic_id ${r.topic_id}`).join('\n');
  await ctx.reply(`Группа «${group.name}», привязанные топики:\n${list}\n\nЕсли чего-то не хватает — в нужном топике выполните /link_topic <предмет>.`);
}

/** Кнопка «Буду на занятии» в напоминаниях 15/5 мин: сохраняем в reminder_confirmations и убираем кнопку. */
export async function handleConfirmReminder(ctx: Context): Promise<void> {
  const cb = ctx.callbackQuery;
  if (!cb || !('data' in cb) || !ctx.from) return;
  const data = cb.data as string;
  if (!data.startsWith('confirm_15m_')) return;
  const parts = data.split('_');
  const eventId = parseInt(parts[2], 10);
  const studentId = parseInt(parts[3], 10);
  if (Number.isNaN(eventId) || Number.isNaN(studentId)) {
    await ctx.answerCbQuery('Ошибка данных.');
    return;
  }
  const db = getDb();
  const student = db.prepare('SELECT id, telegram_user_id FROM students WHERE id = ?').get(studentId) as
    | { id: number; telegram_user_id: number }
    | undefined;
  if (!student || student.telegram_user_id !== ctx.from.id) {
    await ctx.answerCbQuery('Это сообщение было отправлено не вам.');
    return;
  }
  try {
    db.prepare('INSERT OR IGNORE INTO reminder_confirmations (event_id, student_id) VALUES (?, ?)').run(eventId, studentId);
  } catch (e) {
    if (String((e as { message?: string })?.message ?? e).includes('no such table')) {
      await ctx.answerCbQuery('Функция пока недоступна.');
      return;
    }
    throw e;
  }
  try {
    await ctx.answerCbQuery('Записали: будешь на занятии.');
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (msg.includes('query is too old') || msg.includes('query ID is invalid')) {
      // Старый callback от Telegram, просто игнорируем, чтобы не падать.
    } else {
      console.error('[Reminder] handleConfirmReminder answerCbQuery error:', e);
    }
  }
  await deleteCallbackMessage(ctx);
  await ctx.reply('Записали! Ждём на занятии.').catch(() => {});
}

/** Показать chat_id и (если в топике) topic_id текущего чата. Нужно для настройки и переключения на боевой чат. */
export async function handleChatId(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const inTopic = ctx.message && 'message_thread_id' in ctx.message ? ctx.message.message_thread_id : null;
  let text = `chat_id этого чата: \`${chatId}\``;
  if (inTopic != null) {
    text += `\ntopic_id (message_thread_id) этого топика: \`${inTopic}\``;
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
}
