import { google, sheets_v4 } from 'googleapis';
import { getConfig } from '../config';
import { getDb } from '../db';

let sheetsClient: sheets_v4.Sheets | null = null;
const sheetIdCache = new Map<string, number>();

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (sheetsClient) return sheetsClient;
  const config = getConfig();
  if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set for planner export');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function parseSheetName(range: string): string {
  const [sheetPart] = range.split('!');
  return sheetPart.replace(/^'/, '').replace(/'$/, '');
}

function colLetterToIndex(letter: string): number {
  // Поддерживаем одиночные буквы A–Z.
  const c = letter.trim().toUpperCase();
  return c.charCodeAt(0) - 'A'.charCodeAt(0);
}

type PlannerDayAggregate = {
  studentId: number;
  fullName: string;
  lastName: string;
  firstName: string;
  tasks: Array<{ text: string; status: 'planned' | 'completed' | 'partly_done' }>;
  dayStatus: string;
};

function getDayColumnLetters(taskDate: string): { textCol: string; resultCol: string } | null {
  const d = new Date(taskDate + 'T00:00:00');
  const day = d.getDay(); // 0 = Sunday, 1 = Monday ... 6 = Saturday
  switch (day) {
    case 1: // Monday
      return { textCol: 'D', resultCol: 'E' };
    case 2: // Tuesday
      return { textCol: 'F', resultCol: 'G' };
    case 3: // Wednesday
      return { textCol: 'H', resultCol: 'I' };
    case 4: // Thursday
      return { textCol: 'J', resultCol: 'K' };
    case 5: // Friday
      return { textCol: 'L', resultCol: 'M' };
    default:
      return null;
  }
}

async function getSheetId(spreadsheetId: string, sheetName: string): Promise<number | null> {
  const cacheKey = `${spreadsheetId}:${sheetName}`;
  if (sheetIdCache.has(cacheKey)) {
    return sheetIdCache.get(cacheKey) ?? null;
  }
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.get({ spreadsheetId });
  const found = resp.data.sheets?.find((s) => s.properties?.title === sheetName);
  const id = found?.properties?.sheetId ?? null;
  if (id != null) {
    sheetIdCache.set(cacheKey, id);
  }
  return id;
}

/**
 * Записать задачи планера в «недельную» таблицу вида:
 * A: ФИО, B: Предметы, C: Выполнение, далее по 2 столбца на каждый день недели.
 * Для текущей даты заполняется только соответствующая пара столбцов (день + Результат).
 * Если все задачи студента за день выполнены (allCompleted=true) — ячейка с задачами подсвечивается зачёркнутым шрифтом.
 */
