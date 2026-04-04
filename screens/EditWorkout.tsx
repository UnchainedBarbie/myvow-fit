import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSQLiteContext } from 'expo-sqlite';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from 'react-i18next';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { RectButton, Swipeable } from 'react-native-gesture-handler';
import { sortWorkoutPlanExercisesForDisplay } from '../utils/workoutDisplayUtils';
import { initWorkoutDb } from '../utils/initWorkoutDb';
import {
  ensureCardioExerciseName,
  formatCardioDistanceForDb,
  isCardioExerciseInEditor,
  parseStoredDistance,
} from '../utils/cardioExerciseUtils';
import { DEFAULT_REST_SECONDS_BETWEEN_SETS } from '../utils/startedWorkoutPreferenceUtils';

type Exercise = {
  exercise_id: number;
  exercise_name: string;
  sets: number;
  reps: number;
  web_link: string | null;
  muscle_group: string | null;
  exercise_notes: string | null;
  rest_seconds: number | null;
  duration_minutes?: number | null;
  cardio_distance?: string | null;
  exercise_type?: string | null;
  _cardioDistValue?: string;
  _cardioDistUnit?: 'km' | 'mi';
};
type Day = { day_id: number; day_name: string; exercises: Exercise[] };

export default function EditWorkout() {
  const db = useSQLiteContext();
  const route = useRoute();
  const navigation = useNavigation();
  const { theme } = useTheme();
  const { t } = useTranslation();
  
  const { workout_id } = route.params as { workout_id: number };

  const [workoutName, setWorkoutName] = useState('');
  const [workoutType, setWorkoutType] = useState<'strength' | 'cardio'>('strength');
  const [days, setDays] = useState<Day[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const SAGE = '#7C9A7E';

  useEffect(() => {
    fetchWorkoutDetails();
  }, [workout_id]);

  const fetchWorkoutDetails = async () => {
    try {
      await initWorkoutDb(db);
      await db.runAsync("ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';").catch(() => {});
      const workoutResult = await db.getAllAsync<{ workout_name: string; workout_type?: string }>(
        'SELECT workout_name, workout_type FROM Workouts WHERE workout_id = ?',
        [workout_id]
      );
      setWorkoutName(workoutResult[0]?.workout_name || '');
      const wt =
        (workoutResult[0]?.workout_type as string | undefined) === 'cardio' ? 'cardio' : 'strength';
      setWorkoutType(wt);

      const daysResult = await db.getAllAsync<{ day_id: number; day_name: string }>(
        'SELECT day_id, day_name FROM Days WHERE workout_id = ?',
        [workout_id]
      );

      await db.runAsync('ALTER TABLE Exercises ADD COLUMN sort_order INTEGER;').catch(() => {});
      const daysWithExercises = await Promise.all(
        daysResult.map(async (day) => {
          const exercises = await db.getAllAsync<
            Exercise & { sort_order?: number | null }
          >(
            'SELECT exercise_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order, duration_minutes, cardio_distance, exercise_type FROM Exercises WHERE day_id = ? ORDER BY COALESCE(sort_order, 999999), exercise_id;',
            [day.day_id]
          ).catch(async () =>
            db.getAllAsync<Exercise & { sort_order?: number | null }>(
              'SELECT exercise_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order FROM Exercises WHERE day_id = ? ORDER BY COALESCE(sort_order, 999999), exercise_id;',
              [day.day_id]
            )
          );
          const sorted = sortWorkoutPlanExercisesForDisplay(exercises);
          for (let i = 0; i < sorted.length; i++) {
            await db.runAsync('UPDATE Exercises SET sort_order = ? WHERE exercise_id = ?;', [
              i,
              sorted[i].exercise_id,
            ]);
          }
          const enriched: Exercise[] = sorted.map((ex) => {
            const parsed = parseStoredDistance(ex.cardio_distance ?? null);
            const isCardio = isCardioExerciseInEditor(wt, ex);
            const repsForUi = isCardio
              ? Math.round(Number(ex.duration_minutes ?? ex.reps) || 0)
              : ex.reps;
            return {
              ...ex,
              reps: repsForUi,
              _cardioDistValue: parsed.value,
              _cardioDistUnit: parsed.unit,
            };
          });
          return { ...day, exercises: enriched };
        })
      );

      // Sort days by day_id in ascending order
      const sortedDays = daysWithExercises.sort((a, b) => a.day_id - b.day_id);
      setDays(sortedDays);

    } catch (error) {
      Alert.alert(t('errorTitle'), t('fetchWorkoutDetailsError'));
      console.error(error);
    }
  };
  
  const fetchOriginalWorkoutLogData = async (workout_id: number) => {
    try {
      const currentDate = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000); // Today's date as Unix timestamp
  
      // Fetch the original workout name
      const originalWorkout = await db.getAllAsync<{ workout_name: string }>(
        'SELECT workout_name FROM Workouts WHERE workout_id = ?;',
        [workout_id]
      );
  
      if (!originalWorkout.length) {
        console.error('Workout not found:', workout_id);
        return [];
      }
  
      const originalWorkoutName = originalWorkout[0].workout_name;
  
      // Fetch all days for the workout
      const originalDays = await db.getAllAsync<{ day_id: number; day_name: string }>(
        'SELECT day_id, day_name FROM Days WHERE workout_id = ?;',
        [workout_id]
      );
  
      // Fetch all workout logs referencing the original workout and day names
      const logsWithDayNames = await Promise.all(
        originalDays.map(async (day) => {
          const logs = await db.getAllAsync<{ workout_log_id: number; day_name: string; workout_name: string; workout_date: number }>(
            'SELECT workout_log_id, day_name, workout_name, workout_date FROM Workout_Log WHERE day_name = ? AND workout_name = ? AND workout_date >= ?;',
            [day.day_name, originalWorkoutName, currentDate] // Only fetch logs with workout_date >= today
          );
  
          return logs.map((log) => ({
            log_id: log.workout_log_id,
            original_day_name: log.day_name,
            original_workout_name: log.workout_name,
            workout_date: log.workout_date,
            day_id: day.day_id,
          }));
        })
      );
  
      return logsWithDayNames.flat();
    } catch (error) {
      console.error('Error fetching original workout log data:', error);
      return [];
    }
  };
  
  const updateWorkoutLogs = async (originalLogs: any[], updatedWorkoutName: string) => {
    try {
      const currentDate = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000); // Today's date as Unix timestamp
  
      for (const originalLog of originalLogs) {
        const { log_id, original_day_name, day_id, workout_date } = originalLog;
  
        // Skip logs with workout_date in the past
        if (workout_date < currentDate) {
          console.log(`Skipping log ${log_id} as workout_date is in the past.`);
          continue;
        }
  
        console.log('Updating log:', log_id, 'Original day:', original_day_name, 'Updated workout:', updatedWorkoutName);
  
        // Fetch the updated day name
        const updatedDay = await db.getAllAsync<{ day_name: string }>(
          'SELECT day_name FROM Days WHERE day_id = ?;',
          [day_id]
        );
  
        if (!updatedDay.length) {
          console.error('Updated day not found for day_id:', day_id);
          continue;
        }
  
        const updatedDayName = updatedDay[0].day_name;
  
        // Update the log and its exercises
        // 1. Delete old exercises
        await db.runAsync('DELETE FROM Logged_Exercises WHERE workout_log_id = ?;', [log_id]);
  
        // 2. Fetch updated exercises for the day
        const updatedExercises = await db.getAllAsync<{ exercise_name: string; sets: number; reps: number; web_link: string | null; muscle_group: string | null; exercise_notes: string | null; rest_seconds: number | null }>(
          'SELECT exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds FROM Exercises WHERE day_id = ?;',
          [day_id]
        );
  
        // 3. Insert updated exercises
        const insertExercisePromises = updatedExercises.map((exercise) =>
          db.runAsync(
            'INSERT INTO Logged_Exercises (workout_log_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
            [log_id, exercise.exercise_name, exercise.sets, exercise.reps, exercise.web_link, exercise.muscle_group, exercise.exercise_notes, exercise.rest_seconds ?? null]
          )
        );
  
        await Promise.all(insertExercisePromises);
  
        // 4. Update the Workout_Log with the new workout name and day name
        await db.runAsync(
          'UPDATE Workout_Log SET workout_name = ?, day_name = ? WHERE workout_log_id = ?;',
          [updatedWorkoutName, updatedDayName, log_id]
        );
  
        console.log(`Successfully updated log ${log_id}`);
      }
    } catch (error) {
      console.error('Error updating workout logs:', error);
    }
  };

  const saveWorkoutDetails = async () => {
    setErrorMessage(null);
    console.log('saveWorkoutDetails called, workout_id:', workout_id, 'workoutName:', workoutName, 'days count:', days.length);
    try {
      const originalLogs = await fetchOriginalWorkoutLogData(workout_id);
      console.log('fetchOriginalWorkoutLogData done, logs:', originalLogs?.length);

      if (!workoutName.trim()) {
        const msg = t('workoutNameErrorMessage');
        setErrorMessage(msg);
        return;
      }

      for (const day of days) {
        if (!day.day_name.trim()) {
          setErrorMessage(t('provideDayNamesErrorMessage'));
          return;
        }
        for (const exercise of day.exercises) {
          const isCardio = isCardioExerciseInEditor(workoutType, exercise);
          if (!exercise.exercise_name.trim()) {
            setErrorMessage(t('fillExercisesErrorMessage'));
            return;
          }
          if (isCardio) {
            const dur = Number(exercise.reps);
            if (!Number.isFinite(dur) || dur <= 0) {
              setErrorMessage(
                t('fillExercisesErrorMessage') ||
                  'Enter a duration in minutes for each cardio exercise.',
              );
              return;
            }
          } else {
            if (
              !exercise.sets ||
              !exercise.reps ||
              parseInt(exercise.sets.toString(), 10) === 0 ||
              parseInt(exercise.reps.toString(), 10) === 0
            ) {
              setErrorMessage(t('fillExercisesErrorMessage'));
              return;
            }
          }
        }
      }

      setIsSaving(true);
      console.log('Updating workout name...');

      // Update days and exercises
      // Ensure workout_type exists for older DBs and persist it.
      await db.runAsync("ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';").catch(() => {});
      await db.runAsync('UPDATE Workouts SET workout_name = ?, workout_type = ? WHERE workout_id = ?;', [
        workoutName.trim(),
        workoutType,
        workout_id,
      ]);

      // Fetch the updated workout name
      const updatedWorkout = await db.getAllAsync<{ workout_name: string }>(
        'SELECT workout_name FROM Workouts WHERE workout_id = ?;',
        [workout_id]
      );

      const updatedWorkoutName = updatedWorkout[0].workout_name;

      // Update days and exercises
      for (const day of days) {
        // Update day name
        await db.runAsync('UPDATE Days SET day_name = ? WHERE day_id = ?;', 
          [day.day_name.trim(), day.day_id]
        );
        
        await db.runAsync('DELETE FROM Exercises WHERE day_id = ?;', [day.day_id]);

        let sortIdx = 0;
        for (const exercise of day.exercises) {
          const isCardio = isCardioExerciseInEditor(workoutType, exercise);
          const nameTrim = exercise.exercise_name.trim();
          if (isCardio) {
            const dur = Math.max(1, Math.round(Number(exercise.reps) || 0));
            const displayName = ensureCardioExerciseName(nameTrim);
            const dist = formatCardioDistanceForDb(
              exercise._cardioDistValue ?? '',
              exercise._cardioDistUnit ?? 'km',
            );
            try {
              await db.runAsync(
                'INSERT INTO Exercises (day_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order, exercise_type, duration_minutes, cardio_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
                [
                  day.day_id,
                  displayName,
                  1,
                  dur,
                  exercise.web_link,
                  exercise.muscle_group,
                  exercise.exercise_notes,
                  exercise.rest_seconds ?? DEFAULT_REST_SECONDS_BETWEEN_SETS,
                  sortIdx,
                  'cardio',
                  dur,
                  dist,
                ],
              );
            } catch {
              await db.runAsync(
                'INSERT INTO Exercises (day_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
                [
                  day.day_id,
                  displayName,
                  1,
                  dur,
                  exercise.web_link,
                  exercise.muscle_group,
                  exercise.exercise_notes,
                  exercise.rest_seconds ?? DEFAULT_REST_SECONDS_BETWEEN_SETS,
                  sortIdx,
                ],
              );
            }
          } else {
            try {
              await db.runAsync(
                'INSERT INTO Exercises (day_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds, sort_order, exercise_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
                [
                  day.day_id,
                  nameTrim,
                  exercise.sets,
                  exercise.reps,
                  exercise.web_link,
                  exercise.muscle_group,
                  exercise.exercise_notes,
                  exercise.rest_seconds ?? DEFAULT_REST_SECONDS_BETWEEN_SETS,
                  sortIdx,
                  'strength',
                ],
              );
            } catch {
              await db.runAsync(
                'INSERT INTO Exercises (day_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
                [
                  day.day_id,
                  nameTrim,
                  exercise.sets,
                  exercise.reps,
                  exercise.web_link,
                  exercise.muscle_group,
                  exercise.exercise_notes,
                  exercise.rest_seconds ?? DEFAULT_REST_SECONDS_BETWEEN_SETS,
                ],
              );
            }
          }
          sortIdx += 1;
        }
      }

      console.log('Updating days and exercises...');
      // Update logs after saving the workout
      await updateWorkoutLogs(originalLogs, updatedWorkoutName);
      console.log('updateWorkoutLogs done, going back');
      navigation.goBack();
    } catch (error) {
      console.error('saveWorkoutDetails error:', error);
      setErrorMessage('Failed to update workout details.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDayNameChange = (dayId: number, newName: string) => {
    setDays((prevDays) =>
      prevDays.map((day) =>
        day.day_id === dayId ? { ...day, day_name: newName } : day
      )
    );
  };

  const handleExerciseChange = (
    dayId: number,
    exerciseIndex: number,
    field:
      | 'exercise_name'
      | 'sets'
      | 'reps'
      | 'rest_seconds'
      | '_cardioDistValue'
      | '_cardioDistUnit',
    value: string | number,
  ) => {
    setDays((prevDays) =>
      prevDays.map((day) => {
        if (day.day_id !== dayId) return day;
        return {
          ...day,
          exercises: day.exercises.map((exercise, index) => {
            if (index !== exerciseIndex) return exercise;
            if (field === 'exercise_name') {
              return { ...exercise, exercise_name: String(value) };
            }
            if (field === 'rest_seconds') {
              return {
                ...exercise,
                rest_seconds:
                  value === ''
                    ? null
                    : typeof value === 'number'
                      ? value
                      : parseInt(String(value), 10) || null,
              };
            }
            if (field === '_cardioDistValue') {
              return { ...exercise, _cardioDistValue: String(value) };
            }
            if (field === '_cardioDistUnit') {
              return {
                ...exercise,
                _cardioDistUnit: value === 'mi' ? 'mi' : 'km',
              };
            }
            const isCardio = isCardioExerciseInEditor(workoutType, exercise);
            if (field === 'reps' && isCardio) {
              const raw = String(value).replace(/[^0-9.,]/g, '').replace(',', '.');
              const n = parseFloat(raw);
              return {
                ...exercise,
                reps: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0,
              };
            }
            if (field === 'sets' || field === 'reps') {
              const n = parseInt(String(value).replace(/\D/g, ''), 10);
              return {
                ...exercise,
                [field]: Number.isFinite(n) ? n : 0,
              };
            }
            return exercise;
          }),
        };
      }),
    );
  };

  // Handle exercise reordering
  const handleExerciseReorder = (dayId: number, newExercises: Exercise[]) => {
    setDays((prevDays) =>
      prevDays.map((day) =>
        day.day_id === dayId ? { ...day, exercises: newExercises } : day
      )
    );
  };

  const removeExerciseFromDay = useCallback(
    (dayId: number, exerciseId: number) => {
      const day = days.find((d) => d.day_id === dayId);
      if (!day) return;
      if (day.exercises.length <= 1) {
        Alert.alert(t('errorTitle'), t('cannotDeleteLastExercise'));
        return;
      }
      setDays((prev) =>
        prev.map((d) =>
          d.day_id === dayId
            ? { ...d, exercises: d.exercises.filter((e) => e.exercise_id !== exerciseId) }
            : d,
        ),
      );
    },
    [days, t],
  );

  const renderExerciseItem = ({ item, drag, isActive }: RenderItemParams<Exercise>, day: Day) => {
    let exerciseSwipeRef: Swipeable | null = null;
    const index = day.exercises.findIndex((e) => e.exercise_id === item.exercise_id);
    const showCardio = isCardioExerciseInEditor(workoutType, item);

    return (
      <Swipeable
        ref={(r) => {
          exerciseSwipeRef = r;
        }}
        enabled={!isActive}
        friction={2}
        overshootLeft={false}
        overshootRight={false}
        renderRightActions={() => (
          <RectButton
            style={styles.exerciseSwipeDelete}
            onPress={() => {
              exerciseSwipeRef?.close();
              removeExerciseFromDay(day.day_id, item.exercise_id);
            }}
          >
            <Ionicons name="trash-outline" size={20} color="#fff" />
            <Text style={styles.exerciseSwipeDeleteText}>{t('Delete')}</Text>
          </RectButton>
        )}
      >
      <TouchableOpacity
        onLongPress={drag}
        disabled={isActive}
        style={[
          styles.exerciseContainer,
          showCardio && { flexDirection: 'column', alignItems: 'stretch' },
        ]}
      >
        <TouchableOpacity onPressIn={drag} style={[styles.dragHandle, showCardio && { alignSelf: 'flex-start' }]}>
          <Ionicons name="reorder-three" size={30} color={theme.text} />
        </TouchableOpacity>

        <View style={{ flex: showCardio ? undefined : 1, flexGrow: 1, minWidth: 0 }}>
          <TextInput
            style={[styles.exerciseInput, { color: theme.text }, showCardio && { flex: undefined, width: '100%' }]}
            value={item.exercise_name}
            onChangeText={(text) =>
              handleExerciseChange(day.day_id, index, 'exercise_name', text)
            }
            placeholder={t('exerciseNamePlaceholder')}
            placeholderTextColor={theme.text}
          />

          {showCardio ? (
            <>
              <Text style={[styles.cardioFieldLabel, { color: theme.textSecondary }]}>
                Duration (minutes)
              </Text>
              <TextInput
                style={[styles.exerciseInput, { color: theme.text, marginBottom: 8 }]}
                value={item.reps ? String(item.reps) : ''}
                onChangeText={(text) =>
                  handleExerciseChange(day.day_id, index, 'reps', text)
                }
                keyboardType="decimal-pad"
                placeholder="e.g. 30"
                placeholderTextColor={theme.text}
              />
              <Text style={[styles.cardioFieldLabel, { color: theme.textSecondary }]}>
                Distance (optional)
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <TextInput
                  style={[styles.numberInput, { color: theme.text, flex: 1, minWidth: 80 }]}
                  value={item._cardioDistValue ?? ''}
                  onChangeText={(text) =>
                    handleExerciseChange(day.day_id, index, '_cardioDistValue', text.replace(/[^0-9.,]/g, ''))
                  }
                  keyboardType="decimal-pad"
                  placeholder="e.g. 5"
                  placeholderTextColor={theme.text}
                />
                <TouchableOpacity
                  onPress={() =>
                    handleExerciseChange(day.day_id, index, '_cardioDistUnit', 'km')
                  }
                  style={[
                    styles.unitChip,
                    {
                      borderColor: theme.border,
                      backgroundColor:
                        (item._cardioDistUnit ?? 'km') === 'km' ? SAGE : theme.card,
                    },
                  ]}
                >
                  <Text
                    style={{
                      fontWeight: '600',
                      color: (item._cardioDistUnit ?? 'km') === 'km' ? '#fff' : theme.text,
                    }}
                  >
                    km
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() =>
                    handleExerciseChange(day.day_id, index, '_cardioDistUnit', 'mi')
                  }
                  style={[
                    styles.unitChip,
                    {
                      borderColor: theme.border,
                      backgroundColor: item._cardioDistUnit === 'mi' ? SAGE : theme.card,
                    },
                  ]}
                >
                  <Text
                    style={{
                      fontWeight: '600',
                      color: item._cardioDistUnit === 'mi' ? '#fff' : theme.text,
                    }}
                  >
                    mi
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
              <TextInput
                style={[styles.numberInput, { color: theme.text }]}
                value={item.sets.toString()}
                onChangeText={(text) =>
                  handleExerciseChange(day.day_id, index, 'sets', text)
                }
                keyboardType="numeric"
                placeholder={t('setsPlaceholder')}
                placeholderTextColor={theme.text}
              />
              <TextInput
                style={[styles.numberInput, { color: theme.text }]}
                value={item.reps.toString()}
                onChangeText={(text) =>
                  handleExerciseChange(day.day_id, index, 'reps', text)
                }
                keyboardType="numeric"
                placeholder={t('repsPlaceholder')}
                placeholderTextColor={theme.text}
              />
              <TextInput
                style={[styles.restInput, { color: theme.text }]}
                value={
                  item.rest_seconds != null
                    ? String(item.rest_seconds)
                    : String(DEFAULT_REST_SECONDS_BETWEEN_SETS)
                }
                onChangeText={(text) => {
                  const sanitized = text.replace(/[^0-9]/g, '');
                  handleExerciseChange(
                    day.day_id,
                    index,
                    'rest_seconds',
                    sanitized === '' ? '' : parseInt(sanitized, 10),
                  );
                }}
                keyboardType="numeric"
                placeholder={t('restSecondsPlaceholder') || 'Rest (s)'}
                placeholderTextColor={theme.text}
              />
            </View>
          )}
        </View>
      </TouchableOpacity>
      </Swipeable>
    );
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        {/* Frozen top row with back arrow */}
        <View style={[styles.stickyHeader, { backgroundColor: theme.background, borderBottomColor: theme.border }]}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.stickyHeaderTitle, { color: theme.text }]} numberOfLines={1}>{t('editWorkout')}</Text>
          <View style={styles.stickyHeaderSpacer} />
        </View>

      <ScrollView contentContainerStyle={{ flexGrow: 1 }} showsVerticalScrollIndicator={false}>
        <View style={[styles.container, { backgroundColor: theme.background }]}>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
            <TouchableOpacity
              onPress={() => setWorkoutType('strength')}
              activeOpacity={0.85}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: workoutType === 'strength' ? SAGE : theme.card,
              }}
            >
              <Text style={{ fontWeight: '700', color: workoutType === 'strength' ? '#fff' : theme.text }}>
                Strength
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setWorkoutType('cardio')}
              activeOpacity={0.85}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: workoutType === 'cardio' ? SAGE : theme.card,
              }}
            >
              <Text style={{ fontWeight: '700', color: workoutType === 'cardio' ? '#fff' : theme.text }}>
                Cardio
              </Text>
            </TouchableOpacity>
          </View>

          {/* Workout Name */}
          <TextInput
            style={[styles.inputWorkoutName, { color: theme.text, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }]}
            value={workoutName}
            onChangeText={setWorkoutName}
            placeholder={t('workoutNamePlaceholder')}
            placeholderTextColor={theme.text}
          />

          {/* Days and Exercises */}
          <Text style={[styles.subtitle, { color: theme.text }]}>{t('daysAndExercises')}</Text>
          {days.map((day) => (
            <View key={day.day_id} style={[styles.dayContainer, { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }]}>
              {/* Day Name */}
              <TextInput
                style={[styles.dayInput, { color: theme.text }]}
                value={day.day_name}
                onChangeText={(text) => handleDayNameChange(day.day_id, text)}
                placeholder={t('dayNamePlaceholder')}
                placeholderTextColor={theme.text}
              />

              <View style={styles.exercisesContainer}>
                <DraggableFlatList
                  scrollEnabled={false}
                  data={day.exercises}
                  renderItem={(props) => renderExerciseItem(props, day)}
                  keyExtractor={(item) => item.exercise_id.toString()}
                  onDragEnd={({ data }) => handleExerciseReorder(day.day_id, data)}
                  activationDistance={3}
                  containerStyle={styles.draggableListContainer}
                />
              </View>
            </View>
          ))}

          {/* Save Button */}
          <TouchableOpacity
            style={[styles.saveButton, { backgroundColor: theme.buttonBackground }]}
            onPress={saveWorkoutDetails}
            disabled={isSaving}
          >
            <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>
              {isSaving ? t('isSaving') : t('saveChanges')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
      {errorMessage ? (
        <View style={[styles.errorBanner, { backgroundColor: SAGE }]}>
          <Text style={styles.errorBannerText}>{errorMessage}</Text>
          <TouchableOpacity onPress={() => setErrorMessage(null)} hitSlop={8}>
            <Text style={styles.errorBannerText}>✕</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  stickyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  stickyHeaderTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  stickyHeaderSpacer: {
    width: 40,
  },
  errorBanner: {
    position: 'absolute',
    bottom: 90,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  errorBannerText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  backButton: {
    padding: 8,
  },

  inputWorkoutName: {
    borderRadius: 15,
    padding: 12,
    fontSize: 24,
    marginBottom: 16,
    backgroundColor: 'transparent',
    fontWeight: 'bold',
    textAlign: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  input: {
    borderRadius: 15,
    padding: 14,
    fontSize: 18,
    marginBottom: 20,
    backgroundColor: 'transparent',
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 14,
    marginTop: 20,
  },
  dayContainer: {
    padding: 16,
    borderRadius: 15,
    marginTop: 14,
    marginBottom: 24,
    backgroundColor: 'transparent',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  dayInput: {
    fontSize: 22,
    marginBottom: 14,
    paddingBottom: 6,
    fontWeight: 'bold',
  },
  exercisesContainer: {
    flex: 1,
  },
  draggableListContainer: {
    flex: 1,
  },
  exerciseContainer: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    marginBottom: 15, 
    padding: 10, 
    borderRadius: 10, 
    backgroundColor: 'transparent',
  },
  exerciseSwipeDelete: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 88,
    backgroundColor: '#c62828',
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
    flex: 1,
  },
  exerciseSwipeDeleteText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    marginTop: 4,
  },
  dragHandle: {
    marginRight: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  exerciseInput: { 
    flex: 3, 
    marginHorizontal: 5, 
    paddingVertical: 6, 
    fontSize: 16, 
  },
  numberInput: {
    flex: 1,
    marginHorizontal: 5,
    paddingVertical: 6,
    fontSize: 16,
    textAlign: 'center',
  },
  restInput: {
    width: 56,
    marginHorizontal: 4,
    paddingVertical: 6,
    fontSize: 16,
    textAlign: 'center',
  },
  cardioFieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
    marginBottom: 4,
  },
  unitChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  saveButton: {
    paddingVertical: 16,
    borderRadius: 15,
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 24,
    backgroundColor: 'transparent',
  },
  saveButtonText: { 
    fontSize: 20, 
    fontWeight: 'bold', 
    color: 'transparent'
  }
});