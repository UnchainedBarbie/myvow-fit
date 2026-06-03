/**
 * Workout-related DB migrations. The main schema ships in assets/SimpleDB.db;
 * these ALTERs keep older installs compatible with newer code.
 */
export async function initWorkoutDb(db: {
  runAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  // Workout-level type: strength vs cardio
  try {
    await db.runAsync(
      "ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';",
    );
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync(
      'ALTER TABLE Exercises ADD COLUMN rest_seconds INTEGER DEFAULT 60',
    );
  } catch {
    // Column already exists (fresh DB with rest_seconds, or migration already applied).
  }
  // Sage / AI cardio rows: real volume lives in duration_minutes; sets/reps stay as NOT NULL placeholders.
  try {
    await db.runAsync(
      "ALTER TABLE Exercises ADD COLUMN exercise_type TEXT DEFAULT 'strength';",
    );
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync('ALTER TABLE Exercises ADD COLUMN duration_minutes INTEGER;');
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync('ALTER TABLE Exercises ADD COLUMN cardio_distance TEXT;');
  } catch {
    // Column already exists.
  }
  // Persist workout_type on scheduled/log rows so calendar can show a badge without joining.
  try {
    await db.runAsync(
      "ALTER TABLE Workout_Log ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';",
    );
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync(
      'ALTER TABLE Workout_Log ADD COLUMN completion_time INTEGER;',
    );
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync(
      'ALTER TABLE Workout_Log ADD COLUMN notification_id TEXT;',
    );
  } catch {
    // Column already exists.
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
  // Per calendar-instance exercise order (Logged_Exercises); does not affect plan template.
  try {
    await db.runAsync('ALTER TABLE Logged_Exercises ADD COLUMN sort_order INTEGER;');
  } catch {
    // Column already exists.
  }
  // Time-based strength exercises (e.g. planks): hold duration per set in seconds.
  try {
    await db.runAsync('ALTER TABLE Exercises ADD COLUMN duration_seconds INTEGER;');
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync('ALTER TABLE Logged_Exercises ADD COLUMN duration_seconds INTEGER;');
  } catch {
    // Column already exists.
  }
  try {
    await db.runAsync('ALTER TABLE Weight_Log ADD COLUMN duration_seconds INTEGER;');
  } catch {
    // Column already exists.
  }
}
