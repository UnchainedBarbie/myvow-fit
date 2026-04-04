import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Modal,
  Platform,
  StatusBar,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  useFocusEffect,
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { StackNavigationProp } from '@react-navigation/stack';
// Import the scaling utilities
import {
  scale,
  verticalScale,
  moderateScale,
} from 'react-native-size-matters';
import { WorkoutLogStackParamList } from '../App';
import { useSettings } from '../context/SettingsContext';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from 'react-i18next';
import { useNotifications } from '../utils/useNotifications';
import { useRecurringWorkouts } from '../utils/recurringWorkoutUtils';
import { addMuscleGroupToWeightLog } from '../utils/exerciseDetailUtils';
import {
  Gesture,
  GestureDetector,
  ScrollView as GestureScrollView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { formatWorkoutHeaderTitle } from '../utils/workoutDisplayUtils';
import {
  CALENDAR_GRID_FIRST_WEEKDAY,
  daysToSubtractForMonthGrid,
  getWeekdayHeaderKeys,
} from '../utils/calendarGridRange';
import {
  clearActiveWorkoutSession,
  getActiveWorkoutSession,
} from '../utils/activeWorkoutSession';
import { timerStateUtils } from '../utils/timerPersistenceUtils';
import { deriveCalendarDayCellModel } from '../utils/calendarDayCellState';
import {
  fetchCalendarInsights,
  type CalendarInsights,
} from '../utils/calendarInsights';
import { CalendarDayCell } from '../components/CalendarDayCell';
import { CalendarProgressSummary } from '../components/CalendarProgressSummary';

type MyCalendarNavigationProp = StackNavigationProp<
  WorkoutLogStackParamList,
  'MyCalendar'
>;

type MyCalendarRouteProp = RouteProp<WorkoutLogStackParamList, 'MyCalendar'>;

// Define the structure for a workout entry in our map
interface WorkoutEntry {
  workout: {
    workout_name: string;
    workout_date: number;
    day_name: string;
    workout_log_id: number;
    notification_id?: string | null;
    workout_type?: string | null;
  };
  isLogged: boolean;
}

interface ExerciseDetails {
  exercise_name: string;
  sets?: number;
  reps?: number;
  logs: {
    set_number: number;
    weight_logged: number;
    reps_logged: number;
  }[];
}

export default function MyCalendar() {
  const db = useSQLiteContext();
  const navigation = useNavigation<MyCalendarNavigationProp>();
  const route = useRoute<MyCalendarRouteProp>();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const { dateFormat, weightFormat } = useSettings();
  const { cancelNotification, scheduleNotification } = useNotifications();
  const { checkRecurringWorkouts } = useRecurringWorkouts();

  // State for the calendar
  const [currentDate, setCurrentDate] = useState(new Date());
  const [workouts, setWorkouts] = useState<Map<string, WorkoutEntry[]>>(
    new Map(),
  );
  const [calendarInsights, setCalendarInsights] =
    useState<CalendarInsights | null>(null);

  // State for the modal
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedDateWorkouts, setSelectedDateWorkouts] = useState<
    WorkoutEntry[]
  >([]);
  const [detailedWorkout, setDetailedWorkout] = useState<WorkoutEntry | null>(
    null,
  );
  const [exercises, setExercises] = useState<ExerciseDetails[]>([]);
  const [completionTime, setCompletionTime] = useState<number | null>(null);
  const [untrackedChoiceModalVisible, setUntrackedChoiceModalVisible] =
    useState(false);
  const [selectedUntrackedWorkout, setSelectedUntrackedWorkout] =
    useState<WorkoutEntry | null>(null);
  const [untrackedWorkoutDetails, setUntrackedWorkoutDetails] = useState<
    ExerciseDetails[]
  >([]);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [activeWorkoutLogId, setActiveWorkoutLogId] = useState<number | null>(
    null,
  );

  const workoutsRef = useRef(workouts);
  const selectedDateRef = useRef(selectedDate);
  const detailedWorkoutRef = useRef(detailedWorkout);
  useEffect(() => {
    workoutsRef.current = workouts;
  }, [workouts]);
  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);
  useEffect(() => {
    detailedWorkoutRef.current = detailedWorkout;
  }, [detailedWorkout]);

  // Reschedule workout flow
  const [rescheduleModalVisible, setRescheduleModalVisible] = useState(false);
  const [workoutToReschedule, setWorkoutToReschedule] = useState<WorkoutEntry | null>(null);
  const [rescheduleNewDate, setRescheduleNewDate] = useState<Date>(() => new Date());
  const [showRescheduleDatePicker, setShowRescheduleDatePicker] = useState(false);

  const [scheduleWorkoutPickerVisible, setScheduleWorkoutPickerVisible] =
    useState(false);
  const [savedWorkoutsForSchedule, setSavedWorkoutsForSchedule] = useState<
    { workout_id: number; workout_name: string }[]
  >([]);
  type SchedulePickerDayRow = { day_id: number; day_name: string };
  const [schedulePickerStep, setSchedulePickerStep] = useState<
    'workout' | 'day'
  >('workout');
  const [schedulePickerDays, setSchedulePickerDays] = useState<
    SchedulePickerDayRow[]
  >([]);
  const [schedulePickerPendingWorkoutId, setSchedulePickerPendingWorkoutId] =
    useState<number | null>(null);

  const resetSchedulePickerUi = useCallback(() => {
    setSchedulePickerStep('workout');
    setSchedulePickerDays([]);
    setSchedulePickerPendingWorkoutId(null);
  }, []);

  const closeScheduleWorkoutPicker = useCallback(() => {
    resetSchedulePickerUi();
    setScheduleWorkoutPickerVisible(false);
  }, [resetSchedulePickerUi]);

  useEffect(() => {
    if (
      Platform.OS === 'android' &&
      UIManager.setLayoutAnimationEnabledExperimental
    ) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  // Run this check only ONCE when the component mounts
  useEffect(() => {
    console.log('MyCalendar: Component mounted, checking recurring workouts.');
    addColumn0();
    addColumn1();
    addColumn2();
    addMuscleGroupToWeightLog(db);
    // checkRecurringWorkouts();
    setUntrackedWorkoutDetails([]);
  }, []); // Empty dependency array ensures this runs only once

  const addColumn1 = async () => {
    try {
      // Check if column exists first
      const tableInfo = await db.getAllAsync(
        'PRAGMA table_info(Workout_Log);',
      );
      const columnExists = tableInfo.some(
        (column: any) => column.name === 'completion_time',
      );

      if (!columnExists) {
        await db.runAsync(
          'ALTER TABLE Workout_Log ADD COLUMN completion_time INTEGER;',
        );
        console.log('Column added successfully');
      } else {
        console.log('Column already exists, skipping');
      }
    } catch (error) {
      console.error('Error managing column:', error);
    }
  };

  const addColumn0 = async () => {
    try {
      // Check if column exists first
      const tableInfo = await db.getAllAsync('PRAGMA table_info(Weight_Log);');
      const columnExists = tableInfo.some(
        (column: any) => column.name === 'completion_time',
      );

      if (!columnExists) {
        await db.runAsync(
          'ALTER TABLE Weight_Log ADD COLUMN completion_time INTEGER;',
        );
        console.log('Column added successfully');
      } else {
        console.log('Column already exists, skipping');
      }
    } catch (error) {
      console.error('Error managing column:', error);
    }
  };

  const addColumn2 = async () => {
    try {
      // Check if column exists first
      const tableInfo = await db.getAllAsync(
        'PRAGMA table_info(Workout_Log);',
      );
      const columnExists = tableInfo.some(
        (column: any) => column.name === 'notification_id',
      );

      if (!columnExists) {
        await db.runAsync(
          'ALTER TABLE Workout_Log ADD COLUMN notification_id TEXT;',
        );
        console.log('Column added successfully');
      } else {
        console.log('Column already exists, skipping');
      }
    } catch (error) {
      console.error('Error managing column:', error);
    }
  };

  const fetchWorkoutsForGrid = useCallback(
    async (date: Date) => {
      try {
        // Calculate the start and end of the visible grid
        const firstDayOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        const dayOfWeek = firstDayOfMonth.getDay(); // 0=Sun, 1=Mon...

        const daysToSubtract = daysToSubtractForMonthGrid(
          dayOfWeek,
          CALENDAR_GRID_FIRST_WEEKDAY,
        );

        const gridStartDate = new Date(firstDayOfMonth);
        gridStartDate.setDate(gridStartDate.getDate() - daysToSubtract);

        const gridEndDate = new Date(gridStartDate);
        gridEndDate.setDate(gridEndDate.getDate() + 41); // 6 weeks * 7 days - 1

        const startTimestamp = Math.floor(gridStartDate.getTime() / 1000);
        const endTimestamp = Math.floor(gridEndDate.getTime() / 1000) + 86399;

        const allWorkoutsInRange = await db.getAllAsync<
          WorkoutEntry['workout']
        >(`SELECT * FROM Workout_Log WHERE workout_date BETWEEN ? AND ?;`, [
          startTimestamp,
          endTimestamp,
        ]);

        const loggedWorkoutIdsResult = await db.getAllAsync<{
          workout_log_id: number;
        }>(
          `SELECT DISTINCT workout_log_id FROM Weight_Log
           WHERE workout_log_id IN (SELECT workout_log_id FROM Workout_Log WHERE workout_date BETWEEN ? AND ?);`,
          [startTimestamp, endTimestamp],
        );
        const loggedWorkoutIds = new Set(
          loggedWorkoutIdsResult.map((item) => item.workout_log_id),
        );

        const workoutsMap = new Map<string, WorkoutEntry[]>();
        allWorkoutsInRange.forEach((workout) => {
          const workoutDate = new Date(workout.workout_date * 1000);
          const dateKey = `${workoutDate.getFullYear()}-${String(
            workoutDate.getMonth() + 1,
          ).padStart(2, '0')}-${String(workoutDate.getDate()).padStart(
            2,
            '0',
          )}`;

          const entry: WorkoutEntry = {
            workout,
            isLogged: loggedWorkoutIds.has(workout.workout_log_id),
          };

          const existingEntries = workoutsMap.get(dateKey);
          if (existingEntries) {
            existingEntries.push(entry);
          } else {
            workoutsMap.set(dateKey, [entry]);
          }
        });

        setWorkouts(workoutsMap);
      } catch (error) {
        console.error('Error fetching workouts for grid:', error);
      }
    },
    [db],
  );

  /** Load workouts for one local calendar day (used when swiping the day modal off-grid). */
  const fetchWorkoutEntriesForLocalDay = useCallback(
    async (day: Date): Promise<WorkoutEntry[]> => {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
      const startTimestamp = Math.floor(start.getTime() / 1000);
      const endTimestamp = startTimestamp + 86399;
      const allWorkoutsInRange = await db.getAllAsync<
        WorkoutEntry['workout']
      >(`SELECT * FROM Workout_Log WHERE workout_date BETWEEN ? AND ?;`, [
        startTimestamp,
        endTimestamp,
      ]);
      const loggedWorkoutIdsResult = await db.getAllAsync<{
        workout_log_id: number;
      }>(
        `SELECT DISTINCT workout_log_id FROM Weight_Log
         WHERE workout_log_id IN (SELECT workout_log_id FROM Workout_Log WHERE workout_date BETWEEN ? AND ?);`,
        [startTimestamp, endTimestamp],
      );
      const loggedWorkoutIds = new Set(
        loggedWorkoutIdsResult.map((item) => item.workout_log_id),
      );
      return allWorkoutsInRange.map((workout) => ({
        workout,
        isLogged: loggedWorkoutIds.has(workout.workout_log_id),
      }));
    },
    [db],
  );

  /**
   * Re-materialize recurring rows, re-query Workout_Log + Weight_Log for the visible grid,
   * and rebuild `workouts` so day cells show logged / missed / upcoming correctly.
   */
  const reloadCalendarIndicators = useCallback(
    async (opts?: { shouldAbort?: () => boolean }) => {
      const abort = opts?.shouldAbort ?? (() => false);
      try {
        await checkRecurringWorkouts(currentDate, CALENDAR_GRID_FIRST_WEEKDAY);
        if (abort()) return;
        await fetchWorkoutsForGrid(currentDate);
        if (abort()) return;
        try {
          const insights = await fetchCalendarInsights(db);
          if (!abort()) setCalendarInsights(insights);
        } catch (insErr) {
          console.error('MyCalendar: calendar insights', insErr);
        }
        if (abort()) return;
        const session = await getActiveWorkoutSession();
        if (abort()) return;
        setActiveWorkoutLogId(session?.workoutLogId ?? null);
      } catch (e) {
        console.error('MyCalendar: reloadCalendarIndicators', e);
      }
    },
    [currentDate, checkRecurringWorkouts, db, fetchWorkoutsForGrid],
  );

  const shiftDayModalBy = useCallback(
    async (delta: number) => {
      if (detailedWorkoutRef.current) return;
      const prev = selectedDateRef.current;
      if (!prev) return;
      const next = new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate() + delta,
      );
      setSelectedDate(next);
      selectedDateRef.current = next;
      const dateKey = `${next.getFullYear()}-${String(
        next.getMonth() + 1,
      ).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
      const fromMap = workoutsRef.current.get(dateKey);
      const entries =
        fromMap !== undefined
          ? [...fromMap]
          : await fetchWorkoutEntriesForLocalDay(next);
      setSelectedDateWorkouts(entries);
      setDetailedWorkout(null);
      setExercises([]);
      setCompletionTime(null);
    },
    [fetchWorkoutEntriesForLocalDay],
  );

  const localDayStartUnixSec = useCallback((d: Date) => {
    return Math.floor(
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000,
    );
  }, []);

  const openScheduleWorkoutPicker = useCallback(async () => {
    try {
      resetSchedulePickerUi();
      await db
        .runAsync(
          "ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';",
        )
        .catch(() => {});
      const rows = await db.getAllAsync<{
        workout_id: number;
        workout_name: string;
      }>(
        'SELECT workout_id, workout_name FROM Workouts ORDER BY workout_name;',
      );
      setSavedWorkoutsForSchedule(rows);
      setScheduleWorkoutPickerVisible(true);
    } catch (e) {
      console.error('MyCalendar: load workouts for schedule picker', e);
      Alert.alert(t('errorTitle'), t('fetchWorkoutDetailsError'));
    }
  }, [db, resetSchedulePickerUi, t]);

  const scheduleSavedWorkoutForSelectedDay = useCallback(
    async (workoutId: number, planDay: SchedulePickerDayRow) => {
      const dayDate = selectedDateRef.current;
      if (!dayDate) return;
      try {
        await db.runAsync('ALTER TABLE Workout_Log ADD COLUMN notification_id TEXT;').catch(() => {});
        await db.runAsync('ALTER TABLE Workout_Log ADD COLUMN completion_time INTEGER;').catch(() => {});
        await db
          .runAsync(
            "ALTER TABLE Workout_Log ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';",
          )
          .catch(() => {});
        await db
          .runAsync(
            "ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';",
          )
          .catch(() => {});

        const [workoutRow] = await db.getAllAsync<{
          workout_name: string;
          workout_type: string | null;
        }>('SELECT workout_name, workout_type FROM Workouts WHERE workout_id = ?;', [
          workoutId,
        ]);
        if (!workoutRow) {
          Alert.alert(t('errorTitle'), t('fetchWorkoutDetailsError'));
          return;
        }

        const workoutDate = localDayStartUnixSec(dayDate);
        const workoutType =
          (workoutRow.workout_type || 'strength').toLowerCase() === 'cardio'
            ? 'cardio'
            : 'strength';

        const existingLog = await db.getAllAsync<{ workout_log_id: number }>(
          `SELECT workout_log_id 
           FROM Workout_Log 
           WHERE workout_date = ? 
             AND day_name = ? 
             AND workout_name = ?;`,
          [workoutDate, planDay.day_name, workoutRow.workout_name.trim()],
        );
        if (existingLog.length > 0) {
          Alert.alert(t('duplicateLogTitle'), t('duplicateLogMessage'));
          return;
        }

        const { lastInsertRowId: workoutLogId } = await db.runAsync(
          'INSERT INTO Workout_Log (workout_date, day_name, workout_name, notification_id, workout_type) VALUES (?, ?, ?, ?, ?);',
          [
            workoutDate,
            planDay.day_name,
            workoutRow.workout_name.trim(),
            null,
            workoutType,
          ],
        );

        if (workoutType !== 'cardio') {
          const exercises = await db.getAllAsync<{
            exercise_name: string;
            sets: number;
            reps: number;
            web_link: string | null;
            muscle_group: string | null;
            exercise_notes: string | null;
            rest_seconds: number | null;
          }>(
            'SELECT exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds FROM Exercises WHERE day_id = ? ORDER BY exercise_id;',
            [planDay.day_id],
          );
          for (const exercise of exercises) {
            await db.runAsync(
              'INSERT INTO Logged_Exercises (workout_log_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
              [
                workoutLogId,
                exercise.exercise_name,
                exercise.sets,
                exercise.reps,
                exercise.web_link,
                exercise.muscle_group,
                exercise.exercise_notes,
                exercise.rest_seconds ?? null,
              ],
            );
          }
        }

        closeScheduleWorkoutPicker();
        setModalVisible(false);
        setDetailedWorkout(null);
        await reloadCalendarIndicators();
      } catch (e) {
        console.error('MyCalendar: schedule workout for day', e);
        Alert.alert(
          t('errorTitle'),
          t('failedToAddToCalendar') || 'Failed to schedule workout.',
        );
      }
    },
    [closeScheduleWorkoutPicker, db, localDayStartUnixSec, reloadCalendarIndicators, t],
  );

  const handleScheduleWorkoutChosenInPicker = useCallback(
    async (workoutId: number) => {
      try {
        const rows = await db.getAllAsync<SchedulePickerDayRow>(
          'SELECT day_id, day_name FROM Days WHERE workout_id = ? ORDER BY day_id ASC;',
          [workoutId],
        );
        if (!rows.length) {
          Alert.alert(t('errorTitle'), t('noDaysAvailable'));
          return;
        }
        if (rows.length === 1) {
          await scheduleSavedWorkoutForSelectedDay(workoutId, rows[0]!);
          return;
        }
        setSchedulePickerPendingWorkoutId(workoutId);
        setSchedulePickerDays(rows);
        setSchedulePickerStep('day');
      } catch (e) {
        console.error('MyCalendar: load days for schedule picker', e);
        Alert.alert(t('errorTitle'), t('fetchWorkoutDetailsError'));
      }
    },
    [db, scheduleSavedWorkoutForSelectedDay, t],
  );

  const dayModalSwipeGesture = useMemo(() => {
    if (detailedWorkout) {
      return Gesture.Pan().enabled(false);
    }
    const trigger = (dir: number) => {
      void shiftDayModalBy(dir);
    };
    return Gesture.Pan()
      .activeOffsetX([-42, 42])
      .failOffsetY([-20, 20])
      .onEnd((e) => {
        const { translationX, velocityX } = e;
        if (translationX < -55 || velocityX < -380) {
          runOnJS(trigger)(1);
        } else if (translationX > 55 || velocityX > 380) {
          runOnJS(trigger)(-1);
        }
      });
  }, [detailedWorkout, shiftDayModalBy]);

  // Every time this screen gains focus: re-query logs and recompute day indicators.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      console.log(
        'MyCalendar: Screen focused, reloading calendar indicators.',
      );
      void reloadCalendarIndicators({
        shouldAbort: () => cancelled,
      });
      return () => {
        cancelled = true;
      };
    }, [reloadCalendarIndicators]),
  );

  const dismissActiveWorkoutBanner = useCallback(async () => {
    await clearActiveWorkoutSession().catch(() => {});
    await timerStateUtils.clearTimerState().catch(() => {});
    setActiveWorkoutLogId(null);
  }, []);

  const fetchWorkoutDetails = async (
    workout_log_id: number,
    isLogged: boolean,
  ) => {
    try {
      setExercises([]);
      setCompletionTime(null);

      if (isLogged) {
        const workoutLogData = await db.getFirstAsync<{
          completion_time: number | null;
        }>(`SELECT completion_time FROM Workout_Log WHERE workout_log_id = ?;`, [
          workout_log_id,
        ]);

        if (workoutLogData?.completion_time) {
          setCompletionTime(workoutLogData.completion_time);
        }

        const loggedData = await db.getAllAsync<{
          exercise_name: string;
          set_number: number;
          weight_logged: number;
          reps_logged: number;
        }>(
          `
          SELECT le.exercise_name, wl.set_number, wl.weight_logged, wl.reps_logged
          FROM Weight_Log wl
          JOIN Logged_Exercises le ON wl.logged_exercise_id = le.logged_exercise_id
          WHERE wl.workout_log_id = ?
          ORDER BY le.exercise_name, wl.set_number;
        `,
          [workout_log_id],
        );

        if (loggedData.length > 0) {
          const grouped = loggedData.reduce(
            (acc, item) => {
              if (!acc[item.exercise_name]) {
                acc[item.exercise_name] = {
                  exercise_name: item.exercise_name,
                  logs: [],
                };
              }

              const exerciseGroup = acc[item.exercise_name];
              if (!exerciseGroup || !exerciseGroup.logs) {
                throw new Error(
                  `Failed to find or create group for exercise: ${item.exercise_name}`,
                );
              }

              exerciseGroup.logs.push({
                set_number: item.set_number,
                weight_logged: item.weight_logged,
                reps_logged: item.reps_logged,
              });
              return acc;
            },
            {} as Record<string, ExerciseDetails>,
          );

          setExercises(Object.values(grouped));
        } else {
          const planned = await db.getAllAsync<
            { exercise_name: string; sets: number; reps: number }
          >(
            `SELECT exercise_name, sets, reps FROM Logged_Exercises WHERE workout_log_id = ?;`,
            [workout_log_id],
          );
          setExercises(planned.map((p) => ({ ...p, logs: [] })));
        }
      } else {
        const planned = await db.getAllAsync<
          { exercise_name: string; sets: number; reps: number }
        >(
          `SELECT exercise_name, sets, reps FROM Logged_Exercises WHERE workout_log_id = ?;`,
          [workout_log_id],
        );
        setExercises(planned.map((p) => ({ ...p, logs: [] })));
      }
    } catch (error) {
      console.error('Error fetching workout details:', error);
    }
  };

  const fetchUntrackedWorkoutDetails = async (workout_log_id: number) => {
    try {
      const planned = await db.getAllAsync<
        { exercise_name: string; sets: number; reps: number }
      >(
        `SELECT exercise_name, sets, reps FROM Logged_Exercises WHERE workout_log_id = ?;`,
        [workout_log_id],
      );
      setUntrackedWorkoutDetails(planned.map((p) => ({ ...p, logs: [] })));
    } catch (error) {
      console.error('Error fetching untracked workout details:', error);
    }
  };

  useEffect(() => {
    if (!route.params?.refresh) return;
    let alive = true;
    (async () => {
      console.log('MyCalendar: refresh param set, reloading calendar indicators.');
      await reloadCalendarIndicators({ shouldAbort: () => !alive });
      if (alive) {
        navigation.setParams({ refresh: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [route.params?.refresh, reloadCalendarIndicators, navigation]);

  const closeUntrackedModal = () => {
    setUntrackedChoiceModalVisible(false);
    setUntrackedWorkoutDetails([]);
  };

  const handleUntrackedWorkoutPress = (entry: WorkoutEntry) => {
    setSelectedUntrackedWorkout(entry);
    fetchUntrackedWorkoutDetails(entry.workout.workout_log_id);
    setUntrackedChoiceModalVisible(true);
  };

  const handleDatePress = (date: Date, workoutEntries?: WorkoutEntry[]) => {
    setSelectedDate(date);
    setSelectedDateWorkouts(workoutEntries || []);
    setDetailedWorkout(null);
    setExercises([]);
    setModalVisible(true);
  };

  const performDeleteWorkout = async (workoutEntry: WorkoutEntry) => {
    try {
      const { workout_log_id, notification_id } = workoutEntry.workout;
      if (notification_id) {
        await cancelNotification(notification_id);
      }
      await db.runAsync(
        `DELETE FROM Workout_Log WHERE workout_log_id = ?;`,
        [workout_log_id],
      );
      await db.runAsync(
        `DELETE FROM Weight_Log WHERE workout_log_id = ?;`,
        [workout_log_id],
      );
      await db.runAsync(
        `DELETE FROM Logged_Exercises WHERE workout_log_id = ?;`,
        [workout_log_id],
      );
      void reloadCalendarIndicators();

      setSelectedDateWorkouts((prev) => {
        const updated = prev.filter(
          (w) => w.workout.workout_log_id !== workout_log_id,
        );
        if (updated.length === 0) setModalVisible(false);
        return updated;
      });
    } catch (error) {
      console.error('Error deleting workout log:', error);
      Alert.alert(t('errorTitle'), t('failedToDeleteWorkoutLog'));
    }
  };

  const confirmDeleteWorkout = (workoutEntry: WorkoutEntry) => {
    Alert.alert(
      t('deleteWorkoutTitle') || 'Delete Workout?',
      t('deleteWorkoutMessage') || 'This will remove the workout from your calendar.',
      [
        { text: t('Cancel'), style: 'cancel' },
        {
          text: t('alertDelete'),
          style: 'destructive',
          onPress: () => performDeleteWorkout(workoutEntry),
        },
      ],
    );
  };

  const handleDeleteWorkoutPress = () => {
    if (selectedDateWorkouts.length === 0) return;
    if (selectedDateWorkouts.length === 1) {
      confirmDeleteWorkout(selectedDateWorkouts[0]);
    } else {
      Alert.alert(
        t('deleteWorkoutPickTitle') || 'Which workout do you want to delete?',
        '',
        selectedDateWorkouts.map((entry) => ({
          text: entry.workout.workout_name,
          onPress: () => confirmDeleteWorkout(entry),
        })).concat([{ text: t('Cancel'), style: 'cancel' as const }]),
      );
    }
  };

  const openRescheduleFlow = (entry?: WorkoutEntry) => {
    if (entry) {
      setWorkoutToReschedule(entry);
      setRescheduleNewDate(new Date(entry.workout.workout_date * 1000));
      setModalVisible(false);
      setRescheduleModalVisible(true);
    } else if (selectedDateWorkouts.length === 1) {
      setWorkoutToReschedule(selectedDateWorkouts[0]);
      setRescheduleNewDate(new Date(selectedDateWorkouts[0].workout.workout_date * 1000));
      setModalVisible(false);
      setRescheduleModalVisible(true);
    }
  };

  const confirmReschedule = useCallback(async () => {
    if (!workoutToReschedule) return;
    const { workout_log_id, notification_id, workout_name, day_name } = workoutToReschedule.workout;
    const newTimestamp = Math.floor(rescheduleNewDate.getTime() / 1000);
    const newDate = new Date(rescheduleNewDate);
    newDate.setHours(0, 0, 0, 0);
    try {
      if (notification_id) {
        await cancelNotification(notification_id);
      }
      let newNotificationId: string | null = null;
      const defaultNotifyTime = new Date();
      defaultNotifyTime.setHours(8, 0, 0, 0);
      if (scheduleNotification) {
        newNotificationId = await scheduleNotification({
          workoutName: workout_name,
          dayName: day_name,
          scheduledDate: new Date(newTimestamp * 1000),
          notificationTime: defaultNotifyTime,
        });
      }
      await db.runAsync(
        'UPDATE Workout_Log SET workout_date = ?, notification_id = ? WHERE workout_log_id = ?;',
        [newTimestamp, newNotificationId ?? null, workout_log_id],
      );
      setRescheduleModalVisible(false);
      setWorkoutToReschedule(null);
      void reloadCalendarIndicators();
      setSelectedDateWorkouts((prev) => {
        const updated = prev.filter((w) => w.workout.workout_log_id !== workout_log_id);
        if (updated.length === 0) setModalVisible(false);
        return updated;
      });
      Alert.alert(t('Success') || 'Success', t('rescheduleSuccess') || 'Workout date updated.');
    } catch (err) {
      console.error('Reschedule error:', err);
      Alert.alert(t('errorTitle'), t('failedToReschedule') || 'Failed to update workout date.');
    }
  }, [workoutToReschedule, rescheduleNewDate, db, cancelNotification, scheduleNotification, reloadCalendarIndicators, t]);

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);

    const isSameDay = (d1: Date, d2: Date) =>
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate();

    if (isSameDay(date, today)) return t('Today');
    if (isSameDay(date, yesterday)) return t('Yesterday');
    if (isSameDay(date, tomorrow)) return t('Tomorrow');

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();

    return dateFormat === 'mm-dd-yyyy'
      ? `${month}-${day}-${year}`
      : `${day}-${month}-${year}`;
  };

  const formatCompletionTime = (totalSeconds: number): string => {
    if (!totalSeconds || totalSeconds < 0) {
      return '';
    }
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    const paddedMinutes = String(minutes).padStart(2, '0');
    const paddedSeconds = String(seconds).padStart(2, '0');

    if (hours > 0) {
      return `${String(hours).padStart(
        2,
        '0',
      )}:${paddedMinutes}:${paddedSeconds}`;
    }
    return `${paddedMinutes}:${paddedSeconds}`;
  };

  const bumpMonth = useCallback((delta: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCurrentDate(
      (prevDate) =>
        new Date(prevDate.getFullYear(), prevDate.getMonth() + delta, 1),
    );
  }, []);

  const handlePrevMonth = useCallback(() => bumpMonth(-1), [bumpMonth]);
  const handleNextMonth = useCallback(() => bumpMonth(1), [bumpMonth]);

  const monthSwipeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-20, 20])
        .failOffsetY([-18, 18])
        .onEnd((e) => {
          const { translationX, velocityX } = e;
          if (translationX < -56 || velocityX < -320) {
            runOnJS(bumpMonth)(1);
          } else if (translationX > 56 || velocityX > 320) {
            runOnJS(bumpMonth)(-1);
          }
        }),
    [bumpMonth],
  );

  const getMonthName = (date: Date) => {
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    return t(months[date.getMonth()]);
  };

  const weekDays = useMemo(
    () => getWeekdayHeaderKeys(CALENDAR_GRID_FIRST_WEEKDAY).map((k) => t(k)),
    [t],
  );

  const renderCalendarGrid = () => {
    const gridItems = [];

    weekDays.forEach((day, index) => {
      gridItems.push(
        <View
          key={`weekday-${index}`}
          style={[
            styles.weekdayHeaderCell,
            { borderBottomColor: theme.border },
          ]}
        >
          <Text style={[styles.weekDayText, { color: theme.textSecondary }]}>
            {day}
          </Text>
        </View>,
      );
    });

    const month = currentDate.getMonth();
    const year = currentDate.getFullYear();
    const today = new Date();

    const firstDayOfMonth = new Date(year, month, 1);
    const dayOfWeek = firstDayOfMonth.getDay();

    const daysToSubtract = daysToSubtractForMonthGrid(dayOfWeek, CALENDAR_GRID_FIRST_WEEKDAY);

    const gridStartDate = new Date(firstDayOfMonth);
    gridStartDate.setDate(gridStartDate.getDate() - daysToSubtract);

    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(gridStartDate);
      cellDate.setDate(gridStartDate.getDate() + i);

      const day = cellDate.getDate();
      const cellMonth = cellDate.getMonth();
      const cellYear = cellDate.getFullYear();

      const dateKey = `${cellYear}-${String(cellMonth + 1).padStart(
        2,
        '0',
      )}-${String(day).padStart(2, '0')}`;
      const workoutEntries = workouts.get(dateKey);

      const isCurrentMonth = cellMonth === month;
      const todayMid = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      ).getTime();
      const cellMid = new Date(cellYear, cellMonth, day).getTime();
      const isToday = cellMid === todayMid;
      const isPast = cellMid < todayMid;
      const isFuture = cellMid > todayMid;

      const hasWorkouts = !!(workoutEntries && workoutEntries.length > 0);
      const isAnyLogged =
        hasWorkouts && workoutEntries!.some((entry) => entry.isLogged);

      const model = deriveCalendarDayCellModel({
        hasWorkouts,
        isAnyLogged,
        isPast,
        isFuture,
        isToday,
        isCurrentMonth,
      });

      gridItems.push(
        <CalendarDayCell
          key={dateKey}
          day={day}
          model={model}
          theme={{
            text: theme.text,
            buttonBackground: theme.buttonBackground,
            buttonText: theme.buttonText,
            textSecondary: theme.textSecondary,
            primary: theme.primary,
          }}
          onPress={() => {
            handleDatePress(cellDate, workoutEntries);
          }}
        />,
      );
    }
    return gridItems;
  };

  return (
    // Calendar content – header title is provided by stack navigator
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.background }}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[styles.contentContainer, { paddingTop: 18 }]}
    >
      {activeWorkoutLogId != null && (
        <View
          style={[
            styles.activeWorkoutBanner,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
            },
          ]}
        >
          <Text
            style={[styles.activeWorkoutBannerText, { color: theme.text }]}
          >
            {t('workoutInProgressBanner')}
          </Text>
          <View style={styles.activeWorkoutBannerActions}>
            <TouchableOpacity
              style={[
                styles.activeWorkoutBannerButton,
                styles.activeWorkoutBannerButtonOutline,
                { borderColor: theme.border },
              ]}
              onPress={dismissActiveWorkoutBanner}
              activeOpacity={0.85}
            >
              <Text
                style={[
                  styles.activeWorkoutBannerButtonText,
                  { color: theme.text },
                ]}
              >
                {t('Cancel')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.activeWorkoutBannerButton,
                { backgroundColor: theme.buttonBackground },
              ]}
              onPress={() =>
                navigation.navigate('StartedWorkoutInterface', {
                  workout_log_id: activeWorkoutLogId,
                  resume: true,
                })
              }
              activeOpacity={0.85}
            >
              <Text
                style={[
                  styles.activeWorkoutBannerButtonText,
                  { color: theme.buttonText },
                ]}
              >
                {t('resumeWorkout')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      <View style={styles.buttonRow}>
        <TouchableOpacity
            style={[
              styles.actionButton,
              { backgroundColor: theme.buttonBackground },
            ]}
            onPress={() =>
              navigation.navigate('LogWorkout', {
                selectedDate: new Date().toISOString(),
              })
            }
          >
            <Ionicons
              name='flash'
              size={scale(22)}
              color={theme.buttonText}
              style={styles.icon}
            />
            <Text style={[styles.actionButtonText, { color: theme.buttonText }]}>
              {t('quickWorkout')}
            </Text>
          </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.actionButton,
            { backgroundColor: theme.buttonBackground },
          ]}
          onPress={() => navigation.navigate('RecurringWorkoutOptions')}
        >
          <Ionicons
            name='infinite'
            size={scale(22)}
            color={theme.buttonText}
            style={styles.icon}
          />
          <Text style={[styles.actionButtonText, { color: theme.buttonText }]}>
            {t('recurringWorkouts')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Calendar */}
      <View
        style={[
          styles.calendarContainer,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
        <GestureDetector gesture={monthSwipeGesture}>
          <View>
            <View style={styles.calendarHeader}>
              <TouchableOpacity
                onPress={handlePrevMonth}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityRole="button"
                accessibilityLabel={t('prevMonthA11y', {
                  defaultValue: 'Previous month',
                })}
              >
                <Ionicons name="chevron-back" size={scale(26)} color={theme.text} />
              </TouchableOpacity>
              <View style={styles.calendarTitleBlock}>
                <Text style={[styles.calendarMonthText, { color: theme.text }]}>
                  {getMonthName(currentDate)}
                </Text>
                <Text
                  style={[styles.calendarYearSub, { color: theme.textSecondary }]}
                >
                  {currentDate.getFullYear()}
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleNextMonth}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityRole="button"
                accessibilityLabel={t('nextMonthA11y', {
                  defaultValue: 'Next month',
                })}
              >
                <Ionicons
                  name="chevron-forward"
                  size={scale(26)}
                  color={theme.text}
                />
              </TouchableOpacity>
            </View>
            <View style={styles.daysGrid}>{renderCalendarGrid()}</View>
          </View>
        </GestureDetector>
      </View>

      {calendarInsights ? (
        <CalendarProgressSummary
          insights={calendarInsights}
          theme={{
            card:
              theme.type === 'dark'
                ? 'rgba(255,255,255,0.07)'
                : theme.card,
            text: theme.text,
            textSecondary: theme.textSecondary,
            border: theme.border,
            buttonBackground: theme.buttonBackground,
          }}
          t={t}
          dateFormat={
            dateFormat === 'mm-dd-yyyy' ? 'mm-dd-yyyy' : 'dd-mm-yyyy'
          }
        />
      ) : null}
      <Text
        style={[styles.calendarMicroLegend, { color: theme.textSecondary }]}
      >
        {t('calendarMicroHint', {
          defaultValue:
            'Ring = today · green = logged · bar = scheduled · ✕ = missed',
        })}
      </Text>

      {/* Modal for Workout Details - only mount when open so it doesn't block the reschedule modal */}
      {modalVisible && (
      <Modal
        visible={true}
        transparent={true}
        animationType='fade'
        onRequestClose={() => {
          if (scheduleWorkoutPickerVisible) {
            closeScheduleWorkoutPicker();
            return;
          }
          setModalVisible(false);
          setDetailedWorkout(null);
        }}
      >
         <StatusBar
            backgroundColor={theme.type === 'light' ? "rgba(0, 0, 0, 0.5)" : "black"}
            barStyle={'light-content'}
          />
        
        <View
          style={[
            styles.modalContainer,
            styles.modalContainerRelative,
            { backgroundColor: 'rgba(0, 0, 0, 0.5)' },
          ]}
        >
          <GestureDetector gesture={dayModalSwipeGesture}>
          <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
            {detailedWorkout ? (
              <>
                <View style={styles.modalDetailHeaderRow}>
                  <TouchableOpacity
                    style={styles.modalBarIconHit}
                    onPress={() => {
                      setDetailedWorkout(null);
                      setExercises([]);
                      setCompletionTime(null);
                    }}
                  >
                    <Ionicons
                      name='arrow-back'
                      size={scale(24)}
                      color={theme.text}
                    />
                  </TouchableOpacity>
                  <View
                    style={[
                      styles.modalWorkoutTitleCard,
                      {
                        borderColor: theme.border,
                        backgroundColor: theme.background,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.modalTitle,
                        styles.modalTitleInWorkoutCard,
                        { color: theme.text },
                      ]}
                    >
                      {detailedWorkout.workout.workout_name.trim() ===
                      detailedWorkout.workout.day_name.trim()
                        ? formatWorkoutHeaderTitle(
                            detailedWorkout.workout.workout_name,
                            detailedWorkout.workout.day_name
                          )
                        : detailedWorkout.workout.workout_name}
                    </Text>
                    {!!detailedWorkout.workout.workout_type && (
                      <Text
                        style={[
                          styles.modalSubtitle,
                          styles.modalSubtitleInWorkoutCard,
                          { color: theme.textSecondary, marginTop: 2 },
                        ]}
                      >
                        {detailedWorkout.workout.workout_type === 'cardio'
                          ? 'Cardio'
                          : 'Strength'}
                      </Text>
                    )}
                    <Text
                      style={[
                        styles.modalSubtitle,
                        styles.modalSubtitleInWorkoutCard,
                        { color: theme.text },
                      ]}
                    >
                      {detailedWorkout.workout.workout_name.trim() ===
                      detailedWorkout.workout.day_name.trim()
                        ? formatDate(detailedWorkout.workout.workout_date)
                        : `${detailedWorkout.workout.day_name} | ${formatDate(detailedWorkout.workout.workout_date)}`}
                    </Text>
                    {completionTime && (
                      <View style={styles.completionTimeContainer}>
                        <Ionicons
                          name='time-outline'
                          size={scale(16)}
                          color={theme.text}
                        />
                        <Text
                          style={[
                            styles.completionTimeText,
                            { color: theme.text },
                          ]}
                        >
                          {' '}
                          {formatCompletionTime(completionTime)}
                        </Text>
                      </View>
                    )}
                  </View>
                  <TouchableOpacity
                    style={styles.modalBarIconHit}
                    onPress={() => {
                      setModalVisible(false);
                      setDetailedWorkout(null);
                    }}
                  >
                    <Ionicons name='close' size={scale(24)} color={theme.text} />
                  </TouchableOpacity>
                </View>
                <GestureScrollView style={{ width: '100%', maxHeight: 400 }} showsVerticalScrollIndicator={false}>
                  {exercises.length > 0 ? (
                    exercises.map((exercise, index) => (
                      <View key={index} style={styles.modalExercise}>
                        <Text
                          style={[
                            styles.modalExerciseName,
                            { color: theme.text },
                          ]}
                        >
                          {exercise.exercise_name}
                        </Text>
                        {exercise.logs.length > 0 ? (
                          exercise.logs.map((log, logIndex) => (
                            <Text
                              key={logIndex}
                              style={[
                                styles.modalExerciseDetails,
                                { color: theme.text },
                              ]}
                            >
                              {t('Set')} {log.set_number}: {log.weight_logged}{' '}
                              {weightFormat} x {log.reps_logged} {t('Reps')}
                            </Text>
                          ))
                        ) : (
                          <Text
                            style={[
                              styles.modalExerciseDetails,
                              { color: theme.text },
                            ]}
                          >
                            {exercise.sets} {t('Sets')} x {exercise.reps}{' '}
                            {t('Reps')}
                          </Text>
                        )}
                      </View>
                    ))
                  ) : (
                    <Text style={[styles.emptyText, { color: theme.text }]}>
                      {t('noExerciseLogged')}
                    </Text>
                  )}
                </GestureScrollView>
              </>
            ) : (
              <>
                <View style={styles.modalListHeaderRow}>
                  <TouchableOpacity
                    style={styles.modalBarIconHit}
                    onPress={() => {
                      setModalVisible(false);
                      setDetailedWorkout(null);
                    }}
                  >
                    <Ionicons name='close' size={scale(24)} color={theme.text} />
                  </TouchableOpacity>
                </View>
                <Text
                  style={[
                    styles.modalTitle,
                    styles.modalTitleDayList,
                    { color: theme.text },
                  ]}
                >
                  {selectedDate
                    ? formatDate(selectedDate.getTime() / 1000)
                    : ''}
                </Text>
                {selectedDateWorkouts.length > 0 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.dayModalQuickActionsScroll}
                    contentContainerStyle={styles.dayModalQuickActionsContent}
                  >
                    <TouchableOpacity
                      style={[
                        styles.quickChip,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.background,
                        },
                      ]}
                      onPress={() => {
                        const startOne = (entry: WorkoutEntry) => {
                          setModalVisible(false);
                          navigation.navigate('StartedWorkoutInterface', {
                            workout_log_id: entry.workout.workout_log_id,
                          });
                        };
                        if (selectedDateWorkouts.length === 1) {
                          startOne(selectedDateWorkouts[0]);
                        } else {
                          Alert.alert(
                            t('startWorkout') || 'Start Workout',
                            t('whichWorkoutToStart') ||
                              'Which workout do you want to start?',
                            selectedDateWorkouts
                              .map((entry) => ({
                                text: entry.workout.day_name.trim(),
                                onPress: () => startOne(entry),
                              }))
                              .concat([
                                { text: t('Cancel'), style: 'cancel' as const },
                              ]),
                          );
                        }
                      }}
                    >
                      <Ionicons
                        name="play-circle-outline"
                        size={scale(18)}
                        color={theme.buttonBackground}
                      />
                      <Text
                        style={[styles.quickChipLabel, { color: theme.text }]}
                      >
                        {t('startWorkout') || 'Start'}
                      </Text>
                    </TouchableOpacity>
                    {selectedDateWorkouts.some((e) => !e.isLogged) ? (
                    <TouchableOpacity
                      style={[
                        styles.quickChip,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.background,
                        },
                      ]}
                      onPress={() => {
                        const unlogged = selectedDateWorkouts.filter(
                          (e) => !e.isLogged,
                        );
                        if (unlogged.length === 0) return;
                        const openLog = (entry: WorkoutEntry) => {
                          setModalVisible(false);
                          navigation.navigate('LogWeights', {
                            workout_log_id: entry.workout.workout_log_id,
                          });
                        };
                        if (unlogged.length === 1) {
                          openLog(unlogged[0]);
                        } else {
                          Alert.alert(
                            t('logWeights') || 'Log workout',
                            t('whichWorkoutToLog') ||
                              'Which workout do you want to log?',
                            unlogged
                              .map((entry) => ({
                                text: `${entry.workout.day_name} — ${entry.workout.workout_name}`,
                                onPress: () => openLog(entry),
                              }))
                              .concat([
                                { text: t('Cancel'), style: 'cancel' as const },
                              ]),
                          );
                        }
                      }}
                    >
                      <Ionicons
                        name="create-outline"
                        size={scale(18)}
                        color={theme.buttonBackground}
                      />
                      <Text
                        style={[styles.quickChipLabel, { color: theme.text }]}
                      >
                        {t('logWeights') || 'Log'}
                      </Text>
                    </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity
                      style={[
                        styles.quickChip,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.background,
                        },
                      ]}
                      onPress={() => {
                        if (selectedDateWorkouts.length === 1) {
                          openRescheduleFlow(selectedDateWorkouts[0]);
                        } else {
                          Alert.alert(
                            t('rescheduleWorkout') || 'Reschedule',
                            t('reschedulePickWorkout') ||
                              'Which workout do you want to reschedule?',
                            selectedDateWorkouts
                              .map((entry) => ({
                                text: entry.workout.workout_name,
                                onPress: () => openRescheduleFlow(entry),
                              }))
                              .concat([
                                { text: t('Cancel'), style: 'cancel' as const },
                              ]),
                          );
                        }
                      }}
                    >
                      <Ionicons
                        name="calendar-outline"
                        size={scale(18)}
                        color={theme.buttonBackground}
                      />
                      <Text
                        style={[styles.quickChipLabel, { color: theme.text }]}
                      >
                        {t('rescheduleWorkout') || 'Move'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.quickChip,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.background,
                        },
                      ]}
                      onPress={() => void openScheduleWorkoutPicker()}
                    >
                      <Ionicons
                        name="add"
                        size={scale(18)}
                        color={theme.buttonBackground}
                      />
                      <Text
                        style={[styles.quickChipLabel, { color: theme.text }]}
                      >
                        {t('scheduleWorkoutLog')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.quickChip,
                        {
                          borderColor: 'rgba(192, 57, 43, 0.45)',
                          backgroundColor: theme.background,
                        },
                      ]}
                      onPress={handleDeleteWorkoutPress}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={scale(18)}
                        color="#C0392B"
                      />
                      <Text style={[styles.quickChipLabel, { color: '#C0392B' }]}>
                        {t('remove') || 'Remove'}
                      </Text>
                    </TouchableOpacity>
                  </ScrollView>
                ) : null}
                {(() => {
                  if (selectedDateWorkouts.length === 0) {
                    return (
                      <Text
                        style={[
                          styles.emptyText,
                          { color: theme.text, padding: 20 },
                        ]}
                      >
                        {t('noWorkoutsScheduledForDate')}
                      </Text>
                    );
                  }

                  const isUpcoming =
                    new Date(
                      selectedDateWorkouts[0].workout.workout_date * 1000,
                    ).setHours(0, 0, 0, 0) > new Date().setHours(0, 0, 0, 0);

                  return (
                    <>
                      <ScrollView style={{ width: '100%', maxHeight: 220 }} showsVerticalScrollIndicator={false}>
                        {selectedDateWorkouts.map((entry, index) => (
                          <TouchableOpacity
                            key={index}
                            style={[
                              styles.modalWorkoutItem,
                              {
                                backgroundColor: theme.background,
                                borderColor: theme.border,
                              },
                            ]}
                            onPress={() => {
                              if (entry.isLogged || isUpcoming) {
                                setDetailedWorkout(entry);
                                fetchWorkoutDetails(
                                  entry.workout.workout_log_id,
                                  entry.isLogged,
                                );
                              } else {
                                setModalVisible(false);
                                handleUntrackedWorkoutPress(entry);
                              }
                            }}
                          >
                            <View style={{ flex: 1 }}>
                              {entry.workout.workout_name.trim() ===
                              entry.workout.day_name.trim() ? (
                                <Text
                                  style={[
                                    styles.modalDayListDayTitle,
                                    { color: theme.text },
                                  ]}
                                >
                                  {formatWorkoutHeaderTitle(
                                    entry.workout.workout_name,
                                    entry.workout.day_name
                                  )}
                                </Text>
                              ) : (
                                <>
                                  <Text
                                    style={[
                                      styles.modalDayListDayTitle,
                                      { color: theme.text },
                                    ]}
                                  >
                                    {entry.workout.day_name}
                                  </Text>
                                  <Text
                                    style={[
                                      styles.modalDayListWorkoutSubtitle,
                                      {
                                        color: theme.text,
                                        marginTop: moderateScale(4),
                                      },
                                    ]}
                                  >
                                    {entry.workout.workout_name}
                                  </Text>
                                </>
                              )}
                            </View>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </>
                  );
                })()}
                {selectedDateWorkouts.length === 0 ? (
                  <TouchableOpacity
                    style={[
                      styles.actionButton,
                      {
                        backgroundColor: theme.buttonBackground,
                        marginTop: 4,
                        width: '100%',
                      },
                    ]}
                    onPress={() => void openScheduleWorkoutPicker()}
                  >
                    <Ionicons
                      name="add"
                      size={scale(22)}
                      color={theme.buttonText}
                      style={styles.icon}
                    />
                    <Text
                      style={[
                        styles.actionButtonText,
                        { color: theme.buttonText },
                      ]}
                    >
                      {t('scheduleWorkoutLog')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </>
            )}
          </View>
          </GestureDetector>

          {scheduleWorkoutPickerVisible ? (
            <View
              style={styles.schedulePickerOverlay}
              pointerEvents="box-none"
            >
              <TouchableOpacity
                style={[StyleSheet.absoluteFillObject, styles.schedulePickerBackdrop]}
                activeOpacity={1}
                onPress={closeScheduleWorkoutPicker}
                accessibilityRole="button"
                accessibilityLabel={t('Cancel')}
              />
              <View
                style={[
                  styles.modalContent,
                  styles.schedulePickerModalContent,
                  styles.schedulePickerSheet,
                  { backgroundColor: theme.card },
                ]}
                pointerEvents="auto"
              >
                <View
                  style={[
                    styles.modalListHeaderRow,
                    schedulePickerStep === 'day'
                      ? { justifyContent: 'space-between' }
                      : { justifyContent: 'flex-end' },
                  ]}
                >
                  {schedulePickerStep === 'day' ? (
                    <TouchableOpacity
                      style={styles.modalBarIconHit}
                      onPress={resetSchedulePickerUi}
                      accessibilityRole="button"
                      accessibilityLabel={t('Back')}
                    >
                      <Ionicons
                        name="chevron-back"
                        size={scale(24)}
                        color={theme.text}
                      />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={styles.modalBarIconHit}
                    onPress={closeScheduleWorkoutPicker}
                    accessibilityRole="button"
                    accessibilityLabel={t('Cancel')}
                  >
                    <Ionicons name="close" size={scale(24)} color={theme.text} />
                  </TouchableOpacity>
                </View>
                <Text
                  style={[
                    styles.modalTitle,
                    styles.modalTitleDayList,
                    { color: theme.text },
                  ]}
                >
                  {schedulePickerStep === 'day'
                    ? t('selectDay')
                    : t('chooseWorkoutToSchedule')}
                </Text>
                {schedulePickerStep === 'workout' ? (
                  savedWorkoutsForSchedule.length === 0 ? (
                    <Text
                      style={[
                        styles.emptyText,
                        { color: theme.text, paddingVertical: 16 },
                      ]}
                    >
                      {t('noWorkoutsInLibrary')}
                    </Text>
                  ) : (
                    <ScrollView
                      style={styles.schedulePickerScroll}
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={false}
                    >
                      {savedWorkoutsForSchedule.map((w) => (
                        <TouchableOpacity
                          key={w.workout_id}
                          style={[
                            styles.modalWorkoutItem,
                            {
                              backgroundColor: theme.background,
                              borderColor: theme.border,
                            },
                          ]}
                          onPress={() =>
                            void handleScheduleWorkoutChosenInPicker(w.workout_id)
                          }
                        >
                          <Text
                            style={[
                              styles.modalWorkoutName,
                              { color: theme.text },
                            ]}
                          >
                            {w.workout_name}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  )
                ) : schedulePickerPendingWorkoutId != null ? (
                  <ScrollView
                    style={styles.schedulePickerScroll}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                  >
                    {schedulePickerDays.map((d) => (
                      <TouchableOpacity
                        key={d.day_id}
                        style={[
                          styles.modalWorkoutItem,
                          {
                            backgroundColor: theme.background,
                            borderColor: theme.border,
                          },
                        ]}
                        onPress={() =>
                          void scheduleSavedWorkoutForSelectedDay(
                            schedulePickerPendingWorkoutId,
                            d,
                          )
                        }
                      >
                        <Text
                          style={[
                            styles.modalWorkoutName,
                            { color: theme.text },
                          ]}
                        >
                          {d.day_name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      </Modal>
      )}

      {/* Reschedule workout modal */}
      <Modal
        visible={rescheduleModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setRescheduleModalVisible(false);
          setWorkoutToReschedule(null);
        }}
      >
        <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}>
          <View
            style={[styles.modalContent, styles.rescheduleModalContent, { backgroundColor: theme.card }]}
            pointerEvents="auto"
            collapsable={false}
          >
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              {t('rescheduleWorkout') || 'Reschedule workout'}
            </Text>
            {workoutToReschedule && (
              <>
                <Text style={[styles.modalSubtitle, { color: theme.text }]}>
                  {formatWorkoutHeaderTitle(
                    workoutToReschedule.workout.workout_name,
                    workoutToReschedule.workout.day_name
                  )}
                </Text>
                <Text style={[styles.rescheduleLabel, { color: theme.text }]}>
                  {t('chooseNewDate') || 'Choose new date'}
                </Text>
                <View style={[styles.rescheduleDateRow, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <TouchableOpacity
                    style={styles.rescheduleDateArrow}
                    onPress={() => {
                      const d = new Date(rescheduleNewDate);
                      d.setDate(d.getDate() - 1);
                      setRescheduleNewDate(d);
                    }}
                  >
                    <Ionicons name="chevron-back" size={scale(24)} color={theme.text} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.rescheduleDateCenter}
                    onPress={() => {
                      setRescheduleModalVisible(false);
                      setShowRescheduleDatePicker(true);
                    }}
                  >
                    <Text style={[styles.rescheduleDateText, { color: theme.text }]} numberOfLines={1}>
                      {rescheduleNewDate.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                    </Text>
                    <Text style={[styles.rescheduleDateHint, { color: theme.text }]}>
                      {t('tapToPickMonthYear') || 'Tap to pick month & year'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.rescheduleDateArrow}
                    onPress={() => {
                      const d = new Date(rescheduleNewDate);
                      d.setDate(d.getDate() + 1);
                      setRescheduleNewDate(d);
                    }}
                  >
                    <Ionicons name="chevron-forward" size={scale(24)} color={theme.text} />
                  </TouchableOpacity>
                </View>
                <View style={[styles.addToCalendarButtonRow, { marginTop: 24 }]}>
                  <TouchableOpacity
                    style={[styles.cancelButtonReschedule, { borderColor: theme.border }]}
                    onPress={() => {
                      setRescheduleModalVisible(false);
                      setWorkoutToReschedule(null);
                      setShowRescheduleDatePicker(false);
                    }}
                  >
                    <Text style={[styles.cancelButtonText, { color: theme.text }]}>{t('Cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.saveButtonReschedule, { backgroundColor: theme.buttonBackground }]}
                    onPress={() => confirmReschedule()}
                  >
                    <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('Confirm') || 'Confirm'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Modal to pick month & year (and day) - only when user taps the date row */}
      <Modal
        visible={showRescheduleDatePicker}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowRescheduleDatePicker(false);
          setRescheduleModalVisible(true);
        }}
      >
        <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}>
          <View style={[styles.rescheduleDatePickerCard, { backgroundColor: theme.card }]}>
            <Text style={[styles.rescheduleLabel, { color: theme.text }]}>
              {t('pickMonthYear') || 'Pick month & year'}
            </Text>
            <View
              style={[
                styles.rescheduleDatePickerContainer,
                {
                  backgroundColor: theme.type === 'dark' ? '#1C1C1E' : '#FFFFFF',
                  borderRadius: 12,
                  overflow: 'hidden',
                },
              ]}
            >
              <DateTimePicker
                value={rescheduleNewDate}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                {...(Platform.OS === 'ios' && {
                  themeVariant: theme.type === 'dark' ? 'dark' : 'light',
                  textColor: theme.type === 'dark' ? '#FFFFFF' : '#000000',
                })}
                onChange={(_, d) => {
                  if (d) setRescheduleNewDate(d);
                  if (Platform.OS !== 'ios') {
                    setShowRescheduleDatePicker(false);
                    setRescheduleModalVisible(true);
                  }
                }}
              />
            </View>
            <TouchableOpacity
              style={[styles.rescheduleDateDoneButton, { backgroundColor: theme.buttonBackground }]}
              onPress={() => {
                setShowRescheduleDatePicker(false);
                setRescheduleModalVisible(true);
              }}
            >
              <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('done') || 'Done'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Modal for Untracked Workout Choice */}
      <Modal
        visible={untrackedChoiceModalVisible}
        transparent={true}
        animationType='fade'
        onRequestClose={closeUntrackedModal}
      >


    {untrackedChoiceModalVisible && (
          <StatusBar
            backgroundColor={theme.type === 'light' ? "rgba(0, 0, 0, 0.5)" : "black"}
            barStyle={'light-content'}          />
        )}


        <View
          style={[
            styles.modalContainer,
            { backgroundColor: 'rgba(0, 0, 0, 0.5)' },
          ]}
        >
          <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
            <View style={styles.modalDetailHeaderRow}>
              <View
                style={[
                  styles.modalWorkoutTitleCard,
                  {
                    borderColor: theme.border,
                    backgroundColor: theme.background,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.modalTitle,
                    styles.modalTitleInWorkoutCard,
                    { color: theme.text },
                  ]}
                >
                  {selectedUntrackedWorkout &&
                  selectedUntrackedWorkout.workout.workout_name.trim() ===
                    selectedUntrackedWorkout.workout.day_name.trim()
                    ? formatWorkoutHeaderTitle(
                        selectedUntrackedWorkout.workout.workout_name,
                        selectedUntrackedWorkout.workout.day_name
                      )
                    : selectedUntrackedWorkout?.workout.workout_name}
                </Text>
                {selectedUntrackedWorkout && (
                  <Text
                    style={[
                      styles.modalSubtitle,
                      styles.modalSubtitleInWorkoutCard,
                      { color: theme.text },
                    ]}
                  >
                    {selectedUntrackedWorkout.workout.workout_name.trim() ===
                    selectedUntrackedWorkout.workout.day_name.trim()
                      ? formatDate(selectedUntrackedWorkout.workout.workout_date)
                      : `${selectedUntrackedWorkout.workout.day_name} | ${formatDate(selectedUntrackedWorkout.workout.workout_date)}`}
                  </Text>
                )}
              </View>
              <TouchableOpacity
                style={styles.modalBarIconHit}
                onPress={closeUntrackedModal}
              >
                <Ionicons name='close' size={scale(24)} color={theme.text} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={{
                width: '100%',
                maxHeight: 200,
                marginVertical: verticalScale(20),
              }}
            >
              {untrackedWorkoutDetails.map((exercise, index) => (
                <View key={index} style={styles.modalExercise}>
                  <Text
                    style={[
                      styles.modalExerciseName,
                      { color: theme.text, fontSize: moderateScale(18) },
                    ]}
                  >
                    {exercise.exercise_name}
                  </Text>
                  <Text
                    style={[
                      styles.modalExerciseDetails,
                      { color: theme.text, fontSize: moderateScale(14) },
                    ]}
                  >
                    {exercise.sets} {t('Sets')} x {exercise.reps} {t('Reps')}
                  </Text>
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={[
                styles.choiceButton,
                { backgroundColor: theme.buttonBackground },
              ]}
              onPress={() => {
                if (!selectedUntrackedWorkout) return;
                navigation.navigate('StartedWorkoutInterface', {
                  workout_log_id:
                    selectedUntrackedWorkout.workout.workout_log_id,
                });
                closeUntrackedModal();
              }}
            >
              <Ionicons
                name='stopwatch-outline'
                size={scale(22)}
                color={theme.buttonText}
                style={styles.icon}
              />
              <Text
                style={[styles.actionButtonText, { color: theme.buttonText }]}
              >
                {t('startWorkout')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.choiceButton,
                {
                  backgroundColor: theme.buttonBackground,
                  marginTop: verticalScale(15),
                },
              ]}
              onPress={() => {
                if (!selectedUntrackedWorkout) return;
                navigation.navigate('LogWeights', {
                  workout_log_id:
                    selectedUntrackedWorkout.workout.workout_log_id,
                });
                closeUntrackedModal();
              }}
            >
              <Ionicons
                name='stats-chart'
                size={scale(22)}
                color={theme.buttonText}
                style={styles.icon}
              />
              <Text
                style={[styles.actionButtonText, { color: theme.buttonText }]}
              >
                {t('logWeightsManually')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  contentContainer: {
    alignItems: 'center',
    paddingHorizontal: scale(20),
    paddingBottom: verticalScale(40),
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    maxWidth: 400,
    marginBottom: verticalScale(30),
  },
  actionButton: {
    borderRadius: 20,
    paddingVertical: verticalScale(10),
    paddingHorizontal: scale(20),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '48%',
  },
  actionButtonText: {
    fontWeight: 'bold',
    fontSize: moderateScale(14),
    textAlign: 'center',
  },
  deleteWorkoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(12),
    width: '100%',
  },
  deleteWorkoutButtonText: {
    fontWeight: '600',
    fontSize: moderateScale(14),
  },
  icon: {
    marginRight: scale(8),
  },

  modalTipText: {
    marginTop: verticalScale(10),
    textAlign: 'center',
    fontSize: moderateScale(14),
    fontStyle: 'italic',
    opacity: 0.8,
    marginBottom: verticalScale(10),
  },
  rescheduleModalContent: {
    padding: scale(20),
    minWidth: 280,
    elevation: 5,
    zIndex: 1,
  },
  schedulePickerModalContent: {
    maxHeight: '75%',
    alignSelf: 'center',
  },
  schedulePickerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    elevation: 20,
  },
  schedulePickerBackdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  schedulePickerSheet: {
    width: '90%',
    maxWidth: 400,
    zIndex: 1001,
    elevation: 21,
  },
  schedulePickerScroll: {
    width: '100%',
    maxHeight: 340,
  },
  rescheduleLabel: {
    fontSize: moderateScale(14),
    fontWeight: '600',
    marginTop: verticalScale(16),
    marginBottom: verticalScale(8),
  },
  rescheduleDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: verticalScale(8),
    paddingHorizontal: scale(8),
    borderRadius: 12,
    borderWidth: 1,
  },
  rescheduleDateArrow: {
    padding: scale(8),
    justifyContent: 'center',
  },
  rescheduleDateCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(8),
    paddingHorizontal: scale(8),
  },
  rescheduleDateText: {
    fontSize: moderateScale(16),
    fontWeight: '600',
  },
  rescheduleDateHint: {
    fontSize: moderateScale(12),
    opacity: 0.7,
    marginTop: 2,
  },
  rescheduleDateTouchable: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: verticalScale(12),
    paddingHorizontal: scale(16),
    borderRadius: 12,
    borderWidth: 1,
  },
  rescheduleDatePickerContainer: {
    minHeight: 320,
    alignItems: 'center',
    marginVertical: verticalScale(8),
    width: '100%',
  },
  rescheduleDatePickerCard: {
    borderRadius: 20,
    padding: scale(20),
    minWidth: 280,
    alignItems: 'center',
  },
  rescheduleDateDoneButton: {
    paddingVertical: verticalScale(14),
    paddingHorizontal: scale(24),
    borderRadius: 12,
    marginTop: verticalScale(8),
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  addToCalendarButtonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelButtonReschedule: {
    flex: 1,
    paddingVertical: verticalScale(14),
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonReschedule: {
    flex: 1,
    paddingVertical: verticalScale(14),
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    fontWeight: '600',
    fontSize: moderateScale(15),
  },
  emptyText: {
    fontSize: moderateScale(16),
    textAlign: 'center',
    opacity: 0.7,
  },
  // Calendar Styles
  calendarContainer: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 20,
    paddingVertical: moderateScale(12),
    paddingHorizontal: moderateScale(12),
    marginTop: verticalScale(4),
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 4,
  },
  calendarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(8),
    paddingHorizontal: scale(2),
  },
  calendarTitleBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: scale(4),
  },
  calendarMonthText: {
    fontSize: moderateScale(24),
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  calendarYearSub: {
    fontSize: moderateScale(14),
    fontWeight: '600',
    marginTop: verticalScale(2),
    opacity: 0.85,
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  weekdayHeaderCell: {
    width: `${100 / 7}%`,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: verticalScale(6),
    marginBottom: verticalScale(2),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  weekDayText: {
    fontSize: moderateScale(11),
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  calendarMicroLegend: {
    fontSize: moderateScale(11),
    textAlign: 'center',
    marginTop: verticalScale(8),
    marginBottom: verticalScale(6),
    paddingHorizontal: scale(16),
    lineHeight: moderateScale(15),
    opacity: 0.75,
  },
  dayModalQuickActionsScroll: {
    width: '100%',
    maxHeight: verticalScale(44),
    marginBottom: verticalScale(10),
    flexGrow: 0,
  },
  dayModalQuickActionsContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: scale(8),
  },
  quickChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: verticalScale(8),
    paddingHorizontal: scale(12),
    borderRadius: 20,
    borderWidth: 1,
    marginRight: scale(8),
  },
  quickChipLabel: {
    marginLeft: scale(6),
    fontSize: moderateScale(13),
    fontWeight: '700',
  },
  // Modal Styles
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContainerRelative: {
    position: 'relative',
  },
  modalContent: {
    borderRadius: 20,
    padding: moderateScale(20),
    width: '90%',
    maxWidth: 400,
    alignItems: 'center',
    position: 'relative',
  },
  modalDetailHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    width: '100%',
    marginBottom: moderateScale(12),
  },
  modalListHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    width: '100%',
    marginBottom: moderateScale(8),
  },
  modalWorkoutTitleCard: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 12,
    padding: moderateScale(12),
    marginHorizontal: moderateScale(4),
  },
  modalBarIconHit: {
    padding: moderateScale(5),
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: moderateScale(24),
    fontWeight: '900',
    marginBottom: verticalScale(10),
    textAlign: 'center',
    marginTop: verticalScale(20),
  },
  modalTitleInWorkoutCard: {
    marginTop: 0,
    marginBottom: verticalScale(6),
    textAlign: 'left',
  },
  modalTitleDayList: {
    marginTop: 0,
    width: '100%',
  },
  modalSubtitleInWorkoutCard: {
    textAlign: 'left',
    marginBottom: verticalScale(8),
  },
  modalSubtitle: {
    fontSize: moderateScale(18),
    fontWeight: '700',
    marginBottom: verticalScale(20),
    textAlign: 'center',
  },
  modalExercise: { marginBottom: verticalScale(15), width: '100%' },
  modalExerciseName: {
    fontSize: moderateScale(20),
    fontWeight: '800',
    textAlign: 'center',
  },
  modalExerciseDetails: {
    fontSize: moderateScale(16),
    textAlign: 'center',
    opacity: 0.8,
  },
  modalWorkoutItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: moderateScale(15),
    borderRadius: 15,
    marginBottom: verticalScale(10),
    borderWidth: 0,
  },
  modalWorkoutName: {
    fontSize: moderateScale(18),
    fontWeight: 'bold',
  },
  /** Calendar day modal: workout day (e.g. Push) — primary line */
  modalDayListDayTitle: {
    fontSize: moderateScale(20),
    fontWeight: '700',
  },
  /** Calendar day modal: plan/workout name — secondary line */
  modalDayListWorkoutSubtitle: {
    fontSize: moderateScale(14),
    fontWeight: '400',
    opacity: 0.9,
  },
  modalLegendContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: verticalScale(15),
    marginTop: verticalScale(5),
  },
  modalLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: scale(15),
  },
  modalLegendText: {
    marginLeft: scale(5),
    fontSize: moderateScale(14),
  },
  completionTimeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: verticalScale(15),
  },
  completionTimeText: {
    fontSize: moderateScale(16),
    fontWeight: '600',
  },
  choiceButton: {
    borderRadius: 20,
    paddingVertical: verticalScale(12),
    paddingHorizontal: scale(16),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '80%',
  },
  activeWorkoutBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: scale(12),
    paddingVertical: verticalScale(12),
    paddingHorizontal: scale(14),
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: verticalScale(14),
  },
  activeWorkoutBannerText: {
    flex: 1,
    fontFamily: 'Jost_500Medium',
    fontSize: moderateScale(15),
    lineHeight: moderateScale(21),
  },
  activeWorkoutBannerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: scale(8),
  },
  activeWorkoutBannerButton: {
    paddingVertical: verticalScale(8),
    paddingHorizontal: scale(14),
    borderRadius: 20,
  },
  activeWorkoutBannerButtonOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  activeWorkoutBannerButtonText: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: moderateScale(15),
  },
});