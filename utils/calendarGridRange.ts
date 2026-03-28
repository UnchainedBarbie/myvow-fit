/** User-selectable first column of the calendar week (left = first day). */
export const FIRST_WEEKDAY_OPTIONS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type CalendarFirstWeekday = (typeof FIRST_WEEKDAY_OPTIONS)[number];

const DOW_BY_FIRST: Record<CalendarFirstWeekday, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

/** Default first column for the MyCalendar month grid (Sun–Sat week row). */
export const CALENDAR_GRID_FIRST_WEEKDAY: CalendarFirstWeekday = 'Sunday';

export function isCalendarFirstWeekday(s: string): s is CalendarFirstWeekday {
  return (FIRST_WEEKDAY_OPTIONS as readonly string[]).includes(s);
}

/** Days to subtract from the 1st of the month so the grid starts on `firstWeekday`. */
export function daysToSubtractForMonthGrid(
  firstOfMonthJsDay: number,
  firstWeekday: CalendarFirstWeekday,
): number {
  const target = DOW_BY_FIRST[firstWeekday];
  return (firstOfMonthJsDay - target + 7) % 7;
}

/** Short i18n keys Mon..Sun in calendar header order for the given first weekday. */
export function getWeekdayHeaderKeys(firstWeekday: CalendarFirstWeekday): string[] {
  const cycle = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const start = DOW_BY_FIRST[firstWeekday];
  return Array.from({ length: 7 }, (_, i) => cycle[(start + i) % 7]);
}

/**
 * Same 6×7 grid bounds as MyCalendar. Pass {@link CALENDAR_GRID_FIRST_WEEKDAY}
 * for the visible month grid; otherwise any weekday for custom ranges.
 */
export function getCalendarGridUnixRange(
  viewMonth: Date,
  firstWeekday: CalendarFirstWeekday,
): { startTimestamp: number; endTimestamp: number } {
  const firstDayOfMonth = new Date(
    viewMonth.getFullYear(),
    viewMonth.getMonth(),
    1,
  );
  const dayOfWeek = firstDayOfMonth.getDay();

  const daysToSubtract = daysToSubtractForMonthGrid(dayOfWeek, firstWeekday);

  const gridStartDate = new Date(firstDayOfMonth);
  gridStartDate.setDate(gridStartDate.getDate() - daysToSubtract);

  const gridEndDate = new Date(gridStartDate);
  gridEndDate.setDate(gridEndDate.getDate() + 41);

  const startTimestamp = Math.floor(gridStartDate.getTime() / 1000);
  const endTimestamp = Math.floor(gridEndDate.getTime() / 1000) + 86399;

  return { startTimestamp, endTimestamp };
}

/**
 * How many recurring "occurrence slots" to materialize so Workout_Log covers the
 * visible calendar grid through its last day (plus buffer). 52 was too low when
 * viewing months far ahead or for daily rules spanning a long grid.
 */
function unixLocalMidnight(tsSeconds: number): number {
  const d = new Date(tsSeconds * 1000);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000,
  );
}

export function recurringMaterializationIterationsForGridView(
  viewMonth: Date,
  firstWeekday: CalendarFirstWeekday,
): number {
  const { endTimestamp } = getCalendarGridUnixRange(viewMonth, firstWeekday);
  const todayMid = unixLocalMidnight(Math.floor(Date.now() / 1000));
  const spanSeconds = endTimestamp - todayMid;
  const spanDays = Math.ceil(spanSeconds / 86400);
  if (!Number.isFinite(spanDays)) return 200;

  // Daily rules need ~1 iteration per day in span; weekly needs fewer per iteration
  // but each iteration still advances the series — use a generous linear bound + margin.
  const fromSpan = spanDays * 2 + 60;
  return Math.min(1200, Math.max(150, fromSpan));
}
