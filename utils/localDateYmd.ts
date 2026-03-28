/**
 * Local calendar dates as YYYY-MM-DD strings.
 * Use these for SQLite TEXT columns that store a calendar day (e.g. check_in_date, log_date),
 * not `Date.toISOString().slice(0, 10)` which is UTC and mismatches local "today".
 */

export function formatLocalYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localTodayYmd(now: Date = new Date()): string {
  return formatLocalYmd(now);
}

/** Monday through Sunday of the calendar week containing `now`, inclusive (local timezone). */
export function getLocalWeekMondaySundayYmd(now: Date = new Date()): {
  weekStartYmd: string;
  weekEndYmd: string;
} {
  const dow = now.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return {
    weekStartYmd: formatLocalYmd(monday),
    weekEndYmd: formatLocalYmd(sunday),
  };
}
