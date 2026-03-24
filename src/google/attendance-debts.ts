import { google, sheets_v4 } from 'googleapis';
import { getConfig } from '../config';
import { getDb } from '../db';

type StudentRow = {
  studentName: string;
  cells: string[];
};

type ParsedSubjectRows = {
  students: StudentRow[];
  columnLabels: Map<number, string>;
};

export type StudentDebtItem = {
  assignment: string;
  rawValue: string;
};

export type StudentDebt = {
  studentId: number;
  fullName: string;
  telegramUsername: string | null;
  debts: StudentDebtItem[];
  /** false — ученик есть в БД, но не выбрал этот предмет в /subjects (раньше из‑за этого строка могла не сопоставляться). */
  hasSubjectInBot: boolean;
};

export type SubjectDebtResult = {
  subjectKey: string;
  subjectLabel: string;
  students: StudentDebt[];
  stats: {
    totalRows: number;
    matchedRows: number;
    unmatchedRows: number;
    totalDebts: number;
    /** Сопоставлены по ФИО, но в /subjects нет этого предмета. */
    matchedWithoutSubjectInBot: number;
  };
};

const SHEET_SUBJECT_ALIASES: Record<string, string> = {
  russian: 'Русский язык',
  physics: 'Физика',
  society: 'Обществознание',
  informatics: 'Информатика',
  english: 'Английский',
  math: 'Математика',
  math_profile: 'Математика',
  math_base: 'Математика',
};

/** Ключи для кнопок «Долги» в админ-меню (по одному на блок в «Посещаемости»). */
export const DEBTS_MENU_SUBJECT_KEYS = [
  'russian',
  'physics',
  'society',
  'informatics',
  'english',
  'math',
] as const;

const DEBT_STATUS = 'не сдал';

let sheetsClient: sheets_v4.Sheets | null = null;

async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (sheetsClient) return sheetsClient;
  const config = getConfig();
  if (!config.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not set for attendance debts');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: config.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function normalizeCell(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim();
}

