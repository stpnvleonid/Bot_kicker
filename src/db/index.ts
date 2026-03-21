import fs from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { getConfig } from '../config';

let db: ReturnType<typeof Database> | null = null;

function getDbPath(): string {
  const url = getConfig().DATABASE_URL;
  if (url.startsWith('file:')) {
    return path.resolve(url.replace(/^file:/, ''));
  }
  throw new Error('Only SQLite file: URLs are supported in this version. Use file:./data/bot.sqlite');
}

export function getDb(): Database.Database {
  if (!db) {
    const file = getDbPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(file);
    // WAL + небольшой busy_timeout повышают устойчивость к параллельным операциям.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 3000'); // ждать до 3 секунд при SQLITE_BUSY
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
