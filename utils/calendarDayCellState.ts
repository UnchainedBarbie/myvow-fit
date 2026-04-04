/**
 * Single source of truth for calendar day cell workout UI state (My Calendar grid).
 */

export type CalendarDayWorkoutState =
  | 'empty'
  | 'logged'
  | 'missed'
  | 'scheduled';

export interface CalendarDayCellModel {
  workoutState: CalendarDayWorkoutState;
  isToday: boolean;
  isCurrentMonth: boolean;
}

export function deriveCalendarDayCellModel(input: {
  hasWorkouts: boolean;
  isAnyLogged: boolean;
  isPast: boolean;
  isFuture: boolean;
  isToday: boolean;
  isCurrentMonth: boolean;
}): CalendarDayCellModel {
  const { hasWorkouts, isAnyLogged, isPast, isFuture, isToday, isCurrentMonth } =
    input;

  let workoutState: CalendarDayWorkoutState = 'empty';
  if (hasWorkouts) {
    if (isAnyLogged) workoutState = 'logged';
    else if (isPast) workoutState = 'missed';
    else if (isFuture) workoutState = 'scheduled';
    else if (isToday) workoutState = 'scheduled';
  }

  return {
    workoutState,
    isToday,
    isCurrentMonth,
  };
}