function normalizeName(v: string): string {
  return v
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,;:!?'"`()[\]{}<>/\\|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitNameTokens(v: string): string[] {
  return normalizeName(v)
    .split(' ')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Из ФИО в таблице берём только фамилию и имя (первые два слова), отчество не участвует в сверке с БД.
 */
function sheetLastFirstForMatch(sheetFullName: string): { last: string; first: string } | null {
  const raw = sheetFullName.replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { last: parts[0], first: '' };
  return { last: parts[0], first: parts[1] };
}

function looksLikeSubjectRow(row: string[]): boolean {
  const c0 = normalizeCell(row[0]);
  const c1 = normalizeCell(row[1]);
  if (c0 !== '' || c1 === '') return false;
  const lowered = c1.toLowerCase();
  return lowered !== 'дата' && lowered !== 'фио / дисциплина и формат';
}

function isHeaderDateRow(row: string[]): boolean {
  return normalizeCell(row[0]).toLowerCase() === 'дата';
}

function isHeaderFormatRow(row: string[]): boolean {
  return normalizeCell(row[0]).toLowerCase() === 'фио / дисциплина и формат';
}

function isSummaryStartRow(row: string[]): boolean {
  return normalizeCell(row[0]) === '' &&
    normalizeCell(row[1]) === '' &&
    normalizeCell(row[2]).toLowerCase() === 'посещаемость / сдача (%)';
}

function isStudentRow(row: string[]): boolean {
  const fio = normalizeCell(row[0]);
  if (!fio) return false;
  if (fio.toLowerCase() === 'дата' || fio.toLowerCase() === 'фио / дисциплина и формат') return false;
  return true;
}

function resolveSubjectHeaderForSheet(subjectKey: string): string | null {
  return SHEET_SUBJECT_ALIASES[subjectKey] ?? null;
}

function subjectMatches(requestedHeader: string, rowHeader: string): boolean {
  const req = normalizeName(requestedHeader);
  const got = normalizeName(rowHeader);
  return got === req || got.startsWith(req);
}

function buildColumnLabel(dateCell: string, formatCell: string, colIndex: number): string {
  const date = normalizeCell(dateCell);
  const format = normalizeCell(formatCell);
  if (date && format) return `${format} — ${date}`;
  if (format) return format;
  if (date) return date;
  return `Колонка ${colIndex + 1}`;
}

function parseSubjectRows(rows: string[][], requestedSubjectHeader: string): ParsedSubjectRows {
  let inTargetSubject = false;
  let hasDateHeader = false;
  let hasFormatHeader = false;
  let readingStudents = false;
  const students: StudentRow[] = [];
  let dateHeaderRow: string[] = [];
  let formatHeaderRow: string[] = [];
  const columnLabels = new Map<number, string>();

  for (const rawRow of rows) {
    const row = rawRow.map(normalizeCell);
    if (looksLikeSubjectRow(row)) {
      const rowSubject = normalizeCell(row[1]);
      inTargetSubject = subjectMatches(requestedSubjectHeader, rowSubject);
      hasDateHeader = false;
      hasFormatHeader = false;
      readingStudents = false;
      dateHeaderRow = [];
      formatHeaderRow = [];
      columnLabels.clear();
      continue;
    }
    if (!inTargetSubject) continue;
    if (!hasDateHeader) {
      if (isHeaderDateRow(row)) {
        hasDateHeader = true;
        dateHeaderRow = row;
      }
      continue;
    }
    if (!hasFormatHeader) {
      if (isHeaderFormatRow(row)) {
        hasFormatHeader = true;
        readingStudents = true;
        formatHeaderRow = row;
        const maxLen = Math.max(dateHeaderRow.length, formatHeaderRow.length);
        for (let i = 3; i < maxLen; i += 1) {
          const label = buildColumnLabel(dateHeaderRow[i] ?? '', formatHeaderRow[i] ?? '', i);
          columnLabels.set(i, label);
        }
      }
      continue;
    }
    if (!readingStudents) continue;
    if (isSummaryStartRow(row)) {
      break;
    }
    if (!isStudentRow(row)) {
      continue;
    }
    students.push({
      studentName: normalizeCell(row[0]),
      cells: row,
    });
  }

  return { students, columnLabels };
}

function extractDebtsFromStudentRow(row: StudentRow, columnLabels: Map<number, string>): StudentDebtItem[] {
  const debts: StudentDebtItem[] = [];
  for (let i = 3; i < row.cells.length; i += 1) {
    const value = normalizeCell(row.cells[i]);
    if (!value) continue;
    if (value.toLowerCase() !== DEBT_STATUS) continue;
    debts.push({
      assignment: columnLabels.get(i) ?? `Колонка ${i + 1}`,
      rawValue: value,
    });
  }
  return debts;
}

type DbStudent = {
  id: number;
  first_name: string;
  last_name: string;
  telegram_username: string | null;
};

function scoreCandidate(sheetTokens: string[], dbTokens: string[]): number {
  if (sheetTokens.length === 0 || dbTokens.length === 0) return 0;
  const minLen = Math.min(sheetTokens.length, dbTokens.length);
  let matched = 0;
  for (let i = 0; i < minLen; i += 1) {
    if (sheetTokens[i] === dbTokens[i]) matched += 1;
  }
  return matched / Math.max(sheetTokens.length, dbTokens.length);
}

function normalizedDbFullNameVariants(s: DbStudent): string[] {
  const last = (s.last_name ?? '').trim();
  const first = (s.first_name ?? '').trim();
  const forward = normalizeName(`${last} ${first}`.trim());
  const swapped = normalizeName(`${first} ${last}`.trim());
  if (forward && swapped && forward !== swapped) return [forward, swapped];
  if (forward) return [forward];
  if (swapped) return [swapped];
  return [];
}

function matchStudentByFio(sheetName: string, students: DbStudent[]): DbStudent | null {
  const parts = sheetLastFirstForMatch(sheetName);
  if (!parts) return null;
  const { last: sLast, first: sFirst } = parts;

  const sheetNormFull = normalizeName(sFirst ? `${sLast} ${sFirst}` : sLast);
  if (!sheetNormFull) return null;

  const exact = students.find((s) => normalizedDbFullNameVariants(s).some((v) => v === sheetNormFull));
  if (exact) return exact;

  const sheetTokens = sFirst
    ? splitNameTokens(`${sLast} ${sFirst}`)
    : splitNameTokens(sLast);

  let best: DbStudent | null = null;
  let bestScore = 0;
  let secondScore = 0;
  for (const s of students) {
    const dbForward = splitNameTokens(`${s.last_name} ${s.first_name}`);
    const dbSwapped = splitNameTokens(`${s.first_name} ${s.last_name}`);
    const score = Math.max(scoreCandidate(sheetTokens, dbForward), scoreCandidate(sheetTokens, dbSwapped));
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = s;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (!best) return null;

  const uniqueWinner = secondScore === 0;
  const margin = bestScore - secondScore;
  if (uniqueWinner && bestScore >= 0.65) return best;
  if (bestScore >= 0.75 && margin >= 0.2) return best;
  if (bestScore >= 0.85 && margin >= 0.12) return best;
  return null;
}

export async function getAttendanceDebtsBySubject(subjectKey: string, subjectLabel: string): Promise<SubjectDebtResult> {
  const config = getConfig();
  const spreadsheetId = config.ATTENDANCE_SHEET_ID || config.PLANNER_SHEET_ID;
  const tabName = config.ATTENDANCE_SHEET_TAB || 'Посещаемость';
  if (!spreadsheetId || !spreadsheetId.trim()) {
    throw new Error('ATTENDANCE_SHEET_ID is not set');
  }
  const subjectHeader = resolveSubjectHeaderForSheet(subjectKey);
  if (!subjectHeader) {
    throw new Error(`Subject key is not supported for attendance parser: ${subjectKey}`);
  }

  const sheets = await getSheetsClient();
  const range = `'${tabName}'!A:ZZ`;
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const values = (resp.data.values ?? []).map((row) => row.map(normalizeCell));
  const parsed = parseSubjectRows(values, subjectHeader);
  const parsedRows = parsed.students;

  const db = getDb();
  // Сверяем ФИО со всеми учениками в БД. Ограничение только по /subjects раньше отрезало тех, кто не нажал предмет — они «не сопоставлялись».
  const dbStudents = db
    .prepare(`SELECT id, first_name, last_name, telegram_username FROM students`)
    .all() as DbStudent[];

  const subjectStudentIds = new Set(
    (
      db.prepare(`SELECT student_id FROM student_subjects WHERE subject_key = ?`).all(subjectKey) as Array<{
        student_id: number;
      }>
    ).map((r) => r.student_id)
  );

  const byStudent = new Map<number, StudentDebt>();
  let unmatchedRows = 0;
  let totalDebts = 0;

  for (const row of parsedRows) {
    const debts = extractDebtsFromStudentRow(row, parsed.columnLabels);
    if (debts.length === 0) continue;
    const matched = matchStudentByFio(row.studentName, dbStudents);
    if (!matched) {
      unmatchedRows += 1;
      continue;
    }
    totalDebts += debts.length;
    const hasSubjectInBot = subjectStudentIds.has(matched.id);
    const existing = byStudent.get(matched.id);
    if (existing) {
      existing.debts.push(...debts);
      continue;
    }
    byStudent.set(matched.id, {
      studentId: matched.id,
      fullName: `${matched.last_name} ${matched.first_name}`.trim(),
      telegramUsername: matched.telegram_username,
      debts: [...debts],
      hasSubjectInBot,
    });
  }

  const students = Array.from(byStudent.values()).sort((a, b) => b.debts.length - a.debts.length || a.fullName.localeCompare(b.fullName, 'ru'));
  const matchedWithoutSubjectInBot = students.filter((s) => !s.hasSubjectInBot).length;
  return {
    subjectKey,
    subjectLabel,
    students,
    stats: {
      totalRows: parsedRows.length,
      matchedRows: students.length,
      unmatchedRows,
      totalDebts,
      matchedWithoutSubjectInBot,
    },
  };
}
