const MONTHS: Array<{ month: number; keys: string[] }> = [
  { month: 1, keys: ['янв', 'январ', 'январь', 'января'] },
  { month: 2, keys: ['февр', 'феврал', 'февраля'] },
  { month: 3, keys: ['мар', 'марта'] },
  { month: 4, keys: ['апр', 'апрел', 'апреля'] },
  { month: 5, keys: ['май', 'мая'] },
  { month: 6, keys: ['июн', 'июня'] },
  { month: 7, keys: ['июл', 'июля'] },
  { month: 8, keys: ['авг', 'августа', 'август'] },
  { month: 9, keys: ['сен', 'сент', 'сентябр', 'сентября'] },
  { month: 10, keys: ['окт', 'октябр', 'октября'] },
  { month: 11, keys: ['ноя', 'ноябр', 'ноября'] },
  { month: 12, keys: ['дек', 'декабр', 'декабря'] },
];

function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/,/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim();
}

function inferYearForDdMm(mm: number, dd: number, referenceDate: Date): number {
  // Год инферим как "самая близкая" дата (±1 год), относительно referenceDate в календарной логике.
  const refDateIso = referenceDate.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const ref = new Date(`${refDateIso}T00:00:00.000Z`);
  const candidates = [ref.getUTCFullYear() - 1, ref.getUTCFullYear(), ref.getUTCFullYear() + 1].map((y) => new Date(Date.UTC(y, mm - 1, dd)));
  let best = candidates[0];
  let bestAbs = Math.abs(best.getTime() - ref.getTime());
  for (const c of candidates) {
    const abs = Math.abs(c.getTime() - ref.getTime());
    if (abs < bestAbs) {
      best = c;
      bestAbs = abs;
    }
  }
  return best.getUTCFullYear();
}

export function parseRuDdMmToIso(input: string, referenceDate: Date = new Date()): string | null {
  // Принимаем форматы:
  // - "07 03", "7 3"
  // - "07 марта", "7 мар", "7марта"
  // Возвращаем ISO-дату YYYY-MM-DD (в "год инференс" через ±1 год относительно referenceDate).
  if (!input) return null;
  const norm = normalizeToken(input);
  const parts = norm.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;

  const d = parseInt(parts[0], 10);
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;

  const mToken = parts.slice(1).join(' ');
  const mDigits = parseInt(mToken, 10);
  let m: number | null = null;
  if (Number.isFinite(mDigits) && mDigits >= 1 && mDigits <= 12) {
    m = mDigits;
  } else {
    const mNorm = normalizeToken(mToken);
    for (const mm of MONTHS) {
      if (mm.keys.some((k) => mNorm.startsWith(k) || mNorm === k)) {
        m = mm.month;
        break;
      }
    }
  }
  if (!m) return null;

  const y = inferYearForDdMm(m, d, referenceDate);
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  // Проверяем валидность даты (например "31 апреля").
  const dt = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const checkY = dt.getUTCFullYear();
  const checkM = dt.getUTCMonth() + 1;
  const checkD = dt.getUTCDate();
  if (checkY !== y || checkM !== m || checkD !== d) return null;

  return iso;
}

/**
 * Ищет дату в подписи к фото: целиком, по строкам, или как пару соседних токенов (например «ДЗ 07 03»).
 */
export function parseRuDateFromCaption(raw: string | null | undefined, referenceDate: Date = new Date()): string | null {
  if (!raw || !String(raw).trim()) return null;
  const full = String(raw).trim();

  let iso = parseRuDdMmToIso(full, referenceDate);
  if (iso) return iso;

  for (const line of full.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    iso = parseRuDdMmToIso(t, referenceDate);
    if (iso) return iso;
  }

  const norm = normalizeToken(full);
  const tokens = norm.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i++) {
    const candidate = `${tokens[i]} ${tokens[i + 1]}`;
    iso = parseRuDdMmToIso(candidate, referenceDate);
    if (iso) return iso;
  }

  return null;
}
