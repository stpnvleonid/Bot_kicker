import { google, sheets_v4 } from 'googleapis';
import { getDb, closeDb } from '../src/db';
import { getConfig } from '../src/config';

type PlannerTask = {
  student_id: number;
  last_name: string;
  first_name: string;
  task_date: string;
  text: string;
  status: string;
};

type SheetMatch = {
  key: string;
  rowIndex: number;
  textCell: string;
  resultCell: string;
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

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  const config = getConfig();
  if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set for planner diagnose');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

function parseSheetName(range: string): string {
  const [sheetPart] = range.split('!');
  return sheetPart.replace(/^'/, '').replace(/'$/, '');
}

async function main(): Promise<void> {
  const argsDate = process.argv.find((a) => a.startsWith('--date='));
  if (!argsDate) {
    console.error('Укажите дату: --date=YYYY-MM-DD');
    process.exit(1);
  }
  const taskDate = argsDate.split('=')[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(taskDate)) {
    console.error('Неверный формат даты. Ожидаю YYYY-MM-DD');
    process.exit(1);
  }

  const db = getDb();
  const config = getConfig();

  const rows = db
    .prepare(
      `SELECT dt.student_id, dt.task_date, dt.text, dt.status,
              s.first_name, s.last_name
       FROM daily_tasks dt
       JOIN students s ON s.id = dt.student_id
       WHERE dt.task_date = ? AND dt.status IN ('completed','partly_done','cancelled')`
    )
    .all(taskDate) as PlannerTask[];

  if (!rows.length) {
    console.log('[Diagnose] В БД нет завершённых/частично/отменённых задач на дату', taskDate);
    closeDb();
    return;
  }

  console.log('[Diagnose] Найдено задач в daily_tasks:', rows.length);

  const spreadsheetId = config.PLANNER_SHEET_ID;
  const baseRange = config.PLANNER_SHEET_RANGE || 'Sheet1!A:D';
  if (!spreadsheetId) {
    console.error('[Diagnose] PLANNER_SHEET_ID не задан в .env');
    closeDb();
    process.exit(1);
  }

  const dayCols = getDayColumnLetters(taskDate);
  if (!dayCols) {
    console.error('[Diagnose] Дата попадает на выходной (сб/вс), dayCols не определены.');
    closeDb();
    process.exit(1);
  }

  const sheets = await getSheetsClient();
  const sheetName = parseSheetName(baseRange);

  // Читаем колонку A (ФИО)
  const fioRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:A`,
  });
  const fioValues = fioRes.data.values ?? [];

  const nameKeyToRow = new Map<string, number>();
  fioValues.forEach((row, idx) => {
    const raw = (row[0] ?? '').toString().trim();
    if (!raw) return;
    const parts = raw.split(/\s+/);
    const lastName = (parts[0] ?? '').trim().toLowerCase();
    if (!lastName) return;
    const firstName = (parts[1] ?? '').trim().toLowerCase();
    const rowIndex = idx + 2;

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
  });

  // Читаем текст задач и результат по столбцам дня
  const textCol = dayCols.textCol;
  const resultCol = dayCols.resultCol;

  const textRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${textCol}2:${textCol}`,
  });
  const resultRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!${resultCol}2:${resultCol}`,
  });

  const textValues = textRes.data.values ?? [];
  const resultValues = resultRes.data.values ?? [];

  const sheetMatches = new Map<string, SheetMatch>();
  nameKeyToRow.forEach((rowIndex, key) => {
    const textCell = (textValues[rowIndex - 2]?.[0] ?? '').toString();
    const resultCell = (resultValues[rowIndex - 2]?.[0] ?? '').toString();
    sheetMatches.set(key, {
      key,
      rowIndex,
      textCell,
      resultCell,
    });
  });

  const byStudent = new Map<
    number,
    {
      lastName: string;
      firstName: string;
      tasks: PlannerTask[];
    }
  >();

  for (const r of rows) {
    const lastName = (r.last_name ?? '').trim();
    const firstName = (r.first_name ?? '').trim();
    let entry = byStudent.get(r.student_id);
    if (!entry) {
      entry = { lastName, firstName, tasks: [] };
      byStudent.set(r.student_id, entry);
    }
    entry.tasks.push(r);
  }

  const problems: string[] = [];
  const ok: string[] = [];

  for (const { lastName, firstName, tasks } of byStudent.values()) {
    const lastNameLower = lastName.trim().toLowerCase();
    const firstNameLower = firstName.trim().toLowerCase();
    if (!lastNameLower) {
      problems.push(
        `Студент "${firstName}" без фамилии в БД — не с чем сопоставить строку в таблице. Задач: ${tasks.length}`
      );
      continue;
    }

    let match: SheetMatch | undefined;
    if (firstNameLower) {
      match =
        sheetMatches.get(`${lastNameLower}|${firstNameLower}`) ??
        sheetMatches.get(`${lastNameLower}|`);
    } else {
      match = sheetMatches.get(`${lastNameLower}|`);
    }
    if (!match) {
      problems.push(
        `Фамилия "${lastName}" (студент "${firstName}") не найдена в колонке A таблицы. Задач: ${tasks.length}`
      );
      continue;
    }

    const tasksText = tasks.map((t) => t.text).join('\n');
    const hasPartly = tasks.some((t) => t.status === 'partly_done');
    const allCompleted = tasks.length > 0 && tasks.every((t) => t.status === 'completed');
    const hasCompleted = tasks.some((t) => t.status === 'completed');

    let dayStatus = 'Не сделано';
    if (hasPartly) {
      dayStatus = 'Частично';
    } else if (hasCompleted) {
      dayStatus = 'Сделано';
    }

    const textOk = match.textCell.trim() === tasksText.trim();
    const resultOk = match.resultCell.trim() === dayStatus.trim();

    if (textOk && resultOk) {
      ok.push(`OK: ${lastName} ${firstName} (row ${match.rowIndex}) — данные совпадают.`);
    } else {
      problems.push(
        [
          `Расхождение для "${lastName} ${firstName}" (row ${match.rowIndex}):`,
          `  Ожидаемый текст задач:\n${tasksText || '(пусто)'}`,
          `  В таблице:\n${match.textCell || '(пусто)'}`,
          `  Ожидаемый результат: ${dayStatus || '(пусто)'}`,
          `  В таблице: ${match.resultCell || '(пусто)'}`,
        ].join('\n')
      );
    }
  }

  console.log('=== Диагностика экспорта планера ===');
  console.log('Дата:', taskDate);
  console.log('Всего задач в БД:', rows.length);
  console.log('Всего студентов с задачами:', byStudent.size);
  console.log('Найдено фамилий в таблице:', sheetMatches.size);
  console.log('');

  if (ok.length) {
    console.log('Совпадения (OK):');
    ok.forEach((line) => console.log(' -', line));
    console.log('');
  }

  if (problems.length) {
    console.log('Проблемы:');
    problems.forEach((line) => console.log('\n*', line));
  } else {
    console.log('Проблем не обнаружено: все задачи корректно отражены в таблице.');
  }

  closeDb();
}

main().catch((e) => {
  console.error('[Diagnose] Fatal error:', e);
  process.exit(1);
});

