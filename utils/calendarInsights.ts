import type { SQLiteDatabase } from 'expo-sqlite';

export interface CalendarInsights {
  streakDays: number;
  weekCompleted: number;
  weekScheduled: number;
  nextWorkoutLabel: string | null;
  nextWorkoutDate: Date | null;
}

function localMidnightTs(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor(x.getTime() / 1000);
}

/** Consecutive calendar days ending today with at least one logged workout each day. */
export async function computeWorkoutStreak(
  db: Pick<SQLiteDatabase, 'getAllAsync'>,
): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let streak = 0;
  for (let i = 0; i < 120; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const start = localMidnightTs(d);
    const end = start + 86399;
    const rows = await db.getAllAsync<{ c: number }>(
      `SELECT COUNT(*) as c FROM Workout_Log wl
       WHERE wl.workout_date BETWEEN ? AND ?
       AND EXISTS (SELECT 1 FROM Weight_Log w WHERE w.workout_log_id = wl.workout_log_id);`,
      [start, end],
    );
    const c = Number(rows[0]?.c ?? 0);
    if (c > 0) streak += 1;
    else break;
  }
  return streak;
}

/** Sunday–Saturday week containing `reference` (local). */
export function getLocalWeekRange(reference: Date): {
  startTs: number;
  endTs: number;
} {
  const ref = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
  );
  const day = ref.getDay();
  const sunday = new Date(ref);
  sunday.setDate(ref.getDate() - day);
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);
  const startTs = localMidnightTs(sunday);
  const endTs = localMidnightTs(saturday) + 86399;
  return { startTs, endTs };
}

export async function computeWeeklyCompletion(
  db: Pick<SQLiteDatabase, 'getAllAsync'>,
  reference: Date = new Date(),
): Promise<{ completed: number; scheduled: number }> {
  const { startTs, endTs } = getLocalWeekRange(reference);
  const logs = await db.getAllAsync<{ workout_log_id: number }>(
    `SELECT workout_log_id FROM Workout_Log WHERE workout_date BETWEEN ? AND ?;`,
    [startTs, endTs],
  );
  const scheduled = logs.length;
  if (scheduled === 0) return { completed: 0, scheduled: 0 };

  const ids = logs.map((r) => r.workout_log_id);
  const placeholders = ids.map(() => '?').join(',');
  const done = await db.getAllAsync<{ c: number }>(
    `SELECT COUNT(DISTINCT workout_log_id) as c FROM Weight_Log WHERE workout_log_id IN (${placeholders});`,
    ids,
  );
  const completed = Number(done[0]?.c ?? 0);
  return { completed, scheduled };
}

export async function findNextUnloggedScheduledWorkout(
  db: Pick<SQLiteDatabase, 'getAllAsync'>,
  reference: Date = new Date(),
): Promise<{ workout_name: string; day_name: string; workout_date: number } | null> {
  const start = localMidnightTs(reference);
  const rows = await db.getAllAsync<{
    workout_name: string;
    day_name: string;
    workout_date: number;
    workout_log_id: number;
  }>(
    `SELECT wl.workout_name, wl.day_name, wl.workout_date, wl.workout_log_id
     FROM Workout_Log wl
     WHERE wl.workout_date >= ?
     ORDER BY wl.workout_date ASC, wl.workout_log_id ASC
     LIMIT 40;`,
    [start],
  );
  for (const row of rows) {
    const hit = await db.getAllAsync<{ n: number }>(
      `SELECT COUNT(*) as n FROM Weight_Log WHERE workout_log_id = ? LIMIT 1;`,
      [row.workout_log_id],
    );
    if (Number(hit[0]?.n ?? 0) === 0) {
      return {
        workout_name: row.workout_name,
        day_name: row.day_name,
        workout_date: row.workout_date,
      };
    }
  }
  return null;
}

export async function fetchCalendarInsights(
  db: Pick<SQLiteDatabase, 'getAllAsync'>,
): Promise<CalendarInsights> {
  const [streakDays, week, next] = await Promise.all([
    computeWorkoutStreak(db),
    computeWeeklyCompletion(db, new Date()),
    findNextUnloggedScheduledWorkout(db, new Date()),
  ]);

  let nextWorkoutLabel: string | null = null;
  let nextWorkoutDate: Date | null = null;
  if (next) {
    const name = next.workout_name?.trim() || 'Workout';
    const dayPart = next.day_name?.trim();
    nextWorkoutLabel =
      dayPart && dayPart !== name ? `${name} · ${dayPart}` : name;
    nextWorkoutDate = new Date(next.workout_date * 1000);
  }

  return {
    streakDays,
    weekCompleted: week.completed,
    weekScheduled: week.scheduled,
    nextWorkoutLabel,
    nextWorkoutDate,
  };
}