export async function writePlannerDay(
  taskDate: string,
  aggregates: PlannerDayAggregate[]
): Promise<number> {
  if (!aggregates.length) return 0;
  const config = getConfig();
  const spreadsheetId = config.PLANNER_SHEET_ID;
  const baseRange = config.PLANNER_SHEET_RANGE || 'Sheet1!A:D';
  if (!spreadsheetId) {
    console.warn('[Planner] PLANNER_SHEET_ID is not set, skipping export. Would update rows:', aggregates.length);
    return 0;
  }

  const dayCols = getDayColumnLetters(taskDate);
  if (!dayCols) {
    console.warn('[Planner] writePlannerDay: taskDate is weekend, skipping export for', taskDate);
    return 0;
  }

  const sheets = await getSheetsClient();
  const sheetName = parseSheetName(baseRange);

  try {
    // Читаем колонку A (ФИО), начиная со второй строки.
    const fioRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A2:A`,
    });
    const values = fioRes.data.values ?? [];

  // Маппинги:
  // - studentIdToRow: строгий маппинг по ID из таблицы (формат "ФИО (ID:123)")
  // - nameKeyToRow: fallback по "фамилия|имя", как в исходной логике.
  const studentIdToRow = new Map<number, number>();
  const nameKeyToRow = new Map<string, number>();
  const db = getDb();
  const mappingErrors: string[] = [];

  values.forEach((row, idx) => {
    const raw = (row[0] ?? '').toString().trim();
    if (!raw) return;
    const rowIndex = idx + 2; // +2, потому что начинали с A2

    // Пытаемся вытащить ID из строки вида "(ID:123)" (или "ID:123" без скобок).
    // Важно: не требуем, чтобы ID был строго в конце строки, т.к. формат в Google Sheets может отличаться.
    const idMatch = raw.match(/\(ID:\s*(\d+)\)/i) ?? raw.match(/ID:\s*(\d+)/i);
    let textWithoutId = raw;
    let studentIdFromSheet: number | null = null;
    if (idMatch) {
      const parsedId = Number.parseInt(idMatch[1], 10);
      if (Number.isNaN(parsedId)) {
        studentIdFromSheet = null;
      } else {
        studentIdFromSheet = parsedId;
        // Убираем из строки кусок с ID, чтобы ФИО распарсились корректно.
        textWithoutId = raw
          .replace(/\(ID:\s*\d+\)/i, '')
          .replace(/ID:\s*\d+/i, '')
          .trim();
      }
    }

    const parts = textWithoutId.split(/\s+/);
    const lastName = (parts[0] ?? '').trim().toLowerCase();
    if (!lastName) return;
    const firstName = (parts[1] ?? '').trim().toLowerCase();

    // Fallback-карта по фамилии/имени (старое поведение).
    const lastOnlyKey = `${lastName}|`;
    if (!nameKeyToRow.has(lastOnlyKey)) {
      nameKeyToRow.set(lastOnlyKey, rowIndex);
    }
    if (firstName) {
      const fullKey = `${lastName}|${firstName}`;
      if (!nameKeyToRow.has(fullKey)) {
        nameKeyToRow.set(fullKey, rowIndex);
      }
    }

    // Если есть ID — сопоставляем по ID и (дополнительно) проверяем ФИО для диагностики.
    if (studentIdFromSheet != null) {
      const student = db
        .prepare('SELECT id, first_name, last_name FROM students WHERE id = ?')
        .get(studentIdFromSheet) as { id: number; first_name: string | null; last_name: string | null } | undefined;
      if (!student) {
        mappingErrors.push(
          `[Planner] Sheet mapping: id=${studentIdFromSheet} из строки "${raw}" не найден в БД студентов (row ${rowIndex}).`
        );
        return;
      }
      const dbLast = (student.last_name ?? '').trim().toLowerCase();
      const dbFirst = (student.first_name ?? '').trim().toLowerCase();
      if (!dbLast || dbLast !== lastName || (firstName && dbFirst !== firstName)) {
        mappingErrors.push(
          `[Planner] Sheet mapping: несовпадение ФИО для id=${student.id}: в БД "${student.last_name ?? ''} ${
            student.first_name ?? ''
          }", в таблице "${textWithoutId}" (row ${rowIndex}).`
        );
      }
      studentIdToRow.set(student.id, rowIndex);
    }
  });

  const data: sheets_v4.Schema$ValueRange[] = [];
  const touchedRows = new Set<number>();

  for (const agg of aggregates) {
    const lastNameLower = agg.lastName.trim().toLowerCase();
    const firstNameLower = agg.firstName.trim().toLowerCase();
    if (!lastNameLower) continue;

    let rowIndex: number | undefined;

    // Сначала пробуем по ID.
    if (studentIdToRow.has(agg.studentId)) {
      rowIndex = studentIdToRow.get(agg.studentId);
    }
    // Если не нашли — fallback по ФИО.
    if (!rowIndex) {
      if (firstNameLower) {
        rowIndex = nameKeyToRow.get(`${lastNameLower}|${firstNameLower}`) ?? nameKeyToRow.get(`${lastNameLower}|`);
      } else {
        rowIndex = nameKeyToRow.get(`${lastNameLower}|`);
      }
    }
    if (!rowIndex) {
      mappingErrors.push(
        `[Planner] Sheet mapping: не найдена строка в таблице для студента "${agg.fullName}" (id=${agg.studentId}) за ${taskDate}.`
      );
      continue;
    }

    const tasksText = agg.tasks.map((t) => t.text).join('\n');

    data.push({
      range: `${sheetName}!${dayCols.textCol}${rowIndex}`,
      values: [[tasksText]],
    });
    data.push({
      range: `${sheetName}!${dayCols.resultCol}${rowIndex}`,
      values: [[agg.dayStatus]],
    });

    touchedRows.add(rowIndex);
  }

  if (!data.length) {
    console.warn('[Planner] writePlannerDay: no matching students in sheet for date', taskDate);
    if (mappingErrors.length) {
      console.error('[Planner] writePlannerDay: mapping issues:\n' + mappingErrors.join('\n'));
      try {
        await sendPlannerSheetAlert(mappingErrors);
      } catch (e) {
        console.error('[Planner] Failed to send planner sheet alert to admins:', e);
      }
    }
    return 0;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });

  // Форматирование: построчное зачёркивание только для задач со статусом completed.
  // Остальные задачи (partly_done) не зачёркиваются.
  const sheetId = await getSheetId(spreadsheetId, sheetName);
  if (sheetId == null) {
    console.warn('[Planner] writePlannerDay: cannot find sheetId for', sheetName);
    return touchedRows.size;
  }

  const textColIndex = colLetterToIndex(dayCols.textCol);

  const requests: sheets_v4.Schema$Request[] = [];

  for (const agg of aggregates) {
    const lastNameLower = agg.lastName.trim().toLowerCase();
    const firstNameLower = agg.firstName.trim().toLowerCase();
    if (!lastNameLower) continue;

    let rowIndex: number | undefined;
    if (studentIdToRow.has(agg.studentId)) {
      rowIndex = studentIdToRow.get(agg.studentId);
    }
    if (!rowIndex) {
      if (firstNameLower) {
        rowIndex = nameKeyToRow.get(`${lastNameLower}|${firstNameLower}`) ?? nameKeyToRow.get(`${lastNameLower}|`);
      } else {
        rowIndex = nameKeyToRow.get(`${lastNameLower}|`);
      }
    }
    if (!rowIndex) continue;

    const tasks = agg.tasks;
    if (!tasks.length) continue;

    const tasksText = tasks.map((t) => t.text).join('\n');
    const totalLength = tasksText.length;
    if (!totalLength) continue;

    // Вычисляем textFormatRuns по задачам: completed → strikethrough, partly_done → без форматирования.
    const textFormatRuns: sheets_v4.Schema$TextFormatRun[] = [];
    let offset = 0;
    for (const t of tasks) {
      const length = t.text.length;
      if (t.status === 'completed') {
        // Включаем зачёркивание на диапазон текста задачи.
        textFormatRuns.push({
          startIndex: offset,
          format: {
            strikethrough: true,
          },
        });
        const endIndex = offset + length;
        // Google Sheets требует, чтобы startIndex < длины строки.
        // Для последней задачи endIndex может быть ровно длиной строки — в этом случае
        // дополнительный "выключающий" ран не нужен.
        if (endIndex < totalLength) {
          textFormatRuns.push({
            startIndex: endIndex,
            format: {
              strikethrough: false,
            },
          });
        }
      }
      offset += length + 1; // +1 за символ перевода строки
    }

    // Если нет ни одного completed — форматирование не нужно.
    if (!textFormatRuns.length) continue;

    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: rowIndex - 1,
          endRowIndex: rowIndex,
          startColumnIndex: textColIndex,
          endColumnIndex: textColIndex + 1,
        },
        cell: {
          userEnteredValue: {
            stringValue: tasksText,
          },
          textFormatRuns,
        },
        fields: 'userEnteredValue.stringValue,textFormatRuns',
      },
    });
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  if (mappingErrors.length) {
    console.error('[Planner] writePlannerDay: mapping issues:\n' + mappingErrors.join('\n'));
    try {
      await sendPlannerSheetAlert(mappingErrors);
    } catch (e) {
      console.error('[Planner] Failed to send planner sheet alert to admins:', e);
    }
  }

    return touchedRows.size;
  } catch (e) {
    throw e;
  }
}

async function sendPlannerSheetAlert(messages: string[]): Promise<void> {
  if (!messages.length) return;
  const db = getDb();
  const admins = db
    .prepare('SELECT telegram_user_id FROM admins')
    .all() as Array<{ telegram_user_id: number }>;
  if (!admins.length) return;

  const config = getConfig();
  const token = config.BOT_TOKEN;
  if (!token) {
    console.warn('[Planner] Cannot send sheet alert: BOT_TOKEN is not set.');
    return;
  }

  const text =
    'Проблемы сопоставления студентов с строками Google-таблицы планера:\n\n' +
    messages.join('\n');

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (const a of admins) {
    try {
      // Node 18+ имеет глобальный fetch.
      // eslint-disable-next-line no-await-in-loop
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: a.telegram_user_id,
          text,
        }),
      } as any);
    } catch (e) {
      // Не прерываем остальные отправки.
      // eslint-disable-next-line no-console
      console.error('[Planner] Failed to send sheet alert to admin', a.telegram_user_id, e);
    }
  }
}

