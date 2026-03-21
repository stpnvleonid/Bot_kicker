const PLANNER_TZ = 'Europe/Moscow';

export function getMoscowIsoDateFromIso(iso: string): string {
  // Вытаскиваем календарную дату в "московском" времени (без привязки к локальной зоне сервера).
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: PLANNER_TZ });
}

export function getWeekRangeMonSat(dateIso: string): { weekStart: string; weekEnd: string } {
  // dateIso: YYYY-MM-DD (интерпретируем как UTC-день).
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const day = d.getUTCDay(); // 0=Sunday..6=Saturday
  const daysSinceMonday = (day + 6) % 7;
  const monday = new Date(d.getTime() - daysSinceMonday * 86400000);
  const saturday = new Date(monday.getTime() + 5 * 86400000);
  return {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: saturday.toISOString().slice(0, 10),
  };
}

export function formatRuShortDate(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}`;
}

