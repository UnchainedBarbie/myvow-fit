// utils/recurringWorkoutUtils.ts

import { useSQLiteContext } from 'expo-sqlite';
import { useNotifications } from './useNotifications';
import { useCallback } from 'react';
import {
  getCalendarGridUnixRange,
  type CalendarFirstWeekday,
} from './calendarGridRange';

// Constants
const DAY_IN_SECONDS = 86400; // 24 hours in seconds

/** Local calendar midnight (unix seconds) for the calendar day of the given instant. */
export function unixLocalMidnight(tsSeconds: number): number {
  const d = new Date(tsSeconds * 1000);
  return Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000,
  );
}

// Interface for recurring workout data
interface RecurringWorkout {
  recurring_workout_id: number;
  workout_id: number;
  workout_name: string;
  day_name: string;
  recurring_start_date: number;
  recurring_interval: number;
  recurring_days: string | null;
  /** Inclusive last calendar day (unix); null/0 = no end. */
  recurring_end_date?: number | null;
  notification_enabled: number;
  notification_time: string | null;
}

function parseRecurringDaysCsv(recurringDays: string | null): number[] {
  if (!recurringDays || !String(recurringDays).trim()) return [];
  return recurringDays
    .split(',')
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

/** True if this rule should produce a calendar entry on the given local calendar day (midnight unix). */
export function recurringOccursOnLocalDay(
  workout: RecurringWorkout,
  dayMid: number,
): boolean {
  const startMid = unixLocalMidnight(workout.recurring_start_date);
  if (dayMid < startMid) return false;

  const endRaw = workout.recurring_end_date;
  if (endRaw != null && endRaw > 0) {
    const endMid = unixLocalMidnight(endRaw);
    if (dayMid > endMid) return false;
  }

  if (workout.recurring_interval > 0) {
    const delta = dayMid - startMid;
    if (delta < 0) return false;
    const step = workout.recurring_interval * DAY_IN_SECONDS;
    return delta % step === 0;
  }

  const selected = parseRecurringDaysCsv(workout.recurring_days);
  if (selected.length === 0) return false;
  const dow = new Date(dayMid * 1000).getDay();
  return selected.includes(dow);
}

function eachLocalDayMidnightInclusive(
  rangeStartUnix: number,
  rangeEndUnix: number,
): number[] {
  const mids: number[] = [];
  let mid = unixLocalMidnight(rangeStartUnix);
  const lastMid = unixLocalMidnight(rangeEndUnix);
  const maxDays = 800;
  let n = 0;
  while (mid <= lastMid && n < maxDays) {
    mids.push(mid);
    const d = new Date(mid * 1000);
    d.setDate(d.getDate() + 1);
    mid = Math.floor(
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000,
    );
    n++;
  }
  return mids;
}

async function deletePendingWorkoutLogs(
  db: any,
  logs: Array<{ workout_log_id: number; notification_id: string | null }>,
  cancelNotification?: (id: string) => Promise<void>,
) {
  for (const log of logs) {
    if (log.notification_id && cancelNotification) {
      try {
        await cancelNotification(log.notification_id);
      } catch {
        /* ignore */
      }
    }
    await db.runAsync('DELETE FROM Weight_Log WHERE workout_log_id = ?;', [
      log.workout_log_id,
    ]);
    await db.runAsync('DELETE FROM Logged_Exercises WHERE workout_log_id = ?;', [
      log.workout_log_id,
    ]);
    await db.runAsync('DELETE FROM Workout_Log WHERE workout_log_id = ?;', [
      log.workout_log_id,
    ]);
  }
}

async function cleanupRecurringLogsPastEndDate(
  db: any,
  cancelNotification?: (id: string) => Promise<void>,
) {
  const rows = (await db.getAllAsync(
    `SELECT recurring_workout_id, recurring_end_date FROM Recurring_Workouts
     WHERE recurring_end_date IS NOT NULL AND recurring_end_date > 0`,
  )) as Array<{ recurring_workout_id: number; recurring_end_date: number }>;

  for (const r of rows) {
    const endMid = unixLocalMidnight(r.recurring_end_date);
    const pendingLogs = (await db.getAllAsync(
      `SELECT wl.workout_log_id, wl.notification_id FROM Workout_Log wl
       WHERE wl.recurring_workout_id = ?
       AND wl.workout_date > ?
       AND NOT EXISTS (SELECT 1 FROM Weight_Log w WHERE w.workout_log_id = wl.workout_log_id)`,
      [r.recurring_workout_id, endMid],
    )) as Array<{ workout_log_id: number; notification_id: string | null }>;

    await deletePendingWorkoutLogs(db, pendingLogs, cancelNotification);
  }
}

export async function materializeRecurringWorkoutsInRange(
  db: any,
  rangeStartUnix: number,
  rangeEndUnix: number,
  scheduleNotification: any,
  notificationPermissionGranted: boolean,
  cancelNotification?: (id: string) => Promise<void>,
): Promise<boolean> {
  try {
    await cleanupRecurringLogsPastEndDate(db, cancelNotification);

    const recurringWorkouts = (await db.getAllAsync(
      'SELECT * FROM Recurring_Workouts',
    )) as RecurringWorkout[];

    const dayMids = eachLocalDayMidnightInclusive(rangeStartUnix, rangeEndUnix);

    for (const dayMid of dayMids) {
      for (const workout of recurringWorkouts) {
        if (!recurringOccursOnLocalDay(workout, dayMid)) continue;

        const existingLog = await db.getAllAsync(
          `SELECT workout_log_id FROM Workout_Log 
           WHERE workout_date = ? AND workout_name = ? AND day_name = ?`,
          [dayMid, workout.workout_name, workout.day_name],
        );

        if (existingLog.length > 0) continue;

        await scheduleWorkout(
          db,
          workout,
          dayMid,
          scheduleNotification,
          notificationPermissionGranted,
          { skipNotification: true },
        );
      }
    }

    return true;
  } catch (error) {
    console.error('Error in materializeRecurringWorkoutsInRange:', error);
    return false;
  }
}

async function ensureRecurringNotificationsInWindow(
  db: any,
  scheduleNotification: any,
  notificationPermissionGranted: boolean,
  windowStartMid: number,
) {
  if (!notificationPermissionGranted) return;

  const windowEnd = windowStartMid + 14 * DAY_IN_SECONDS;
  const recurring = (await db.getAllAsync(
    `SELECT * FROM Recurring_Workouts WHERE notification_enabled = 1 AND notification_time IS NOT NULL`,
  )) as RecurringWorkout[];

  for (const workout of recurring) {
    const logs = (await db.getAllAsync(
      `SELECT workout_log_id, workout_date, notification_id FROM Workout_Log 
       WHERE recurring_workout_id = ? AND workout_date >= ? AND workout_date <= ? 
       AND notification_id IS NULL 
       ORDER BY workout_date ASC LIMIT 3`,
      [workout.recurring_workout_id, windowStartMid, windowEnd],
    )) as Array<{
      workout_log_id: number;
      workout_date: number;
      notification_id: string | null;
    }>;

    for (const log of logs) {
      if (!workout.notification_time) continue;
      const [hours, minutes] = workout.notification_time.split(':').map(Number);
      const notificationTime = new Date();
      notificationTime.setHours(hours, minutes, 0, 0);
      const workoutDate = new Date(log.workout_date * 1000);
      const notificationId = await scheduleNotification({
        workoutName: workout.workout_name,
        dayName: workout.day_name,
        scheduledDate: workoutDate,
        notificationTime,
      });
      if (notificationId) {
        await db.runAsync(
          'UPDATE Workout_Log SET notification_id = ? WHERE workout_log_id = ?',
          [notificationId, log.workout_log_id],
        );
      }
    }
  }
}

interface Exercise {
  exercise_name: string;
  sets: number;
  reps: number;
  web_link: string | null;
  muscle_group: string | null;
  exercise_notes: string | null;
  rest_seconds: number | null;
}

/**
 * Materialize recurring workouts into Workout_Log for a date range (visible calendar grid
 * or a long default window on app start). Respects weekly days, N-day interval, start date,
 * and optional end date. Notifications are attached separately for the next few days.
 */
export const checkAndScheduleRecurringWorkouts = async (
  db: any,
  scheduleNotification: any,
  notificationPermissionGranted: boolean,
  viewMonth?: Date,
  firstWeekday?: CalendarFirstWeekday,
  cancelNotification?: (id: string) => Promise<void>,
) => {
  try {
    console.log('RECURRING MATERIALIZE STARTED');
    const nowSec = Math.floor(Date.now() / 1000);
    const todayMid = unixLocalMidnight(nowSec);

    let rangeStart: number;
    let rangeEnd: number;
    if (viewMonth != null && firstWeekday != null) {
      const r = getCalendarGridUnixRange(viewMonth, firstWeekday);
      rangeStart = r.startTimestamp;
      rangeEnd = r.endTimestamp;
    } else {
      const startD = new Date(todayMid * 1000);
      startD.setDate(startD.getDate() - 30);
      rangeStart = Math.floor(startD.getTime() / 1000);
      const endD = new Date(todayMid * 1000);
      endD.setDate(endD.getDate() + 540);
      rangeEnd = Math.floor(endD.getTime() / 1000) + 86399;
    }

    await materializeRecurringWorkoutsInRange(
      db,
      rangeStart,
      rangeEnd,
      scheduleNotification,
      notificationPermissionGranted,
      cancelNotification,
    );

    await ensureRecurringNotificationsInWindow(
      db,
      scheduleNotification,
      notificationPermissionGranted,
      todayMid,
    );

    console.log('RECURRING MATERIALIZE COMPLETED');
    return true;
  } catch (error) {
    console.error('Error in checkAndScheduleRecurringWorkouts:', error);
    return false;
  }
};

/**
 * Schedule a workout in the Workout_Log table
 */
const scheduleWorkout = async (
  db: any,
  workout: RecurringWorkout,
  scheduledDate: number,
  scheduleNotification: any,
  notificationPermissionGranted: boolean,
  options?: { skipNotification?: boolean },
) => {
  try {
    let notificationId = null;
    
    // First, insert the workout into the log
    const { lastInsertRowId: workoutLogId } = await db.runAsync(
      'INSERT OR REPLACE INTO Workout_Log (workout_date, day_name, workout_name, notification_id, recurring_workout_id) VALUES (?, ?, ?, ?, ?);',
      [
        scheduledDate,
        workout.day_name,
        workout.workout_name,
        null,
        workout.recurring_workout_id,
      ]
    );
    
    console.log(`Successfully inserted workout into log with ID: ${workoutLogId}`);
    
    // Only schedule notification AFTER successfully adding workout to the database
    if (workout.notification_enabled && workout.notification_time && notificationPermissionGranted) {
      console.log(`Scheduling notification for workout`);
      
      // Parse notification time (HH:MM format)
      const [hours, minutes] = workout.notification_time.split(':').map(Number);
      
      // Create notification time Date object
      const notificationTime = new Date();
      notificationTime.setHours(hours, minutes, 0, 0);
      
      // Convert scheduledDate to Date object
      const workoutDate = new Date(scheduledDate * 1000);
      
      // Schedule the notification
      notificationId = await scheduleNotification({
        workoutName: workout.workout_name,
        dayName: workout.day_name,
        scheduledDate: workoutDate,
        notificationTime: notificationTime
      });
      
      // Update the workout log with the notification ID if one was created
      if (notificationId) {
        console.log(`Notification scheduled with ID: ${notificationId}, updating workout log`);
        await db.runAsync(
          'UPDATE Workout_Log SET notification_id = ? WHERE workout_log_id = ?',
          [notificationId, workoutLogId]
        );
      }
    } else {
      console.log(`No notification scheduled for this workout (enabled: ${workout.notification_enabled}, time: ${workout.notification_time}, permissions: ${notificationPermissionGranted})`);
    }
    
    // Get exercises for this day
    const dayId = await getDayId(db, workout.workout_id, workout.day_name);
    if (!dayId) {
      console.error(`Day ID not found for workout_id ${workout.workout_id}, day_name ${workout.day_name}`);
      throw new Error('Day not found');
    }
    
    // Fetch all exercises associated with the selected day
    const exercises = await db.getAllAsync(
      'SELECT exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds FROM Exercises WHERE day_id = ?;',
      [dayId]
    ) as Exercise[];
    
    console.log(`Adding ${exercises.length} exercises to the logged workout`);
    
    // Insert exercises into the Logged_Exercises table
    const insertExercisePromises = exercises.map((exercise: Exercise) =>
      db.runAsync(
        'INSERT INTO Logged_Exercises (workout_log_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
        [workoutLogId, exercise.exercise_name, exercise.sets, exercise.reps, exercise.web_link, exercise.muscle_group, exercise.exercise_notes, exercise.rest_seconds ?? null]
      )
    );
    
    await Promise.all(insertExercisePromises);
    console.log(`Workout successfully scheduled with ${exercises.length} exercises`);
    return true;
  } catch (error) {
    console.error('Error scheduling workout:', error);
    return false;
  }
};

/**
 * Get the day_id for a workout day
 */
const getDayId = async (db: any, workoutId: number, dayName: string): Promise<number | null> => {
  try {
    const results = await db.getAllAsync(
      'SELECT day_id FROM Days WHERE workout_id = ? AND day_name = ?',
      [workoutId, dayName]
    ) as Array<{ day_id: number }>;
    
    const result = results[0];
    return result ? result.day_id : null;
  } catch (error) {
    console.error('Error getting day ID:', error);
    return null;
  }
};

/**
 * Custom hook to use recurring workout utilities
 */
export const useRecurringWorkouts = () => {
  const db = useSQLiteContext();
  const {
    scheduleNotification,
    cancelNotification,
    notificationPermissionGranted,
    checkNotificationPermission,
  } = useNotifications();
  
  const checkRecurringWorkouts = useCallback(
    async (viewMonth?: Date, firstWeekday?: CalendarFirstWeekday) => {
      let currentPermissionStatus;
      try {
        currentPermissionStatus = await checkNotificationPermission();
        console.log(
          `Current notification permission status: ${currentPermissionStatus}`,
        );
      } catch (error) {
        console.error('Error checking notification permissions:', error);
        return;
      }

      return await checkAndScheduleRecurringWorkouts(
        db,
        scheduleNotification,
        currentPermissionStatus,
        viewMonth,
        firstWeekday,
        cancelNotification,
      );
    },
    [db, scheduleNotification, checkNotificationPermission, cancelNotification],
  );
  
  // Create a new recurring workout
  const createRecurringWorkout = async (data: {
    workout_id: number;
    workout_name: string;
    day_name: string;
    recurring_interval: number;
    recurring_days?: string;
    recurring_end_date?: number | null;
    notification_enabled?: boolean;
    notification_time?: string;
  }) => {
    try {
      const startDate = unixLocalMidnight(Math.floor(Date.now() / 1000));

      await db.runAsync(
        `INSERT INTO Recurring_Workouts (
          workout_id, workout_name, day_name, recurring_start_date, 
          recurring_interval, recurring_days, recurring_end_date, notification_enabled, notification_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          data.workout_id,
          data.workout_name,
          data.day_name,
          startDate,
          data.recurring_interval,
          data.recurring_days || null,
          data.recurring_end_date != null && data.recurring_end_date > 0
            ? data.recurring_end_date
            : null,
          data.notification_enabled ? 1 : 0,
          data.notification_time || null,
        ],
      );
      
      return true;
    } catch (error) {
      console.error('Error creating recurring workout:', error);
      return false;
    }
  };
  
  // Update an existing recurring workout
  const updateRecurringWorkout = async (
    recurringWorkoutId: number,
    updates: {
      recurring_interval?: number;
      recurring_days?: string;
      recurring_end_date?: number | null;
      notification_enabled?: boolean;
      notification_time?: string;
    },
  ) => {
    try {
      // Build the update query dynamically based on provided fields
      let updateFields = [];
      let params = [];

      if (updates.recurring_interval !== undefined) {
        updateFields.push('recurring_interval = ?');
        params.push(updates.recurring_interval);
      }

      if (updates.recurring_days !== undefined) {
        updateFields.push('recurring_days = ?');
        params.push(updates.recurring_days);
      }

      if (updates.recurring_end_date !== undefined) {
        updateFields.push('recurring_end_date = ?');
        params.push(
          updates.recurring_end_date != null && updates.recurring_end_date > 0
            ? updates.recurring_end_date
            : null,
        );
      }

      if (updates.notification_enabled !== undefined) {
        updateFields.push('notification_enabled = ?');
        params.push(updates.notification_enabled ? 1 : 0);
      }

      if (updates.notification_time !== undefined) {
        updateFields.push('notification_time = ?');
        params.push(updates.notification_time);
      }
      
      if (updateFields.length === 0) {
        return false; // Nothing to update
      }
      
      // Add the recurring workout ID to params
      params.push(recurringWorkoutId);
      
      await db.runAsync(
        `UPDATE Recurring_Workouts SET ${updateFields.join(', ')} WHERE recurring_workout_id = ?;`,
        params
      );
      
      return true;
    } catch (error) {
      console.error('Error updating recurring workout:', error);
      return false;
    }
  };
  
  // Delete a recurring workout and remove its unlogged calendar placeholders from Workout_Log
  const deleteRecurringWorkout = useCallback(
    async (recurringWorkoutId: number) => {
      try {
        const metaRows = await db.getAllAsync<{
          workout_name: string;
          day_name: string;
        }>(
          'SELECT workout_name, day_name FROM Recurring_Workouts WHERE recurring_workout_id = ?;',
          [recurringWorkoutId]
        );
        const meta = metaRows[0];
        if (!meta) {
          return false;
        }

        // Unlogged = no Weight_Log rows (same rule as MyCalendar isLogged)
        const pendingLogs = await db.getAllAsync<{
          workout_log_id: number;
          notification_id: string | null;
        }>(
          `SELECT wl.workout_log_id, wl.notification_id FROM Workout_Log wl
           WHERE NOT EXISTS (SELECT 1 FROM Weight_Log w WHERE w.workout_log_id = wl.workout_log_id)
           AND (
             wl.recurring_workout_id = ?
             OR (wl.recurring_workout_id IS NULL AND wl.workout_name = ? AND wl.day_name = ?)
           );`,
          [recurringWorkoutId, meta.workout_name, meta.day_name]
        );

        for (const log of pendingLogs) {
          if (log.notification_id) {
            try {
              await cancelNotification(log.notification_id);
            } catch (e) {
              console.warn('cancelNotification failed for workout_log', log.workout_log_id, e);
            }
          }
          await db.runAsync('DELETE FROM Weight_Log WHERE workout_log_id = ?;', [
            log.workout_log_id,
          ]);
          await db.runAsync('DELETE FROM Logged_Exercises WHERE workout_log_id = ?;', [
            log.workout_log_id,
          ]);
          await db.runAsync('DELETE FROM Workout_Log WHERE workout_log_id = ?;', [
            log.workout_log_id,
          ]);
        }

        await db.runAsync(
          'DELETE FROM Recurring_Workouts WHERE recurring_workout_id = ?;',
          [recurringWorkoutId]
        );
        return true;
      } catch (error) {
        console.error('Error deleting recurring workout:', error);
        return false;
      }
    },
    [db, cancelNotification]
  );
  
  // Get all recurring workouts
  const getAllRecurringWorkouts = async () => {
    try {
      return await db.getAllAsync(
        'SELECT * FROM Recurring_Workouts ORDER BY workout_name, day_name;'
      ) as RecurringWorkout[];
    } catch (error) {
      console.error('Error fetching recurring workouts:', error);
      return [];
    }
  };
  
  return {
    checkRecurringWorkouts,
    createRecurringWorkout,
    updateRecurringWorkout,
    deleteRecurringWorkout,
    getAllRecurringWorkouts
  };
};