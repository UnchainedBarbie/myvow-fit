import type { SQLiteDatabase } from 'expo-sqlite';
import { unixLocalMidnight } from './recurringWorkoutUtils';
import { cancelWorkoutNotification } from './notificationUtils';

/**
 * Deletes a workout definition and cleans up calendar + recurring rules.
 * Keeps past calendar entries that have weight data (completed sessions).
 * Removes: recurring rules, unlogged instances (any date), and all future instances.
 */
export async function deleteWorkoutAndRelatedData(
  db: SQLiteDatabase,
  workout_id: number,
  workout_name: string,
): Promise<void> {
  const todayMid = unixLocalMidnight(Math.floor(Date.now() / 1000));

  const logs = await db.getAllAsync<{ workout_log_id: number; notification_id: string | null }>(
    `SELECT wl.workout_log_id, wl.notification_id
     FROM Workout_Log wl
     WHERE wl.workout_name = ?
       AND (
         wl.workout_date >= ?
         OR NOT EXISTS (
           SELECT 1 FROM Weight_Log w WHERE w.workout_log_id = wl.workout_log_id
         )
       );`,
    [workout_name, todayMid],
  );

  for (const log of logs) {
    if (log.notification_id) {
      try {
        await cancelWorkoutNotification(log.notification_id);
      } catch (e) {
        console.warn('cancelWorkoutNotification failed for log', log.workout_log_id, e);
      }
    }
    await db.runAsync('DELETE FROM Logged_Exercises WHERE workout_log_id = ?;', [
      log.workout_log_id,
    ]);
    await db.runAsync('DELETE FROM Weight_Log WHERE workout_log_id = ?;', [log.workout_log_id]);
    await db.runAsync('DELETE FROM Workout_Log WHERE workout_log_id = ?;', [log.workout_log_id]);
  }

  await db.runAsync('DELETE FROM Recurring_Workouts WHERE workout_id = ?;', [workout_id]);

  await db.runAsync(
    'DELETE FROM Exercises WHERE day_id IN (SELECT day_id FROM Days WHERE workout_id = ?);',
    [workout_id],
  );
  await db.runAsync('DELETE FROM Days WHERE workout_id = ?;', [workout_id]);
  await db.runAsync('DELETE FROM Workouts WHERE workout_id = ?;', [workout_id]);
}
