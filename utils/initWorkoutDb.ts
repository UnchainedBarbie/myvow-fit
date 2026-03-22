/**
 * Workout-related DB migrations. The main schema ships in assets/SimpleDB.db;
 * these ALTERs keep older installs compatible with newer code.
 */
export async function initWorkoutDb(db: {
  runAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  try {
    await db.runAsync(
      'ALTER TABLE Exercises ADD COLUMN rest_seconds INTEGER DEFAULT 60',
    );
  } catch {
    // Column already exists (fresh DB with rest_seconds, or migration already applied).
  }
  try {
    await db.runAsync(
      'ALTER TABLE Workout_Log ADD COLUMN recurring_workout_id INTEGER;',
    );
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync(
      'ALTER TABLE Recurring_Workouts ADD COLUMN recurring_end_date INTEGER;',
    );
  } catch {
    // Column already exists.
  }
}
