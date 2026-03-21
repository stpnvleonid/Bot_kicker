import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './index';

/** Для существующих БД: убрать legacy-колонки (в новой схеме 001 их уже нет). */
function applyDropEventTypeColumns(db: ReturnType<typeof getDb>): void {
  const studentCols = db.prepare('PRAGMA table_info(students)').all() as Array<{ name: string }>;
  if (studentCols.some((c) => c.name === 'notify_event_types')) {
    db.exec('ALTER TABLE students DROP COLUMN notify_event_types');
  }
  const ceCols = db.prepare('PRAGMA table_info(calendar_events)').all() as Array<{ name: string }>;
  if (ceCols.some((c) => c.name === 'event_type')) {
    db.exec('ALTER TABLE calendar_events DROP COLUMN event_type');
  }
}

export function runMigrations(): void {
  const db = getDb();
  const migrationsDir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);

  const rows = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    const name = file;
    if (applied.has(name)) continue;
    if (name === '010_drop_event_type_columns.sql') {
      applyDropEventTypeColumns(db);
    } else {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      db.exec(sql);
    }
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    console.log('Applied migration:', name);
  }
}

if (require.main === module) {
  runMigrations();
}
