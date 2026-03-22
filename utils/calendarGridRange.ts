import { unixLocalMidnight } from './recurringWorkoutUtils';

export type CalendarFirstWeekday = 'Sunday' | 'Monday';

/**
 * Same 6×7 grid bounds as MyCalendar (firstWeekday aligns week row with settings).
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

  const daysToSubtract =
    firstWeekday === 'Monday'
      ? dayOfWeek === 0
        ? 6
        : dayOfWeek - 1
      : dayOfWeek;

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
