import { useFocusEffect } from '@react-navigation/native'; // Import useFocusEffect
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, ScrollView, Text, StyleSheet, FlatList, TouchableOpacity, Pressable, Alert, Modal, TextInput, Animated, Linking, Keyboard, TouchableWithoutFeedback, StatusBar, Platform } from 'react-native'; // Import StatusBar
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { useRoute, useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSQLiteContext } from 'expo-sqlite';
import { AutoSizeText, ResizeTextMode } from 'react-native-auto-size-text';
import { useTheme } from '../context/ThemeContext';
import { WorkoutStackParamList } from '../App';
import { StackNavigationProp } from '@react-navigation/stack';
import { useTranslation } from 'react-i18next';
import { exportWorkout } from '../utils/workoutSharingUtils';
import {
  isWarmupOrCooldownExerciseName,
  sortWorkoutPlanExercisesForDisplay,
} from '../utils/workoutDisplayUtils';
import {
  ensureCardioExerciseName,
  formatCardioDistanceForDb,
} from '../utils/cardioExerciseUtils';
import { DEFAULT_REST_SECONDS_BETWEEN_SETS } from '../utils/startedWorkoutPreferenceUtils';

type WorkoutListNavigationProp = StackNavigationProp<WorkoutStackParamList, 'WorkoutDetails'>;

type Day = {
  day_id: number;
  day_name: string;
  exercises: { exercise_id: number; exercise_name: string; sets: number; reps: number; web_link: string | null; muscle_group: string | null; exercise_notes: string | null; rest_seconds: number | null; sort_order?: number | null }[];
};

