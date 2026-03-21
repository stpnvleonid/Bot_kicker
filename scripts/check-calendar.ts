/**
 * Диагностика: почему calendar_events пустая.
 * Запуск: npx ts-node scripts/check-calendar.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../src/db';
import { getConfig } from '../src/config';
import { google } from 'googleapis';

async function main(): Promise<void> {
  console.log('=== Проверка календаря ===\n');

  // 1. Конфиг окружения
  try {
    const config = getConfig();
    console.log('1. Окружение:');
    console.log('   DATABASE_URL:', config.DATABASE_URL.replace(/file:/, ''));
    console.log('   GOOGLE_APPLICATION_CREDENTIALS:', config.GOOGLE_APPLICATION_CREDENTIALS || '(не задано)');
    if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log('\n   Ошибка: в .env должен быть GOOGLE_APPLICATION_CREDENTIALS (путь к JSON сервисного аккаунта).');
      return;
    }
    const keyPath = path.resolve(config.GOOGLE_APPLICATION_CREDENTIALS);
    if (!fs.existsSync(keyPath)) {
      console.log('\n   Ошибка: файл не найден:', keyPath);
      return;
    }
    console.log('   Файл ключа существует: да\n');
  } catch (e) {
    console.log('   Ошибка конфига:', e);
    return;
  }

  // 2. Записи в calendar_config
  const db = getDb();
  const configs = db.prepare(
    `SELECT id, calendar_id, name, enabled, sync_error, last_sync
     FROM calendar_config`
  ).all() as Array<{ id: number; calendar_id: string; name: string; enabled: number; sync_error: number; last_sync: string | null }>;

  console.log('2. Календари в БД (calendar_config):');
  if (configs.length === 0) {
    console.log('   Записей нет. Добавь календарь, например в sqlite3:');
    console.log('   INSERT INTO calendar_config (calendar_id, name, enabled) VALUES (\'твой_email@gmail.com\', \'Мой календарь\', 1);');
    console.log('   calendar_id = email календаря в Google Calendar (настройки календаря → интеграция).\n');
    return;
  }
  for (const c of configs) {
    console.log(`   id=${c.id} calendar_id="${c.calendar_id}" name="${c.name}" enabled=${c.enabled} sync_error=${c.sync_error} last_sync=${c.last_sync ?? 'никогда'}`);
  }

  const enabled = configs.filter((c) => c.enabled === 1);
  if (enabled.length === 0) {
    console.log('\n   Нет включённых календарей (enabled=1). Поставь enabled=1 для нужной записи.\n');
    return;
  }

  // 3. Тестовый запрос к Google API
  console.log('\n3. Тестовый запрос к Google Calendar API...');
  try {
    const config = getConfig();
    const auth = new google.auth.GoogleAuth({
      keyFile: path.resolve(config.GOOGLE_APPLICATION_CREDENTIALS!),
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const calId = enabled[0].calendar_id;
    const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

    const res = await calendar.events.list({
      calendarId: calId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 5,
    });

    const items = res.data.items ?? [];
    console.log('   Календарь:', calId);
    console.log('   Событий в окне (вчера — +60 дней):', items.length);
    if (items.length > 0) {
      console.log('   Примеры:');
      items.slice(0, 3).forEach((e) => {
        console.log('     -', e.summary || '(без названия)', e.start?.dateTime || e.start?.date);
      });
    } else {
      console.log('   В этом календаре нет событий в указанном окне — либо добавь события в Google Calendar, либо проверь calendar_id.');
    }
  } catch (err: unknown) {
    const e = err as { code?: number; message?: string };
    console.log('   Ошибка API:', e.message || err);
    if (e.code === 401 || e.code === 403) {
      console.log('   Проверь: 1) сервисный аккаунт добавлен в календарь (настройки календаря → доступ); 2) calendar_id совпадает с email календаря.');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
