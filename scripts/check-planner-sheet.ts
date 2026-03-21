/**
 * Проверка доступа сервисного аккаунта к таблице планера (PLANNER_SHEET_ID / PLANNER_SHEET_RANGE).
 * Запуск: npx ts-node scripts/check-planner-sheet.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/config';
import { google } from 'googleapis';

function parseSheetTitleFromRange(range: string): string {
  const [sheetPart] = range.split('!');
  return sheetPart.replace(/^'/, '').replace(/'$/, '').trim();
}

async function main(): Promise<void> {
  console.log('=== Проверка Google Таблицы (планер) ===\n');

  const config = getConfig();
  if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log('Ошибка: GOOGLE_APPLICATION_CREDENTIALS не задан.');
    process.exit(1);
  }
  const keyPath = path.resolve(config.GOOGLE_APPLICATION_CREDENTIALS);
  if (!fs.existsSync(keyPath)) {
    console.log('Ошибка: файл ключа не найден:', keyPath);
    process.exit(1);
  }

  const spreadsheetId = config.PLANNER_SHEET_ID?.trim();
  const range = (config.PLANNER_SHEET_RANGE || 'Sheet1!A:D').trim();
  if (!spreadsheetId) {
    console.log('Ошибка: PLANNER_SHEET_ID не задан.');
    process.exit(1);
  }

  console.log('PLANNER_SHEET_ID:', spreadsheetId);
  console.log('PLANNER_SHEET_RANGE:', range);
  const sheetTitle = parseSheetTitleFromRange(range);
  console.log('Имя листа из range:', JSON.stringify(sheetTitle));
  console.log('');

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const resp = await sheets.spreadsheets.get({ spreadsheetId });
    const titles = (resp.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter(Boolean) as string[];
    console.log('Таблица доступна. Листы:', titles.length ? titles.join(', ') : '(нет)');

    const found = titles.includes(sheetTitle);
    if (found) {
      console.log('\nOK: лист', JSON.stringify(sheetTitle), 'найден.');
    } else {
      console.log('\nВНИМАНИЕ: лист с именем', JSON.stringify(sheetTitle), 'не найден среди листов таблицы.');
      console.log('Проверь PLANNER_SHEET_RANGE (имя листа до символа !).');
      process.exit(1);
    }
  } catch (e: unknown) {
    const err = e as { message?: string; code?: number };
    console.error('Ошибка API:', err.message ?? e);
    process.exit(1);
  }
}

main();