export default function WorkoutDetails() {
  const db = useSQLiteContext();
  const route = useRoute();
 
  const { theme } = useTheme();
  const { t } = useTranslation(); // Initialize translations
  
  const { workout_id } = route.params as { workout_id: number };

  const [workoutName, setWorkoutName] = useState('');
  const [workoutPlanType, setWorkoutPlanType] = useState<'strength' | 'cardio'>('strength');
  const [days, setDays] = useState<Day[]>([]);
  const [showDayModal, setShowDayModal] = useState(false);
  const [dayName, setDayName] = useState('');

  const [showExerciseModal, setShowExerciseModal] = useState(false);
  const [currentDayId, setCurrentDayId] = useState<number | null>(null);
  const [exerciseName, setExerciseName] = useState('');
  const [exerciseSets, setExerciseSets] = useState('');
  const [exerciseReps, setExerciseReps] = useState('');
  const [exerciseRestSeconds, setExerciseRestSeconds] = useState(
    String(DEFAULT_REST_SECONDS_BETWEEN_SETS),
  );
  const [exerciseWebLink, setExerciseWebLink] = useState('');
  const [exerciseNotesInput, setExerciseNotesInput] = useState('');
  const [newExerciseMuscleGroup, setNewExerciseMuscleGroup] = useState<string | null>(null);
  const [exerciseCardioDuration, setExerciseCardioDuration] = useState('');
  const [exerciseCardioDistance, setExerciseCardioDistance] = useState('');
  const [exerciseCardioDistUnit, setExerciseCardioDistUnit] = useState<'km' | 'mi'>('km');
  const [showWebLinkModal, setShowWebLinkModal] = useState(false);
  const [editingExercise, setEditingExercise] = useState<{ exercise_id: number; exercise_name: string | null; web_link: string | null; muscle_group: string | null; exercise_notes: string | null; sets: number; reps: number; rest_seconds: number | null } | null>(null);
  const [webLinkInput, setWebLinkInput] = useState('');
  const [editingMuscleGroup, setEditingMuscleGroup] = useState<string | null>(null);
  const navigation = useNavigation<WorkoutListNavigationProp>();
  const [isReordering, setIsReordering] = useState(false);
  const [collapsedDayIds, setCollapsedDayIds] = useState<Set<number>>(new Set());
  const [daysToScheduleIds, setDaysToScheduleIds] = useState<Set<number>>(new Set());
  const [showAddToCalendarModal, setShowAddToCalendarModal] = useState(false);
  const [showEditDayModal, setShowEditDayModal] = useState(false);
  const [editingDayId, setEditingDayId] = useState<number | null>(null);
  const [editDayNameInput, setEditDayNameInput] = useState('');
  const [addToCalendarStartDate, setAddToCalendarStartDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const fadeAnim = useRef(new Animated.Value(1)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const toggleDayExpanded = useCallback((dayId: number) => {
    setCollapsedDayIds((prev) => {
      const next = new Set(prev);
      if (next.has(dayId)) next.delete(dayId);
      else next.add(dayId);
      return next;
    });
  }, []);

  const openScheduleModalForDayIds = useCallback((ids: number[]) => {
    setDaysToScheduleIds(new Set(ids));
    setShowAddToCalendarModal(true);
  }, []);

  const closeAddToCalendarModal = useCallback(() => {
    setShowAddToCalendarModal(false);
    setDaysToScheduleIds(new Set());
  }, []);

  const scheduleDaysToCalendar = useCallback(async () => {
    if (daysToScheduleIds.size === 0 || !workoutName.trim()) return;
    const orderedDays = days.filter((d) => daysToScheduleIds.has(d.day_id));
    if (orderedDays.length === 0) return;
    try {
      // Defensive migration: some older DBs don't have notification_id yet.
      await db.runAsync('ALTER TABLE Workout_Log ADD COLUMN notification_id TEXT;').catch(() => {});
      await db.runAsync('ALTER TABLE Workout_Log ADD COLUMN completion_time INTEGER;').catch(() => {});
      await db.runAsync("ALTER TABLE Workout_Log ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';").catch(() => {});
      await db.runAsync("ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';").catch(() => {});
      const wtRows = await db.getAllAsync<{ workout_type: string }>(
        'SELECT workout_type FROM Workouts WHERE workout_id = ?;',
        [workout_id],
      );
      const workoutType = wtRows[0]?.workout_type === 'cardio' ? 'cardio' : 'strength';
      const baseTimestamp = Math.floor(addToCalendarStartDate.getTime() / 1000);
      for (let i = 0; i < orderedDays.length; i++) {
        const day = orderedDays[i];
        const workoutDate = baseTimestamp + i * 86400;
        const { lastInsertRowId: workoutLogId } = await db.runAsync(
          'INSERT OR REPLACE INTO Workout_Log (workout_date, day_name, workout_name, notification_id, workout_type) VALUES (?, ?, ?, ?, ?);',
          [workoutDate, day.day_name, workoutName.trim(), null, workoutType]
        );
        if (workoutType !== 'cardio') {
          for (const ex of day.exercises) {
            await db.runAsync(
              'INSERT INTO Logged_Exercises (workout_log_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
              [workoutLogId, ex.exercise_name, ex.sets, ex.reps, ex.web_link, ex.muscle_group, ex.exercise_notes, ex.rest_seconds ?? null]
            );
          }
        }
      }
      closeAddToCalendarModal();
      Alert.alert(t('Success') || 'Success', t('addToCalendarSuccess') || 'Days added to calendar.');
    } catch (e) {
      console.error(e);
      Alert.alert(t('errorTitle'), t('failedToAddToCalendar') || 'Failed to add to calendar.');
    }
  }, [db, days, workoutName, daysToScheduleIds, addToCalendarStartDate, t, closeAddToCalendarModal]);

  useFocusEffect(
    React.useCallback(() => {
      fetchWorkoutDetails();
    }, [workout_id])
  );

  const fetchWorkoutDetails = async () => {
    await db.runAsync("ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';").catch(() => {});
    const workoutResult = await db.getAllAsync<{ workout_name: string; workout_type?: string | null }>(
      'SELECT workout_name, workout_type FROM Workouts WHERE workout_id = ?',
      [workout_id]
    );
    setWorkoutName(workoutResult[0]?.workout_name || '');
    setWorkoutPlanType(
      (workoutResult[0]?.workout_type || 'strength').toLowerCase() === 'cardio' ? 'cardio' : 'strength',
    );
    
    const daysResult = await db.getAllAsync<{ day_id: number; day_name: string }>(
      'SELECT day_id, day_name FROM Days WHERE workout_id = ?',
      [workout_id]
    );

    // Ensure Exercises has sort_order column and backfill so we can reorder within a day
    try {
      const tableInfo = await db.getAllAsync<{ name: string }>('PRAGMA table_info(Exercises);');
      if (!tableInfo.some((c) => c.name === 'sort_order')) {
        await db.runAsync('ALTER TABLE Exercises ADD COLUMN sort_order INTEGER;');
      }
      // Backfill NULL sort_order: per day_id, set sort_order = 0,1,2,... by exercise_id
      const daysForBackfill = await db.getAllAsync<{ day_id: number }>('SELECT DISTINCT day_id FROM Exercises;');
      for (const { day_id } of daysForBackfill) {
        const rows = await db.getAllAsync<{ exercise_id: number }>('SELECT exercise_id FROM Exercises WHERE day_id = ? ORDER BY exercise_id;', [day_id]);
        for (let i = 0; i < rows.length; i++) {
          await db.runAsync('UPDATE Exercises SET sort_order = ? WHERE exercise_id = ?;', [i, rows[i].exercise_id]);
        }
      }
    } catch (e) {
      console.warn('Exercise sort_order migration:', e);
    }

    const daysWithExercises = await Promise.all(
      daysResult.map(async (day) => {
        const exercises = await db.getAllAsync<{ exercise_id: number; exercise_name: string; sets: number; reps: number; web_link: string; muscle_group: string | null; exercise_notes: string | null; rest_seconds: number | null; sort_order: number | null }>(
          'SELECT exercise_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order FROM Exercises WHERE day_id = ? ORDER BY COALESCE(sort_order, 999999), exercise_id;',
          [day.day_id]
        );
        const sorted = sortWorkoutPlanExercisesForDisplay(exercises);
        for (let i = 0; i < sorted.length; i++) {
          await db.runAsync('UPDATE Exercises SET sort_order = ? WHERE exercise_id = ?;', [
            i,
            sorted[i].exercise_id,
          ]);
        }
        return { ...day, exercises: sorted };
      })
    );

     // Sort days by day_id in ascending order
     const sortedDays = daysWithExercises.sort((a, b) => a.day_id - b.day_id);

     setDays(sortedDays);
     // Default all days to collapsed
     setCollapsedDayIds(new Set(sortedDays.map((d) => d.day_id)));
  };

  const handleDeleteDay = async (day_id: number, day_name: string, workout_id: number) => {
    Alert.alert(
      t('deleteDayTitleDetails'),
      t('deleteDayMessageDetails'),
      [
        { text: t('alertCancel'), style: 'cancel' },
        {
          text: t('alertDelete'),
          style: 'destructive',
          onPress: async () => {
            try {
              const currentDate = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000); // Today's date as Unix timestamp
  
              // Use a transaction to ensure all operations succeed or fail together
              await db.withTransactionAsync(async () => {
              // Fetch logs only for workout_date >= today
              const logs = await db.getAllAsync<{ workout_log_id: number; workout_date: number }>(
                'SELECT workout_log_id, workout_date FROM Workout_Log WHERE day_name = ? AND workout_name = (SELECT workout_name FROM Workouts WHERE workout_id = ?) AND workout_date >= ?;',
                [day_name, workout_id, currentDate]
              );
  
                // Delete all associated future logs
              for (const log of logs) {
                console.log(`Deleting log ${log.workout_log_id} with workout_date: ${log.workout_date}`);
                await db.runAsync('DELETE FROM Logged_Exercises WHERE workout_log_id = ?;', [log.workout_log_id]);
                await db.runAsync('DELETE FROM Workout_Log WHERE workout_log_id = ?;', [log.workout_log_id]);
              }
  
                // Delete the day and its exercises
              await db.runAsync('DELETE FROM Exercises WHERE day_id = ?;', [day_id]);
              await db.runAsync('DELETE FROM Days WHERE day_id = ?;', [day_id]);
              });
  
              fetchWorkoutDetails();
            } catch (error) {
              console.error('Error deleting day with future logs:', error);
              Alert.alert(t('errorTitle'), 'Error deleting day and associated logs.');
            }
          },
        },
      ]
    );
  };
  
  const handleDeleteExercise = async (day_id: number, exercise_name: string, workout_id: number) => {
    Alert.alert(
      t('deleteExerciseTitleDetails'),
      t('deleteExerciseMessageDetails'),
      [
        { text: t('alertCancel'), style: 'cancel' },
        {
          text: t('alertDelete'),
          style: 'destructive',
          onPress: async () => {
            try {
              const currentDate = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000); // Today's date as Unix timestamp
  
              // Use a transaction to ensure all operations succeed or fail together
              await db.withTransactionAsync(async () => {
                // Get day name for this day_id
                const dayResult = await db.getAllAsync<{ day_name: string }>(
                  'SELECT day_name FROM Days WHERE day_id = ?',
                  [day_id]
                );
                
                const dayName = dayResult[0]?.day_name;
                
                if (dayName) {
                  // Get workout name for this workout_id
                  const workoutResult = await db.getAllAsync<{ workout_name: string }>(
                    'SELECT workout_name FROM Workouts WHERE workout_id = ?',
                    [workout_id]
                  );
                  
                  const workoutName = workoutResult[0]?.workout_name;
                  
                  if (workoutName) {
              // Fetch logs only for workout_date >= today
              const logs = await db.getAllAsync<{ workout_log_id: number; workout_date: number }>(
                      'SELECT workout_log_id, workout_date FROM Workout_Log WHERE day_name = ? AND workout_name = ? AND workout_date >= ?;',
                      [dayName, workoutName, currentDate]
              );
  
                    // Delete the exercise from all future logs
              for (const log of logs) {
                      console.log(`Deleting exercise ${exercise_name} from log ${log.workout_log_id} with workout_date: ${log.workout_date}`);
                await db.runAsync(
                  'DELETE FROM Logged_Exercises WHERE workout_log_id = ? AND exercise_name = ?;',
                  [log.workout_log_id, exercise_name]
                );
                    }
                  }
              }
  
              // Delete the exercise itself
              await db.runAsync('DELETE FROM Exercises WHERE day_id = ? AND exercise_name = ?;', [day_id, exercise_name]);
              });
  
              fetchWorkoutDetails();
            } catch (error) {
              console.error('Error deleting exercise with future logs:', error);
              Alert.alert(t('errorTitle'), 'Error deleting exercise from future logs.');
            }
          },
        },
      ]
    );
  };
  

  const updateWorkoutLogsForAdditions = async (workout_id: number) => {
    try {
      const currentDate = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000); // Today's date as Unix timestamp
  
      // Fetch all logs for the current workout where workout_date >= today
      const logs = await db.getAllAsync<{ workout_log_id: number; day_name: string; workout_date: number }>(
        'SELECT workout_log_id, day_name, workout_date FROM Workout_Log WHERE workout_name = (SELECT workout_name FROM Workouts WHERE workout_id = ?) AND workout_date >= ?;',
        [workout_id, currentDate]
      );
  
      // Fetch updated days and exercises
      const days = await db.getAllAsync<{ day_id: number; day_name: string }>(
        'SELECT day_id, day_name FROM Days WHERE workout_id = ?;',
        [workout_id]
      );
  
      for (const log of logs) {
        const day = days.find((d) => d.day_name === log.day_name);
  
        if (day) {
          console.log(`Updating log ${log.workout_log_id} for day: ${day.day_name}`);
  
          // Fetch to be updated exercises for the day
          const exercises = await db.getAllAsync<{ exercise_name: string; sets: number; reps: number; web_link: string | null; muscle_group: string | null; exercise_notes: string | null; rest_seconds: number | null }>(
            'SELECT exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds FROM Exercises WHERE day_id = ?;',
            [day.day_id]
          );
  
          // Delete existing logged exercises for the log
          await db.runAsync('DELETE FROM Logged_Exercises WHERE workout_log_id = ?;', [log.workout_log_id]);
  
          // Insert updated exercises into the log
          const insertExercisePromises = exercises.map((exercise) =>
            db.runAsync(
              'INSERT INTO Logged_Exercises (workout_log_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
              [log.workout_log_id, exercise.exercise_name, exercise.sets, exercise.reps, exercise.web_link, exercise.muscle_group, exercise.exercise_notes, exercise.rest_seconds ?? null]
            )
          );
  
          await Promise.all(insertExercisePromises);
  
          console.log(`Successfully updated log ${log.workout_log_id} with new exercises.`);
        } else {
          console.log(`No matching day found for log ${log.workout_log_id} and day_name: ${log.day_name}`);
        }
      }
    } catch (error) {
      console.error('Error updating workout logs for additions:', error);
    }
  };
  
  const openAddDayModal = () => {
    setDayName('');
    setShowDayModal(true);
  };

  const closeAddDayModal = () => {
    setShowDayModal(false);
    setDayName('');
  };

  const addDay = async () => {
    if (!dayName.trim()) {
      Alert.alert(t('errorTitle'), t('dayNameValidationError'));
      return;
    }

    await db.runAsync('INSERT INTO Days (workout_id, day_name) VALUES (?, ?);', [workout_id, dayName.trim()]);
    await updateWorkoutLogsForAdditions(workout_id);
    fetchWorkoutDetails();
    closeAddDayModal();
  };

  const openEditDayModal = (day: Day) => {
    setEditingDayId(day.day_id);
    setEditDayNameInput(day.day_name);
    setShowEditDayModal(true);
  };

  const closeEditDayModal = () => {
    setShowEditDayModal(false);
    setEditingDayId(null);
    setEditDayNameInput('');
  };

  const saveRenamedDay = async () => {
    if (editingDayId == null) return;
    const trimmed = editDayNameInput.trim();
    if (!trimmed) {
      Alert.alert(t('errorTitle'), t('dayNameValidationError'));
      return;
    }
    try {
      const before = await db.getAllAsync<{ day_name: string }>('SELECT day_name FROM Days WHERE day_id = ?;', [editingDayId]);
      const oldName = before[0]?.day_name;
      if (!oldName || oldName === trimmed) {
        closeEditDayModal();
        return;
      }
      const currentDate = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      await db.withTransactionAsync(async () => {
        await db.runAsync('UPDATE Days SET day_name = ? WHERE day_id = ?;', [trimmed, editingDayId]);
        await db.runAsync(
          'UPDATE Workout_Log SET day_name = ? WHERE workout_name = ? AND day_name = ? AND workout_date >= ?;',
          [trimmed, workoutName.trim(), oldName, currentDate]
        );
      });
      await updateWorkoutLogsForAdditions(workout_id);
      fetchWorkoutDetails();
      closeEditDayModal();
    } catch (error) {
      console.error('Error renaming day:', error);
      Alert.alert(t('errorTitle'), 'Could not rename day.');
    }
  };

  const showDayRowActions = (day: Day) => {
    Alert.alert(day.day_name, undefined, [
      {
        text: t('addToSchedule') || 'Add to schedule',
        onPress: () => openScheduleModalForDayIds([day.day_id]),
      },
      {
        text: t('edit'),
        onPress: () => openEditDayModal(day),
      },
      {
        text: t('Delete'),
        style: 'destructive',
        onPress: () => handleDeleteDay(day.day_id, day.day_name, workout_id),
      },
      { text: t('alertCancel'), style: 'cancel' },
    ]);
  };

  const openAddExerciseModal = (day_id: number) => {
    setCurrentDayId(day_id);
    setExerciseName('');
    setExerciseSets('');
    setExerciseReps('');
    setExerciseRestSeconds(String(DEFAULT_REST_SECONDS_BETWEEN_SETS));
    setExerciseWebLink('');
    setExerciseNotesInput('');
    setNewExerciseMuscleGroup(null);
    setExerciseCardioDuration('');
    setExerciseCardioDistance('');
    setExerciseCardioDistUnit('km');
    setShowExerciseModal(true);
  };

  const closeAddExerciseModal = () => {
    setShowExerciseModal(false);
    setCurrentDayId(null);
  };

  const addExercise = async () => {
    const webLink = exerciseWebLink.trim();

    if (!exerciseName.trim()) {
      Alert.alert(t('errorTitle'), t('exerciseNameValidationError'));
      return;
    }

    if (webLink && !webLink.startsWith('http://') && !webLink.startsWith('https://')) {
      Alert.alert(
        t('invalidLinkTitle'),
        t('invalidLinkMessage')
      );
      return;
    }

    if (currentDayId == null) return;

    const maxOrder = await db.getAllAsync<{ max_sort: number | null }>(
      'SELECT MAX(sort_order) AS max_sort FROM Exercises WHERE day_id = ?;',
      [currentDayId]
    );
    const nextOrder = (maxOrder[0]?.max_sort ?? -1) + 1;

    if (workoutPlanType === 'cardio') {
      const durParsed = parseFloat(exerciseCardioDuration.trim().replace(',', '.'));
      if (!Number.isFinite(durParsed) || durParsed <= 0) {
        Alert.alert(
          t('errorTitle'),
          t('cardioDurationRequired') || 'Enter a duration in minutes greater than zero.',
        );
        return;
      }
      const durMinutes = Math.max(1 / 60, durParsed);
      const roundedForDb = Math.max(1, Math.round(durMinutes));
      const displayName = ensureCardioExerciseName(exerciseName.trim());
      const distDb = formatCardioDistanceForDb(exerciseCardioDistance, exerciseCardioDistUnit);
      try {
        await db.runAsync(
          `INSERT INTO Exercises (day_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order, exercise_type, duration_minutes, cardio_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            currentDayId,
            displayName,
            1,
            roundedForDb,
            webLink || null,
            null,
            exerciseNotesInput.trim(),
            DEFAULT_REST_SECONDS_BETWEEN_SETS,
            nextOrder,
            'cardio',
            roundedForDb,
            distDb,
          ],
        );
      } catch {
        await db.runAsync(
          'INSERT INTO Exercises (day_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
          [
            currentDayId,
            displayName,
            1,
            roundedForDb,
            webLink || null,
            null,
            exerciseNotesInput.trim(),
            DEFAULT_REST_SECONDS_BETWEEN_SETS,
            nextOrder,
          ],
        );
      }
      await updateWorkoutLogsForAdditions(workout_id);
      fetchWorkoutDetails();
      closeAddExerciseModal();
      return;
    }

    const sets = exerciseSets.trim();
    const reps = exerciseReps.trim();
    if (!sets || parseInt(sets, 10) <= 0) {
      Alert.alert(t('errorTitle'), t('setsValidationError'));
      return;
    }

    if (!reps || parseInt(reps, 10) <= 0) {
      Alert.alert(t('errorTitle'), t('repsValidationError'));
      return;
    }

    const restParsed = exerciseRestSeconds.trim()
      ? parseInt(exerciseRestSeconds.trim(), 10)
      : NaN;
    const restSec =
      Number.isFinite(restParsed) && restParsed > 0
        ? restParsed
        : DEFAULT_REST_SECONDS_BETWEEN_SETS;
    await db.runAsync(
      'INSERT INTO Exercises (day_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
      [
        currentDayId,
        exerciseName.trim(),
        parseInt(sets, 10),
        parseInt(reps, 10),
        webLink || null,
        newExerciseMuscleGroup || null,
        exerciseNotesInput.trim(),
        restSec,
        nextOrder,
      ],
    );
    await updateWorkoutLogsForAdditions(workout_id);
    fetchWorkoutDetails();
    closeAddExerciseModal();
  };
  
  // Function to animate the reordering state change
  const animateReordering = (reordering: boolean) => {
    // Create animation sequence
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: reordering ? 0.7 : 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: reordering ? 0.98 : 1,
        duration: 200,
        useNativeDriver: true,
      })
    ]).start();
  };

  // Update animation when reordering state changes
  useEffect(() => {
    animateReordering(isReordering);
  }, [isReordering]);

  // Function to move a day up (swap with the previous day)
  const moveDayUp = async (index: number) => {
    if (index <= 0 || index >= days.length || isReordering) return; // Can't move first day up
    
    setIsReordering(true);
    try {
      const currentDay = days[index];
      const prevDay = days[index - 1];
      
      // PRAGMA must run outside a transaction; disable FKs so temp day_ids don't violate constraints
      await db.runAsync('PRAGMA foreign_keys = OFF');
      try {
        await db.withTransactionAsync(async () => {
          // Temporarily change exercise day_ids, then swap Days rows, then assign exercises back
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [-1 * currentDay.day_id, currentDay.day_id]);
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [-1 * prevDay.day_id, prevDay.day_id]);
          await db.runAsync('UPDATE Days SET day_id = ? WHERE day_id = ?', [-999, currentDay.day_id]); 
          await db.runAsync('UPDATE Days SET day_id = ? WHERE day_id = ?', [currentDay.day_id, prevDay.day_id]);
          await db.runAsync('UPDATE Days SET day_id = ? WHERE day_id = ?', [prevDay.day_id, -999]);
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [prevDay.day_id, -1 * currentDay.day_id]);
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [currentDay.day_id, -1 * prevDay.day_id]);
        });
      } finally {
        await db.runAsync('PRAGMA foreign_keys = ON');
      }
      
      await updateWorkoutLogsForReordering(workout_id);
      await fetchWorkoutDetails();
    } catch (error) {
      console.error('Database operation failed:', error);
      Alert.alert(t('errorTitle'), t('failedToReorderDays') || 'Failed to reorder days.');
    } finally {
      setIsReordering(false);
    }
  };

  // Function to move a day down (swap with the next day)
  const moveDayDown = async (index: number) => {
    if (index < 0 || index >= days.length - 1 || isReordering) return; // Can't move last day down
    
    setIsReordering(true);
    try {
      const currentDay = days[index];
      const nextDay = days[index + 1];
      
      await db.runAsync('PRAGMA foreign_keys = OFF');
      try {
        await db.withTransactionAsync(async () => {
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [-1 * currentDay.day_id, currentDay.day_id]);
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [-1 * nextDay.day_id, nextDay.day_id]);
          await db.runAsync('UPDATE Days SET day_id = ? WHERE day_id = ?', [-999, currentDay.day_id]);
          await db.runAsync('UPDATE Days SET day_id = ? WHERE day_id = ?', [currentDay.day_id, nextDay.day_id]);
          await db.runAsync('UPDATE Days SET day_id = ? WHERE day_id = ?', [nextDay.day_id, -999]);
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [nextDay.day_id, -1 * currentDay.day_id]);
          await db.runAsync('UPDATE Exercises SET day_id = ? WHERE day_id = ?', 
            [currentDay.day_id, -1 * nextDay.day_id]);
        });
      } finally {
        await db.runAsync('PRAGMA foreign_keys = ON');
      }
      
      await updateWorkoutLogsForReordering(workout_id);
      await fetchWorkoutDetails();
    } catch (error) {
      console.error('Database operation failed:', error);
      Alert.alert(t('errorTitle'), t('failedToReorderDays') || 'Failed to reorder days.');
    } finally {
      setIsReordering(false);
    }
  };

  // Move an exercise up within its day (swap with previous exercise)
  const moveExerciseUp = async (day_id: number, index: number) => {
    if (index <= 0 || isReordering) return;
    const day = days.find((d) => d.day_id === day_id);
    if (!day || index >= day.exercises.length) return;
    const current = day.exercises[index];
    const prev = day.exercises[index - 1];
    const curOrder = current.sort_order ?? current.exercise_id;
    const prevOrder = prev.sort_order ?? prev.exercise_id;
    setIsReordering(true);
    try {
      await db.runAsync('UPDATE Exercises SET sort_order = ? WHERE exercise_id = ?;', [prevOrder, current.exercise_id]);
      await db.runAsync('UPDATE Exercises SET sort_order = ? WHERE exercise_id = ?;', [curOrder, prev.exercise_id]);
      await updateWorkoutLogsForReordering(workout_id);
      await fetchWorkoutDetails();
    } catch (error) {
      console.error('Exercise reorder failed:', error);
      Alert.alert(t('errorTitle'), t('failedToReorderExercises') || 'Failed to reorder exercises.');
    } finally {
      setIsReordering(false);
    }
  };

  // Move an exercise down within its day (swap with next exercise)
  const moveExerciseDown = async (day_id: number, index: number) => {
    if (isReordering) return;
    const day = days.find((d) => d.day_id === day_id);
    if (!day || index >= day.exercises.length - 1) return;
    const current = day.exercises[index];
    const next = day.exercises[index + 1];
    const curOrder = current.sort_order ?? current.exercise_id;
    const nextOrder = next.sort_order ?? next.exercise_id;
    setIsReordering(true);
    try {
      await db.runAsync('UPDATE Exercises SET sort_order = ? WHERE exercise_id = ?;', [nextOrder, current.exercise_id]);
      await db.runAsync('UPDATE Exercises SET sort_order = ? WHERE exercise_id = ?;', [curOrder, next.exercise_id]);
      await updateWorkoutLogsForReordering(workout_id);
      await fetchWorkoutDetails();
    } catch (error) {
      console.error('Exercise reorder failed:', error);
      Alert.alert(t('errorTitle'), t('failedToReorderExercises') || 'Failed to reorder exercises.');
    } finally {
      setIsReordering(false);
    }
  };

  // Update workout logs when days are reordered
  const updateWorkoutLogsForReordering = async (workout_id: number) => {
    try {
      const currentDate = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000); // Today's date as Unix timestamp
  
      // Get the current workout name
      const workoutResult = await db.getAllAsync<{ workout_name: string }>(
        'SELECT workout_name FROM Workouts WHERE workout_id = ?',
        [workout_id]
      );
      
      const workoutName = workoutResult[0]?.workout_name;
      
      // Fetch all logs for the current workout where workout_date >= today
      const logs = await db.getAllAsync<{ workout_log_id: number; day_name: string; workout_date: number }>(
        'SELECT workout_log_id, day_name, workout_date FROM Workout_Log WHERE workout_name = ? AND workout_date >= ?;',
        [workoutName, currentDate]
      );
  
      // Fetch updated days and exercises
      const days = await db.getAllAsync<{ day_id: number; day_name: string }>(
        'SELECT day_id, day_name FROM Days WHERE workout_id = ? ORDER BY day_id;',
        [workout_id]
      );
  
      for (const log of logs) {
        const day = days.find((d) => d.day_name === log.day_name);
  
        if (day) {
          console.log(`Updating log ${log.workout_log_id} for day: ${day.day_name}`);
  
          // Fetch updated exercises for the day (order by sort_order so exercise order is preserved)
          const exercises = await db.getAllAsync<{ exercise_name: string; sets: number; reps: number; web_link: string | null; muscle_group: string | null; exercise_notes: string | null; rest_seconds: number | null }>(
            'SELECT exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds FROM Exercises WHERE day_id = ? ORDER BY COALESCE(sort_order, 999999), exercise_id;',
            [day.day_id]
          );
  
          // Delete existing logged exercises for the log
          await db.runAsync('DELETE FROM Logged_Exercises WHERE workout_log_id = ?;', [log.workout_log_id]);
  
          // Insert updated exercises into the log
          const insertExercisePromises = exercises.map((exercise) =>
            db.runAsync(
              'INSERT INTO Logged_Exercises (workout_log_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
              [log.workout_log_id, exercise.exercise_name, exercise.sets, exercise.reps, exercise.web_link, exercise.muscle_group, exercise.exercise_notes, exercise.rest_seconds ?? null]
            )
          );
  
          await Promise.all(insertExercisePromises);
          
          console.log(`Successfully updated log ${log.workout_log_id} with reordered days.`);
        }
      }
    } catch (error) {
      console.error('Error updating workout logs after reordering days:', error);
    }
  };

  const openWebLinkModal = (exercise: { exercise_id: number; exercise_name: string | null; web_link: string | null; muscle_group: string | null; exercise_notes: string | null; sets: number; reps: number; rest_seconds: number | null }) => {
    setEditingExercise(exercise);
    setWebLinkInput(exercise.web_link || '');
    setExerciseReps(exercise.reps.toString());
    setExerciseRestSeconds(
      exercise.rest_seconds != null
        ? String(exercise.rest_seconds)
        : String(DEFAULT_REST_SECONDS_BETWEEN_SETS),
    );
    setExerciseSets(exercise.sets.toString());
    setExerciseNotesInput(exercise.exercise_notes || '');
    setEditingMuscleGroup(exercise.muscle_group);
    setExerciseName(exercise.exercise_name|| '');
    setShowWebLinkModal(true);
  };

  const closeWebLinkModal = () => {
    setShowWebLinkModal(false);
    setEditingExercise(null);
    setExerciseReps('');
    setExerciseSets('');
    setExerciseRestSeconds(String(DEFAULT_REST_SECONDS_BETWEEN_SETS));
    setWebLinkInput('');
    setExerciseNotesInput('');
    setExerciseName('');
    setEditingMuscleGroup(null);
  };

  const handleSaveWebLink = async () => {
    if (!editingExercise) return;

    const trimmedLink = webLinkInput.trim();

    // Validation
    if (trimmedLink && !trimmedLink.startsWith('http://') && !trimmedLink.startsWith('https://')) {
      Alert.alert(
        t('invalidLinkTitle'),
        t('invalidLinkMessage')
      );
      return;
    }

    // Validation reps
    if (parseInt(exerciseReps) <= 0 || exerciseReps === '') {
      Alert.alert(
        t('anErrorOccurred'),
        t('repsValidationError')
      )
      return;
    }

    // Validation sets
    if (parseInt(exerciseSets) <= 0 || exerciseSets === '') {
      Alert.alert(
        t('anErrorOccurred'),
        t('setsValidationError')
      )
      return;
    }

    // Validation for exercise name
    if (exerciseName === '') {
      Alert.alert(
        t('anErrorOccurred'),
        t('exerciseNameValidationError')
      )
      return;
    }

    const restParsedEdit = exerciseRestSeconds.trim()
      ? parseInt(exerciseRestSeconds.trim(), 10)
      : NaN;
    const restSec =
      Number.isFinite(restParsedEdit) && restParsedEdit > 0
        ? restParsedEdit
        : DEFAULT_REST_SECONDS_BETWEEN_SETS;
    try {
      await db.runAsync(
        'UPDATE Exercises SET web_link = ?, muscle_group = ?, exercise_notes = ?, sets = ?, reps = ?, exercise_name = ?, rest_seconds = ? WHERE exercise_id = ?',
        [trimmedLink || null, editingMuscleGroup, exerciseNotesInput.trim(), exerciseSets, exerciseReps, exerciseName, restSec, editingExercise.exercise_id]
      );
      
      // Update logs as well
      await updateWorkoutLogsForAdditions(workout_id);
      
      fetchWorkoutDetails();
      closeWebLinkModal();
    } catch (error) {
      console.error('Error updating web link:', error);
      Alert.alert(t('errorTitle'), 'Failed to update web link.');
    }
  };

  const handleLinkPress = async (url: string | null) => {
    if (!url) {
      Alert.alert(t('noLinkAvailable'));
      return;
    }
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        Alert.alert(`${t('cannotOpenURL')}: ${url}`);
      }
    } catch (error) {
      console.error('Error opening URL:', error);
      Alert.alert(t('errorOpeningURL'));
    }
  };

  const handleExportWorkout = (workoutId: number) => {
    exportWorkout(db, workoutId);
  };

  const muscleGroupData = [
    { label: t('Unspecified'), value: null },
    { label: t('Chest'), value: 'chest' },
    { label: t('Back'), value: 'back' },
    { label: t('Shoulders'), value: 'shoulders' },
    { label: t('Biceps'), value: 'biceps' },
    { label: t('Triceps'), value: 'triceps' },
    { label: t('Forearms'), value: 'forearms' },
    { label: t('Abs'), value: 'abs' },
    { label: t('Legs'), value: 'legs' },
    { label: t('Glutes'), value: 'glutes' },
    { label: t('Hamstrings'), value: 'hamstrings' },
    { label: t('Calves'), value: 'calves' },
    { label: t('Quads'), value: 'quads' },
  ];

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
        <Ionicons name="arrow-back" size={24} color={theme.text} />
      </TouchableOpacity>

      <View style={styles.titleContainer}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
            {workoutName}
          </Text>
          <TouchableOpacity
            style={styles.titleShareButton}
            onPress={() => handleExportWorkout(workout_id)}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel={t('share') || 'Share'}
          >
            <Ionicons name="share-outline" size={26} color={theme.text} />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={days}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.day_id.toString()}
        renderItem={({ item: day, index }) => {
          const isExpanded = !collapsedDayIds.has(day.day_id);
          let daySwipeRef: Swipeable | null = null;

          const renderDayLeftActions = () => (
            <RectButton
              style={[styles.swipeAction, styles.swipeActionEdit]}
              onPress={() => {
                daySwipeRef?.close();
                requestAnimationFrame(() => openEditDayModal(day));
              }}
            >
              <Ionicons name="create-outline" size={22} color="#fff" />
              <Text style={styles.swipeActionText}>{t('edit')}</Text>
            </RectButton>
          );

          const renderDayRightActions = () => (
            <RectButton
              style={[styles.swipeAction, styles.swipeActionDelete]}
              onPress={() => {
                daySwipeRef?.close();
                requestAnimationFrame(() => handleDeleteDay(day.day_id, day.day_name, workout_id));
              }}
            >
              <Ionicons name="trash-outline" size={22} color="#fff" />
              <Text style={styles.swipeActionText}>{t('Delete')}</Text>
            </RectButton>
          );

          return (
          <Animated.View
            style={[
              styles.animatedDayContainer,
              {
                opacity: fadeAnim,
                transform: [{ scale: scaleAnim }],
              }
            ]}
          >
            <Swipeable
              ref={(r) => {
                daySwipeRef = r;
              }}
              friction={2}
              overshootLeft={false}
              overshootRight={false}
              renderLeftActions={renderDayLeftActions}
              renderRightActions={renderDayRightActions}
            >
            <View
              style={[
                styles.dayContainer,
                {
                  padding: 0,
                  backgroundColor: theme.card,
                  borderWidth: 1,
                  borderColor: theme.border,
                  borderRadius: 20,
                  overflow: 'hidden',
                },
              ]}
            >
              <Pressable
                onLongPress={() => showDayRowActions(day)}
                onPress={() => toggleDayExpanded(day.day_id)}
                style={({ pressed }) => [styles.dayHeaderRow, { padding: 20, opacity: pressed ? 0.85 : 1 }]}
              >
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                  <AutoSizeText
                    fontSize={18}
                    numberOfLines={5}
                    mode={ResizeTextMode.max_lines}
                    style={[styles.dayTitle, { color: theme.text, flexShrink: 1, marginRight: 8, fontWeight: 'bold' }]}
                  >
                    {day.day_name}
                  </AutoSizeText>
                  <Ionicons
                    name={isExpanded ? 'chevron-down' : 'chevron-forward'}
                    size={24}
                    color={theme.text}
                    style={{ marginRight: 8 }}
                  />
                </View>
                <View style={styles.dayHeaderRightControls}>
                  <View style={styles.reorderButtonsContainer}>
                    {index > 0 && (
                      <TouchableOpacity
                        onPress={() => !isReordering && moveDayUp(index)}
                        disabled={isReordering}
                        style={styles.reorderButton}
                      >
                        <Ionicons name="arrow-up" size={24} color={isReordering ? theme.border : theme.text} />
                      </TouchableOpacity>
                    )}
                    {index < days.length - 1 && (
                      <TouchableOpacity
                        onPress={() => !isReordering && moveDayDown(index)}
                        disabled={isReordering}
                        style={styles.reorderButton}
                      >
                        <Ionicons name="arrow-down" size={24} color={isReordering ? theme.border : theme.text} />
                      </TouchableOpacity>
                    )}
                  </View>

                  <TouchableOpacity
                    onPress={() => openScheduleModalForDayIds([day.day_id])}
                    disabled={isReordering}
                    style={styles.reorderButton}
                    hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('addToCalendar') || 'Add to Calendar'}
                  >
                    <Ionicons
                      name="calendar-outline"
                      size={24}
                      color={isReordering ? theme.border : theme.text}
                    />
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={() => openAddExerciseModal(day.day_id)}
                    disabled={isReordering}
                  >
                    <Ionicons
                      name="add"
                      size={28}
                      color={isReordering ? theme.border : theme.text}
                    />
                  </TouchableOpacity>
                </View>
              </Pressable>

              {isExpanded && (
              <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
              {day.exercises.length > 0 ? (
                day.exercises.map((exercise, index) => {
                  const muscleGroupInfo = muscleGroupData.find(mg => mg.value === exercise.muscle_group);
                  const warmupCooldownLocked = isWarmupOrCooldownExerciseName(
                    exercise.exercise_name,
                  );
                  let exerciseSwipeRef: Swipeable | null = null;

                  const renderExerciseDeleteActions = () => (
                    <RectButton
                      style={[styles.swipeAction, styles.swipeActionDelete]}
                      onPress={() => {
                        exerciseSwipeRef?.close();
                        requestAnimationFrame(() =>
                          handleDeleteExercise(day.day_id, exercise.exercise_name, workout_id),
                        );
                      }}
                    >
                      <Ionicons name="trash-outline" size={20} color="#fff" />
                      <Text style={styles.swipeActionText}>{t('Delete')}</Text>
                    </RectButton>
                  );

                  const exerciseRow = (
                    <View
                      style={[
                        styles.exerciseContainer,
                        {
                          backgroundColor: theme.card,
                          borderColor: theme.border,
                        },
                      ]}
                    >
                      <TouchableOpacity
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 8 }}
                        onPress={() => openWebLinkModal(exercise)}
                        onLongPress={
                          warmupCooldownLocked
                            ? () =>
                                Alert.alert(
                                  t('warmupCooldownExerciseProtectedTitle'),
                                  t('warmupCooldownExerciseProtected'),
                                  [{ text: t('OK') }],
                                )
                            : () =>
                                handleDeleteExercise(
                                  day.day_id,
                                  exercise.exercise_name,
                                  workout_id,
                                )
                        }
                        activeOpacity={0.6}
                        delayLongPress={500}
                      >
                        {exercise.web_link && (
                          <TouchableOpacity onPress={() => handleLinkPress(exercise.web_link)} style={{ alignSelf: 'flex-start', marginRight: 10, marginTop: 2 }}>
                            <Ionicons name="link-outline" size={22} color={theme.text} />
                          </TouchableOpacity>
                        )}
                        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                          <AutoSizeText
                            fontSize={14}
                            numberOfLines={4}
                            mode={ResizeTextMode.max_lines}
                            style={[styles.exerciseName, { color: theme.text, marginRight: 8 }]}
                          >
                            {exercise.exercise_name}
                          </AutoSizeText>
                          {muscleGroupInfo && muscleGroupInfo.value && (
                            <View style={[styles.muscleGroupBadge, { backgroundColor: theme.card, borderColor: theme.border }]}>
                              <Text style={[styles.muscleGroupBadgeText, { color: theme.text }]}>
                                {muscleGroupInfo.label}
                              </Text>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                      <View style={styles.exerciseDetails}>
                        <Text style={{ color: theme.text, fontSize: 13, textAlign: 'right' }}>
                          {exercise.sets} <Text style={{ color: theme.text }}>{t('Sets')}</Text>
                          {'  '}
                          {exercise.reps} <Text style={{ color: theme.text }}>{t('Reps')}</Text>
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, justifyContent: 'flex-end' }}>
                          <TouchableOpacity
                            onPress={() => moveExerciseUp(day.day_id, index)}
                            disabled={index === 0 || isReordering}
                            style={{ padding: 4 }}
                            hitSlop={8}
                          >
                            <Ionicons name="arrow-up" size={20} color={index === 0 || isReordering ? theme.border : theme.text} />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => moveExerciseDown(day.day_id, index)}
                            disabled={index === day.exercises.length - 1 || isReordering}
                            style={{ padding: 4 }}
                            hitSlop={8}
                          >
                            <Ionicons name="arrow-down" size={20} color={index === day.exercises.length - 1 || isReordering ? theme.border : theme.text} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>
                  );

                  if (warmupCooldownLocked) {
                    return (
                      <View key={exercise.exercise_id}>{exerciseRow}</View>
                    );
                  }

                  return (
                    <Swipeable
                      key={exercise.exercise_id}
                      ref={(r) => {
                        exerciseSwipeRef = r;
                      }}
                      friction={2}
                      overshootLeft={false}
                      overshootRight={false}
                      renderRightActions={renderExerciseDeleteActions}
                    >
                      {exerciseRow}
                    </Swipeable>
                  );
                })
              ) : (
                <Text style={[styles.noExercisesText, { color: theme.text }]}>{t('noExercises')} </Text>
              )}
              </View>
              )}
            </View>
            </Swipeable>
          </Animated.View>
        );
        }}
        ListFooterComponent={
          <>
            <TouchableOpacity
              style={[styles.addDayButton, { backgroundColor: theme.buttonBackground }]}
              onPress={openAddDayModal}
            >
              <Ionicons name="add" size={28} color={theme.buttonText} />
              <Text style={[styles.addDayButtonText, { color: theme.buttonText }]}>{t('addDayFromDetails')}</Text>
            </TouchableOpacity>
            <Text style={[styles.tipText, { color: theme.text }]}>
              {t('workoutDetailsTip')}
            </Text>
          </>
        }
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: theme.text }]}>
            {t('emptyWorkoutDetails')}
          </Text>
        }
      />

      <Modal visible={showDayModal} animationType="fade" transparent>
        {showDayModal && (
          <StatusBar
            backgroundColor={theme.type === 'light' ? "rgba(0, 0, 0, 0.5)" : "black"}
            barStyle={'light-content'}
          />
        )}
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}>
            <View style={[styles.dayModalContent, { backgroundColor: theme.card }]}>
              <Text style={[styles.dayModalTitle, { color: theme.text }]}>{t('addDayFromDetails')}</Text>
              <TextInput
                style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                placeholder={t('dayNamePlaceholder')}
                placeholderTextColor={theme.text}
                value={dayName}
                onChangeText={setDayName}
              />
              <TouchableOpacity style={[styles.saveButton, { backgroundColor: theme.buttonBackground }]} onPress={addDay}>
                <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('Save')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cancelButton, { backgroundColor: theme.card }]} onPress={closeAddDayModal}>
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>{t('Cancel')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      <Modal visible={showEditDayModal} animationType="fade" transparent onRequestClose={closeEditDayModal}>
        {showEditDayModal && (
          <StatusBar
            backgroundColor={theme.type === 'light' ? 'rgba(0, 0, 0, 0.5)' : 'black'}
            barStyle="light-content"
          />
        )}
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}>
            <View style={[styles.dayModalContent, { backgroundColor: theme.card }]}>
              <Text style={[styles.dayModalTitle, { color: theme.text }]}>{t('editDayTitle') || 'Edit day'}</Text>
              <TextInput
                style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                placeholder={t('dayNamePlaceholder')}
                placeholderTextColor={theme.text}
                value={editDayNameInput}
                onChangeText={setEditDayNameInput}
              />
              <TouchableOpacity style={[styles.saveButton, { backgroundColor: theme.buttonBackground }]} onPress={saveRenamedDay}>
                <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('Save')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.cancelButton, { backgroundColor: theme.card }]} onPress={closeEditDayModal}>
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>{t('Cancel')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      <Modal visible={showExerciseModal} animationType="fade" transparent onRequestClose={closeAddExerciseModal}>
        {showExerciseModal && (
          <StatusBar
            backgroundColor={theme.type === 'light' ? "rgba(0, 0, 0, 0.5)" : "black"}
            barStyle={'light-content'}/>
        )}
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}>
            <View style={[styles.modalContent, { backgroundColor: theme.card, maxHeight: '100%' }]}>
              <ScrollView style={{width: '100%'}} contentContainerStyle={{padding: 20, alignItems: 'center'}} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <Text style={[styles.modalTitle, { color: theme.text }]}>{t('addExerciseFromDetails')}</Text>
                <TextInput
                  style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                  placeholder={t('exerciseNamePlaceholder')}
                  placeholderTextColor={theme.text}
                  value={exerciseName}
                  autoCapitalize="words"
                  onChangeText={setExerciseName}
                />
                {workoutPlanType === 'cardio' ? (
                  <>
                    <Text style={[styles.inputLabel, { color: theme.text, alignSelf: 'flex-start', width: '100%' }]}>
                      {t('durationMinutes') || 'Duration (minutes)'}
                    </Text>
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                      placeholder={t('durationMinutes') || 'Duration (minutes)'}
                      placeholderTextColor={theme.text}
                      keyboardType="decimal-pad"
                      value={exerciseCardioDuration}
                      onChangeText={(text) => setExerciseCardioDuration(text.replace(/[^0-9.,]/g, ''))}
                    />
                    <Text style={[styles.inputLabel, { color: theme.text, alignSelf: 'flex-start', width: '100%', marginTop: 10 }]}>
                      {t('distanceOptional') || 'Distance (optional)'}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', width: '100%', marginBottom: 8 }}>
                      <TextInput
                        style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border, flex: 1, minWidth: 100, marginBottom: 0 }]}
                        placeholder="e.g. 5"
                        placeholderTextColor={theme.text}
                        keyboardType="decimal-pad"
                        value={exerciseCardioDistance}
                        onChangeText={(text) => setExerciseCardioDistance(text.replace(/[^0-9.,]/g, ''))}
                      />
                      <TouchableOpacity
                        onPress={() => setExerciseCardioDistUnit('km')}
                        style={{
                          paddingVertical: 10,
                          paddingHorizontal: 14,
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: theme.border,
                          backgroundColor: exerciseCardioDistUnit === 'km' ? (theme.buttonBackground || '#7C9A7E') : theme.card,
                        }}
                      >
                        <Text style={{ fontWeight: '600', color: exerciseCardioDistUnit === 'km' ? (theme.buttonText ?? '#fff') : theme.text }}>km</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => setExerciseCardioDistUnit('mi')}
                        style={{
                          paddingVertical: 10,
                          paddingHorizontal: 14,
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: theme.border,
                          backgroundColor: exerciseCardioDistUnit === 'mi' ? (theme.buttonBackground || '#7C9A7E') : theme.card,
                        }}
                      >
                        <Text style={{ fontWeight: '600', color: exerciseCardioDistUnit === 'mi' ? (theme.buttonText ?? '#fff') : theme.text }}>mi</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={[styles.inputLabel, { color: theme.text, marginTop: 10 }]}>{t('webLink')}</Text>
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                      placeholder={t('webLinkPlaceholder')}
                      placeholderTextColor={theme.text}
                      value={exerciseWebLink}
                      onChangeText={setExerciseWebLink}
                      autoCapitalize="none"
                      keyboardType="url"
                    />
                    <Text style={[styles.inputLabel, { color: theme.text, marginTop: 10 }]}>{t('exerciseNotes')}</Text>
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border, height: 100, textAlignVertical: 'top' }]}
                      placeholder={t('exerciseNotesPlaceholder')}
                      placeholderTextColor={theme.text}
                      value={exerciseNotesInput}
                      onChangeText={setExerciseNotesInput}
                      multiline
                      numberOfLines={4}
                    />
                  </>
                ) : (
                  <>
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                      placeholder={t('setsPlaceholder') + ' (> 0)'}
                      placeholderTextColor={theme.text}
                      keyboardType="numeric"
                      value={exerciseSets}
                      onChangeText={setExerciseSets}
                    />
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                      placeholder={t('repsPlaceholder') + ' (> 0)'}
                      placeholderTextColor={theme.text}
                      keyboardType="numeric"
                      value={exerciseReps}
                      onChangeText={setExerciseReps}
                    />
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                      placeholder={t('restSecondsPlaceholder') || 'Rest (s)'}
                      placeholderTextColor={theme.text}
                      keyboardType="numeric"
                      value={exerciseRestSeconds}
                      onChangeText={setExerciseRestSeconds}
                    />
                    <Text style={[styles.inputLabel, { color: theme.text, marginTop: 10 }]}>{t('webLink')}</Text>
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                      placeholder={t('webLinkPlaceholder')}
                      placeholderTextColor={theme.text}
                      value={exerciseWebLink}
                      onChangeText={setExerciseWebLink}
                      autoCapitalize="none"
                      keyboardType="url"
                    />
                    <Text style={[styles.inputLabel, { color: theme.text, marginTop: 10 }]}>{t('muscleGroup')}</Text>
                    <FlatList
                      data={muscleGroupData}
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      keyExtractor={(item) => item.label}
                      renderItem={({ item }) => {
                        const isSelected = newExerciseMuscleGroup === item.value;

                        return (
                          <TouchableOpacity
                            style={[
                              styles.muscleGroupButton,
                              {
                                backgroundColor: isSelected ? theme.buttonBackground : theme.card,
                                borderColor: theme.border,
                              },
                            ]}
                            onPress={() => setNewExerciseMuscleGroup(item.value)}
                          >
                            <Text style={{ color: isSelected ? theme.buttonText : theme.text }}>{t(item.label)}</Text>
                          </TouchableOpacity>
                        );
                      }}
                      style={{ marginBottom: 15 }}
                    />
                    <Text style={[styles.inputLabel, { color: theme.text, marginTop: 10 }]}>{t('exerciseNotes')}</Text>
                    <TextInput
                      style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border, height: 100, textAlignVertical: 'top' }]}
                      placeholder={t('exerciseNotesPlaceholder')}
                      placeholderTextColor={theme.text}
                      value={exerciseNotesInput}
                      onChangeText={setExerciseNotesInput}
                      multiline
                      numberOfLines={4}
                    />
                  </>
                )}
                <TouchableOpacity style={[styles.saveButton, { backgroundColor: theme.buttonBackground }]} onPress={addExercise}>
                  <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('Save')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.cancelButton, { backgroundColor: theme.card }]} onPress={closeAddExerciseModal}>
                  <Text style={[styles.cancelButtonText, { color: theme.text }]}>{t('Cancel')}</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      <Modal visible={showWebLinkModal} animationType="fade" transparent onRequestClose={closeWebLinkModal}>
        {showWebLinkModal && (
          <StatusBar
            backgroundColor={theme.type === 'light' ? "rgba(0, 0, 0, 0.5)" : "black"}
            barStyle={'light-content'}          />
        )}
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={[styles.modalContainer, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}>
            <View style={[styles.modalContent, { backgroundColor: theme.card, maxHeight: '100%' }]}>
              <ScrollView style={{width: '100%'}} contentContainerStyle={{padding: 20, alignItems: 'center'}} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <Text style={[styles.modalTitle, { color: theme.text }]}>{t('exerciseDetails')}</Text>
                
                <Text style={[styles.inputLabel, { color: theme.text }]}>{t('exerciseNamePlaceholder')}</Text>
                <TextInput
                    style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                    placeholder={t('exerciseNamePlaceholder')}
                    placeholderTextColor={theme.text}
                    value={exerciseName}
                    onChangeText={setExerciseName}
                    autoCapitalize="words"
                    keyboardType="url"
                />

                <Text style={[styles.inputLabel, {color: theme.text, marginTop: 15}]}>{t('setsPlaceholder')}</Text>
                <TextInput
                  style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                  placeholder={t('setsPlaceholder') + ' (> 0)'}
                  placeholderTextColor={theme.text}
                  keyboardType="numeric"
                  value={exerciseSets}
                  onChangeText={setExerciseSets}
                />
                <Text style={[styles.inputLabel, {color: theme.text, marginTop: 15}]}>{t('repsPlaceholder')}</Text>
                <TextInput
                  style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                  placeholder={t('repsPlaceholder') + ' (> 0)'}
                  placeholderTextColor={theme.text}
                  keyboardType="numeric"
                  value={exerciseReps}
                  onChangeText={setExerciseReps}
                />
                <Text style={[styles.inputLabel, { color: theme.text, marginTop: 15 }]}>{t('restSecondsPlaceholder') || 'Rest (s)'}</Text>
                <TextInput
                  style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                  placeholder={t('restSecondsPlaceholder') || 'Rest (s)'}
                  placeholderTextColor={theme.text}
                  keyboardType="numeric"
                  value={exerciseRestSeconds}
                  onChangeText={setExerciseRestSeconds}
                />
                <Text style={[styles.inputLabel, { color: theme.text }]}>{t('webLink')}</Text>
                <TextInput
                    style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                    placeholder={t('webLinkPlaceholder')}
                    placeholderTextColor={theme.text}
                    value={webLinkInput}
                    onChangeText={setWebLinkInput}
                    autoCapitalize="none"
                    keyboardType="url"
                />
                <Text style={[styles.inputLabel, { color: theme.text, marginTop: 15 }]}>{t('muscleGroup')}</Text>
                <FlatList
                  data={muscleGroupData}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyExtractor={(item) => item.label}
                  renderItem={({ item }) => {
                    const isSelected = editingMuscleGroup === item.value;
                    
                    return (
                      <TouchableOpacity
                        style={[
                          styles.muscleGroupButton,
                          { 
                            backgroundColor: isSelected ? theme.buttonBackground : theme.card,
                            borderColor: theme.border,
                          }
                        ]}
                        onPress={() => setEditingMuscleGroup(item.value)}
                      >
                        <Text style={{ color: isSelected ? theme.buttonText : theme.text }}>{t(item.label)}</Text>
                      </TouchableOpacity>
                    );
                  }}
                  style={{ marginBottom: 15 }}
                />
                <Text style={[styles.inputLabel, { color: theme.text, marginTop: 15 }]}>{t('exerciseNotes')}</Text>
               <TextInput
                   style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border, height: 100, textAlignVertical: 'top' }]}
                   placeholder={t('exerciseNotesPlaceholder')}
                   placeholderTextColor={theme.text}
                   value={exerciseNotesInput}
                   onChangeText={setExerciseNotesInput}
                   multiline={true}
                   numberOfLines={4}
               />
                <TouchableOpacity style={[styles.saveButton, { backgroundColor: theme.buttonBackground }]} onPress={handleSaveWebLink}>
                    <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('Save')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.cancelButton, { backgroundColor: theme.card }]} onPress={closeWebLinkModal}>
                    <Text style={[styles.cancelButtonText, { color: theme.text }]}>{t('Cancel')}</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Add to Calendar modal */}
      <Modal visible={showAddToCalendarModal} animationType="fade" transparent onRequestClose={closeAddToCalendarModal}>
        <View style={[styles.modalContainer, { backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }]}>
          <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={closeAddToCalendarModal} />
          <View style={[styles.modalContent, { backgroundColor: theme.card, padding: 24, minWidth: 280 }]}>
                <Text style={[styles.modalTitle, { color: theme.text }]}>{t('addToCalendar') || 'Add to Calendar'}</Text>
                <Text style={[styles.inputLabel, { color: theme.text, marginBottom: 8 }]}>{t('startDate') || 'Start date'}</Text>
                <ScrollView
                  style={[styles.datePickerScroll, { backgroundColor: theme.background, borderColor: theme.border, maxHeight: 220 }]}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={true}
                >
                  {(() => {
                    const options: { date: Date; label: string }[] = [];
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    for (let i = 0; i < 60; i++) {
                      const d = new Date(today);
                      d.setDate(today.getDate() + i);
                      const label = i === 0
                        ? `${t('Today')} (${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })})`
                        : i === 1
                          ? `${t('Tomorrow')} (${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })})`
                          : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                      options.push({ date: d, label });
                    }
                    return options.map((opt) => {
                      const isSelected = addToCalendarStartDate.getTime() === opt.date.getTime();
                      return (
                        <TouchableOpacity
                          key={opt.date.getTime()}
                          style={[
                            styles.dateOptionRow,
                            { backgroundColor: isSelected ? (theme.buttonBackground || '#7C9A7E') : 'transparent', borderBottomColor: theme.border },
                          ]}
                          onPress={() => setAddToCalendarStartDate(opt.date)}
                        >
                          <Text style={[styles.dateOptionText, { color: isSelected ? (theme.buttonText ?? '#fff') : theme.text }]}>{opt.label}</Text>
                          {isSelected && <Ionicons name="checkmark" size={20} color={theme.buttonText ?? '#fff'} />}
                        </TouchableOpacity>
                      );
                    });
                  })()}
                </ScrollView>
                <Text style={[styles.tipText, { color: theme.text, marginTop: 12, fontSize: 11 }]}>
                  {t('addToCalendarTip') || 'Selected days will be scheduled starting from this date (Day 1, Day 2, …).'}
                </Text>
                <View style={[styles.addToCalendarButtonRow, { marginTop: 20 }]}>
                  <TouchableOpacity style={[styles.cancelButton, styles.addToCalendarButton]} onPress={closeAddToCalendarModal}>
                    <Text style={[styles.cancelButtonText, { color: theme.text }]}>{t('Cancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.saveButton, styles.addToCalendarButton, { backgroundColor: theme.buttonBackground }]} onPress={scheduleDaysToCalendar}>
                    <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('Schedule') || 'Schedule'}</Text>
                  </TouchableOpacity>
                </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}


// WorkoutDetails.tsx

const styles = StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: 20,
      paddingTop: 60,
      backgroundColor: '#FFFFFF',
    },
    adContainer: {
      alignItems: 'center',
    },
    backButton: {
      position: 'absolute',
      top: 20,
      left: 10,
      zIndex: 10,
      padding: 8,
    },
    titleContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 15,
      paddingHorizontal: 44,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      maxWidth: '100%',
    },
    titleShareButton: {
      padding: 6,
      marginLeft: 6,
      justifyContent: 'center',
      alignItems: 'center',
    },
    title: {
      fontSize: 26,
      fontWeight: '900',
      textAlign: 'center',
      flexShrink: 1,
    },
    dayContainer: {
      padding: 20,
    },
    dayHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flex: 1,
    },
    swipeAction: {
      justifyContent: 'center',
      alignItems: 'center',
      width: 88,
      flexDirection: 'column',
      gap: 4,
    },
    swipeActionEdit: {
      backgroundColor: '#7C9A7E',
      borderTopRightRadius: 10,
      borderBottomRightRadius: 10,
    },
    swipeActionDelete: {
      backgroundColor: '#c62828',
      borderTopLeftRadius: 10,
      borderBottomLeftRadius: 10,
    },
    swipeActionText: {
      color: '#fff',
      fontWeight: '700',
      fontSize: 13,
    },
    dayHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    dayHeaderRightControls: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    reorderButtonsContainer: {
      flexDirection: 'row',
      marginRight: 8,
    },
    reorderButton: {
      marginHorizontal: 2,
      padding: 4,
    },
    dayTitle: {
      fontSize: 18,
      fontWeight: '800',
    },
    exerciseContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: '#F7F7F7',
      paddingVertical: 12,
      paddingHorizontal: 3,
      marginBottom: 5,
      borderWidth: 0,
      borderColor: 'rgba(0, 0, 0, 0.1)',
      maxWidth: '100%',  // Prevent overflow
    },
    exerciseName: {
      fontWeight: '700',
      color: '#000000',
    },
    exerciseDetails: {
      minWidth: 70,
      alignItems: 'flex-end',
    },
    muscleGroupBadge: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: 15,
      borderWidth: 1,
      alignSelf: 'flex-start',
    },
    muscleGroupBadgeText: {
        fontSize: 10,
        fontWeight: '600',
    },
    noExercisesText: {
      textAlign: 'center',
      fontSize: 13,
      fontStyle: 'italic',
      color: 'rgba(0, 0, 0, 0.5)',
      marginTop: 10,
    },
    addDayButton: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 20,
      padding: 12,
      marginTop: 1,
      justifyContent: 'center',
    },
    addDayButtonText: {
      fontSize: 14,
      fontWeight: '800',
      marginLeft: 8,
    },
    emptyText: {
      textAlign: 'center',
      fontSize: 13,
      color: 'rgba(0, 0, 0, 0.5)',
      marginTop: 20,
    },
    modalContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalContent: {
      borderRadius: 15,
      width: '80%',
    },
    datePickerScroll: {
      borderWidth: 1,
      borderRadius: 10,
      padding: 4,
    },
    dateOptionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderBottomWidth: 1,
    },
    dateOptionText: {
      fontSize: 12,
    },
    modalTitle: {
      fontSize: 16,
      fontWeight: 'bold',
      marginBottom: 15,
    },
    dayModalContent: {
      borderRadius: 15,
      width: '80%',
      padding: 20,
    },
    dayModalTitle: {
      fontSize: 16,
      fontWeight: 'bold',
      marginBottom: 15,
    },
    inputLabel: {
      alignSelf: 'stretch',
      textAlign: 'left',
      fontSize: 13,
      marginBottom: 5,
      fontWeight: '600',
    },
    input: {
      width: '100%',
      borderWidth: 1,
      borderColor: 'rgba(0, 0, 0, 0.2)',
      borderRadius: 8,
      padding: 10,
      marginBottom: 10,
    },
    saveButton: {
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 20,
      marginBottom: 10,
      marginTop: 10,
      alignItems: 'center',
    },
    saveButtonText: {
      fontWeight: 'bold',
    },
    cancelButton: {
      borderWidth: 1,
      borderColor: '#000000',
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 20,
      alignItems: 'center',
    },
    cancelButtonText: {
      fontWeight: 'bold',
    },
    animatedDayContainer: {
      marginBottom: 20,
      borderRadius: 20,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 2,
    },
    addToCalendarButtonRow: {
      flexDirection: 'row',
      gap: 12,
    },
    addToCalendarButton: {
      flex: 1,
      minHeight: 48,
      justifyContent: 'center',
      paddingVertical: 14,
      marginTop: 0,
      marginBottom: 0,
    },
    tipText: {
      textAlign: 'center',
      fontSize: 11,
      fontStyle: 'italic',
      marginTop: 20,
      marginBottom: 20,
      paddingHorizontal: 10,
    },
    muscleGroupButton: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 20,
      height: 40,
      elevation: 1,
      shadowOpacity: 0,
      borderWidth: 1,
      marginRight: 10,
      justifyContent: 'center',
      alignItems: 'center',
    },
  });