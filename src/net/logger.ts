import fs from 'node:fs';
import path from 'node:path';

type LogLevel = 'info' | 'warn' | 'error';

type LoggerEntry = {
  level: LogLevel;
  ts: string;
  pid?: number;
  msg: string;
  meta?: Record<string, unknown>;
  err?: {
    name?: string;
    message?: string;
    stack?: string;
    code?: unknown;
    errno?: unknown;
  };
};

let initialized = false;

function getLogDir(): string {
  return path.resolve(process.cwd(), 'logs');
}

function ensureLogDir(): void {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatDateForFile(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getLogFilePath(d: Date): string {
  return path.join(getLogDir(), `bot-${formatDateForFile(d)}.log`);
}

function rotateIfNeeded(filePath: string, maxBytes: number, maxFiles: number): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const st = fs.statSync(filePath);
    if (st.size < maxBytes) return;

    // bot-YYYY-MM-DD.log -> bot-YYYY-MM-DD.log.1 (и сдвиг назад)
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    const first = `${filePath}.1`;
    if (fs.existsSync(first)) fs.unlinkSync(first);
    fs.renameSync(filePath, first);
  } catch {
    // Если ротация не удалась — продолжаем писать в текущий файл.
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || value.name;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractError(err: unknown): LoggerEntry['err'] | undefined {
  if (!err) return undefined;
  const e = err as any;
  if (e instanceof Error) {
    const anyErr = e as any;
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      code: anyErr.code,
      errno: anyErr.errno,
    };
  }
  if (typeof e === 'object') {
    const msg = typeof e.message === 'string' ? e.message : undefined;
    const stack = typeof e.stack === 'string' ? e.stack : undefined;
    return {
      name: typeof e.name === 'string' ? e.name : undefined,
      message: msg,
      stack,
      code: e.code,
      errno: e.errno,
    };
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseKeyValuePairsFromString(input: string): Record<string, unknown> | null {
  // Пример: from_id=123 username=@abc
  // Пример с пробелами в значении: text="hello world"
  const out: Record<string, unknown> = {};
  const re = /(\w+)=(".*?"|\S+)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(input))) {
    const key = m[1];
    let raw = m[2];
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    out[key] = raw;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeArgs(
  args: unknown[]
): { msg: string; meta?: Record<string, unknown>; err?: LoggerEntry['err'] } {
  let err: LoggerEntry['err'] | undefined;
  const meta: Record<string, unknown> = {};

  // Если первый аргумент — строка, используем её как msg (часто это префикс вида "[Job2] ...").
  const firstString = typeof args[0] === 'string' ? (args[0] as string) : null;

  const msg = firstString ? firstString : safeStringify(args[0]);

  // Из msg попробуем достать "job" из префикса: [Job2] / [Startup] ...
  const jobMatch = msg.match(/^\[(.*?)\]\s*/);
  if (jobMatch?.[1]) meta.job = jobMatch[1];

  // Если первая строка тоже содержит key=value — извлечём и их.
  if (typeof msg === 'string' && msg.includes('=')) {
    const pairs = parseKeyValuePairsFromString(msg);
    if (pairs) Object.assign(meta, pairs);
  }

  if (typeof msg === 'string' && !meta.job) {
    // Пример: "Job3:" / "Worker:" / "Planner:".
    const colonJobMatch = msg.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:/);
    if (colonJobMatch?.[1]) meta.job = colonJobMatch[1];
  }

  if (typeof msg === 'string') {
    const lower = msg.toLowerCase();
    if (lower.includes('skipped')) meta.action = 'skipped';
    else if (lower.includes('fatal')) meta.action = 'fatal';
    else if (lower.includes('done')) meta.action = 'done';
  }

  const fragments: string[] = [];
  const values: Array<{ i: number; v: unknown }> = [];

  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a instanceof Error) {
      err = extractError(a);
      continue;
    }
    if (isPlainObject(a)) {
      Object.assign(meta, a);
      continue;
    }
    if (typeof a === 'string') {
      const pairs = parseKeyValuePairsFromString(a);
      if (pairs) Object.assign(meta, pairs);
      else fragments.push(a);
      continue;
    }
    values.push({ i, v: a });
  }

  if (fragments.length) meta.fragments = fragments;
  if (values.length) meta.values = values.map((x) => x.v);

  // Дешёвые маппинги по ключевым фразам, чтобы метки получались осмысленнее.
  if (typeof msg === 'string') {
    const lower = msg.toLowerCase();
    const firstValue = values.length ? values[0].v : undefined;
    if (lower.includes('task error')) {
      if (typeof firstValue === 'number') meta.task_id = firstValue;
    } else if (lower.includes('error syncing calendar') || lower.includes('error syncing') || lower.includes('error syncing calendar')) {
      if (firstValue !== undefined) meta.calendar_id = firstValue;
    }
  }

  return { msg, meta: Object.keys(meta).length ? meta : undefined, err };
}

function writeEntry(entry: LoggerEntry): void {
  ensureLogDir();
  const now = new Date();
  const filePath = getLogFilePath(now);
  const MAX_BYTES = 5 * 1024 * 1024; // 5MB
  const MAX_FILES = 7;
  rotateIfNeeded(filePath, MAX_BYTES, MAX_FILES);
  const line = JSON.stringify(entry);
  fs.appendFileSync(filePath, line + '\n', { encoding: 'utf8' });
}

export function initLogger(): void {
  if (initialized) return;
  initialized = true;

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  const wrap =
    (level: LogLevel, original: (...args: any[]) => void) =>
    (...args: unknown[]): void => {
      // Не ломаем stdout — оставляем привычный вывод в консоль.
      original(...args as any);

      try {
        const { msg, meta, err } = normalizeArgs(args);
        const entry: LoggerEntry = {
          level,
          ts: new Date().toISOString(),
          pid: process.pid,
          msg,
          meta,
          err,
        };
        writeEntry(entry);
      } catch {
        // Игнорируем ошибки логирования, чтобы не валить бот.
      }
    };

  console.log = wrap('info', originalLog) as any;
  console.warn = wrap('warn', originalWarn) as any;
  console.error = wrap('error', originalError) as any;
}

