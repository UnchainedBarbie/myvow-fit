import { useNavigation } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { WorkoutStackParamList } from '../App'; // Adjust path to where WorkoutStackParamList is defined
import { StackNavigationProp } from '@react-navigation/stack';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTheme } from '../context/ThemeContext'; // Import theme context
import { useTranslation } from 'react-i18next';
import { DEFAULT_REST_SECONDS_BETWEEN_SETS } from '../utils/startedWorkoutPreferenceUtils';
import { initWorkoutDb } from '../utils/initWorkoutDb';
import {
  ensureCardioExerciseName,
  formatCardioDistanceForDb,
} from '../utils/cardioExerciseUtils';

type WorkoutListNavigationProp = StackNavigationProp<WorkoutStackParamList, 'WorkoutsList'>;

type DayExerciseForm = {
  exerciseName: string;
  sets: string;
  reps: string;
  muscle_groups: string[];
  restSeconds: string;
  durationMinutes: string;
  distance: string;
  distanceUnit: 'km' | 'mi';
};

async function insertStrengthExerciseRow(
  db: any,
  dayId: number,
  sortOrder: number,
  exercise: {
    exerciseName: string;
    sets: number;
    reps: number;
    muscle_group: string | null;
    rest_seconds: number | null;
  },
) {
  try {
    await db.runAsync(
      'INSERT INTO Exercises (day_id, exercise_name, sets, reps, muscle_group, rest_seconds, sort_order, exercise_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
      [
        dayId,
        exercise.exerciseName,
        exercise.sets,
        exercise.reps,
        exercise.muscle_group,
        exercise.rest_seconds ?? DEFAULT_REST_SECONDS_BETWEEN_SETS,
        sortOrder,
        'strength',
      ],
    );
  } catch {
    await db.runAsync(
      'INSERT INTO Exercises (day_id, exercise_name, sets, reps, muscle_group, rest_seconds) VALUES (?, ?, ?, ?, ?, ?);',
      [
        dayId,
        exercise.exerciseName,
        exercise.sets,
        exercise.reps,
        exercise.muscle_group,
        exercise.rest_seconds ?? DEFAULT_REST_SECONDS_BETWEEN_SETS,
      ],
    );
  }
}

/** Cardio: duration in `reps` (minutes), sets=1; distance in `cardio_distance`. */
async function insertCardioExerciseRow(
  db: any,
  dayId: number,
  sortOrder: number,
  exerciseName: string,
  durationMinutes: number,
  cardioDistance: string | null,
) {
  const sets = 1;
  const reps = Math.max(1, durationMinutes);
  try {
    await db.runAsync(
      'INSERT INTO Exercises (day_id, exercise_name, sets, reps, muscle_group, rest_seconds, sort_order, exercise_type, duration_minutes, cardio_distance) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?);',
      [
        dayId,
        exerciseName,
        sets,
        reps,
        DEFAULT_REST_SECONDS_BETWEEN_SETS,
        sortOrder,
        'cardio',
        reps,
        cardioDistance,
      ],
    );
  } catch {
    await db.runAsync(
      'INSERT INTO Exercises (day_id, exercise_name, sets, reps, muscle_group, rest_seconds) VALUES (?, ?, ?, ?, NULL, ?);',
      [dayId, exerciseName, sets, reps, DEFAULT_REST_SECONDS_BETWEEN_SETS],
    );
  }
}

async function createWorkout(
  db: any,
  workoutName: string,
  workoutType: 'strength' | 'cardio',
  days: {
    dayName: string;
    exercises: Array<{
      exerciseName: string;
      sets: number;
      reps: number;
      muscle_group: string | null;
      rest_seconds: number | null;
      durationMinutes?: number;
      cardioDistance?: string | null;
    }>;
  }[],
) {
  await db.withTransactionAsync(async () => {
    try {
      await initWorkoutDb(db);
      await db.runAsync("ALTER TABLE Workouts ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';").catch(() => {});
      await db.runAsync('INSERT INTO Workouts (workout_name, workout_type) VALUES (?, ?);', [workoutName, workoutType]);

      const workoutIdResult = (await db.getAllAsync('SELECT last_insert_rowid() as workout_id;')) as {
        workout_id: number;
      }[];

      if (!workoutIdResult.length) throw new Error('Failed to retrieve workout ID.');

      const workoutId = workoutIdResult[0].workout_id;

      for (const day of days) {
        await db.runAsync('INSERT INTO Days (workout_id, day_name) VALUES (?, ?);', [workoutId, day.dayName]);
        const dayIdResult = (await db.getAllAsync('SELECT last_insert_rowid() as day_id;')) as {
          day_id: number;
        }[];

        if (!dayIdResult.length) throw new Error('Failed to retrieve day ID.');

        const dayId = dayIdResult[0].day_id;

        let sortOrder = 0;
        for (const exercise of day.exercises) {
          if (workoutType === 'cardio') {
            const mins = exercise.durationMinutes ?? exercise.reps;
            const name = ensureCardioExerciseName(exercise.exerciseName);
            await insertCardioExerciseRow(
              db,
              dayId,
              sortOrder,
              name,
              mins,
              exercise.cardioDistance ?? null,
            );
          } else {
            await insertStrengthExerciseRow(db, dayId, sortOrder, exercise);
          }
          sortOrder += 1;
        }
      }
    } catch (error) {
      console.error('Error during transaction:', error);
      throw error;
    }
  });
}

function emptyExerciseForm(mode: 'strength' | 'cardio'): DayExerciseForm {
  return {
    exerciseName: '',
    sets: mode === 'strength' ? '' : '1',
    reps: mode === 'strength' ? '' : '',
    muscle_groups: [],
    restSeconds: '',
    durationMinutes: '',
    distance: '',
    distanceUnit: 'km',
  };
}

export default function CreateWorkout() {
  const db = useSQLiteContext();
  const { theme } = useTheme(); // Get the current theme
  const { t } = useTranslation(); // Initialize translations
  const [workoutName, setWorkoutName] = useState('');
  const [workoutType, setWorkoutType] = useState<'strength' | 'cardio'>('strength');
  const [days, setDays] = useState<{ dayName: string; exercises: DayExerciseForm[] }[]>([]);
  const navigation = useNavigation<WorkoutListNavigationProp>();

  const dayNameRefs = useRef<Record<number, TextInput | null>>({});
  const exerciseNameRefs = useRef<Record<string, TextInput | null>>({});

  const muscleGroups = [
    { label: 'Chest', value: 'chest' },
    { label: 'Back', value: 'back' },
    { label: 'Shoulders', value: 'shoulders' },
    { label: 'Arms', value: 'arms' },
    { label: 'Legs', value: 'legs' },
    { label: 'Glutes', value: 'glutes' },
    { label: 'Core', value: 'core' },
    { label: 'Full Body', value: 'full_body' },
  ];

  const addDay = () => {
    setDays((prev) => [
      ...prev,
      {
        dayName: '',
        exercises: [emptyExerciseForm(workoutType === 'cardio' ? 'cardio' : 'strength')],
      },
    ]);
  };

  const addExercise = (dayIndex: number) => {
    setDays((prev) => {
      const updatedDays = [...prev];
      updatedDays[dayIndex].exercises.push(
        emptyExerciseForm(workoutType === 'cardio' ? 'cardio' : 'strength'),
      );
      return updatedDays;
    });
  };

  const toggleMuscleGroup = (dayIndex: number, exerciseIndex: number, value: string) => {
    setDays((prev) => {
      const updatedDays = prev.map((d, di) =>
        di !== dayIndex
          ? d
          : {
              ...d,
              exercises: d.exercises.map((ex, ei) =>
                ei !== exerciseIndex
                  ? ex
                  : {
                      ...ex,
                      muscle_groups: ex.muscle_groups.includes(value)
                        ? ex.muscle_groups.filter((v) => v !== value)
                        : [...ex.muscle_groups, value],
                    }
              ),
            }
      );
      return updatedDays;
    });
  };

  const deleteDay = (index: number) => {
    Alert.alert(
      t('deleteDayTitle'),
      t('deleteDayMessage'),
      [
        { text: t('alertCancel'), style: 'cancel' },
        {
          text: t('alertDelete'),
          style: 'destructive',
          onPress: () => {
            setDays((prev) => prev.filter((_, dayIndex) => dayIndex !== index));
          },
        },
      ]
    );
  };

  const deleteExercise = (dayIndex: number, exerciseIndex: number) => {
    Alert.alert(
      t('deleteExerciseTitle'),
      t('deleteExerciseMessage'),
      [
        { text: t('alertCancel'), style: 'cancel' },
        {
          text: t('alertDelete'),
          style: 'destructive',
          onPress: () => {
            setDays((prev) => {
              const updatedDays = [...prev];
              updatedDays[dayIndex].exercises = updatedDays[dayIndex].exercises.filter(
                (_, exIndex) => exIndex !== exerciseIndex
              );
              return updatedDays;
            });
          },
        },
      ]
    );
  };

  const handleSaveWorkout = async () => {
    if (!workoutName.trim()) {
      Alert.alert(t('errorTitle'),
      t('workoutNameErrorMessage'));
      return;
    }

    if (days.some((day) => !day.dayName.trim())) {
      Alert.alert(t('errorTitle'),
      t('provideDayNamesErrorMessage'));
      return;
    }

    if (workoutType === 'strength') {
      const strengthInvalid = days.some((day) =>
        day.exercises.some(
          (exercise) =>
            !exercise.exerciseName.trim() ||
            !exercise.sets ||
            !exercise.reps ||
            parseInt(exercise.sets, 10) === 0 ||
            parseInt(exercise.reps, 10) === 0,
        ),
      );
      if (strengthInvalid) {
        Alert.alert(t('errorTitle'), t('fillExercisesErrorMessage'));
        return;
      }
    }

    if (workoutType === 'cardio') {
      const cardioInvalid = days.some((day) =>
        day.exercises.some((exercise) => {
          const mins = parseFloat(exercise.durationMinutes.replace(',', '.'));
          return (
            !exercise.exerciseName.trim() ||
            !Number.isFinite(mins) ||
            mins <= 0
          );
        }),
      );
      if (cardioInvalid) {
        Alert.alert(
          t('errorTitle'),
          t('fillExercisesErrorMessage') ||
            'Add a name and duration (minutes) for each cardio exercise.',
        );
        return;
      }
    }

    const formattedDays = days.map((day) => ({
      dayName: day.dayName,
      exercises: day.exercises.map((exercise) => {
        if (workoutType === 'cardio') {
          const mins = Math.max(
            1,
            Math.round(parseFloat(exercise.durationMinutes.replace(',', '.')) || 0),
          );
          const dist = formatCardioDistanceForDb(
            exercise.distance,
            exercise.distanceUnit,
          );
          return {
            exerciseName: exercise.exerciseName,
            sets: 1,
            reps: mins,
            muscle_group: null,
            rest_seconds: DEFAULT_REST_SECONDS_BETWEEN_SETS,
            durationMinutes: mins,
            cardioDistance: dist,
          };
        }
        const restSec = exercise.restSeconds.trim();
        const setsN = parseInt(exercise.sets, 10);
        const repsN = parseInt(exercise.reps, 10);
        return {
          exerciseName: exercise.exerciseName,
          sets: Number.isFinite(setsN) && setsN > 0 ? setsN : 1,
          reps: Number.isFinite(repsN) && repsN > 0 ? repsN : 1,
          muscle_group: exercise.muscle_groups[0] ?? null,
          rest_seconds: restSec ? parseInt(restSec, 10) : null,
        };
      }),
    }));

    try {
      await createWorkout(db, workoutName, workoutType, formattedDays);
      navigation.goBack();
      setWorkoutName('');
      setDays([]);
    } catch (error) {
      Alert.alert(t('errorTitle'), t('failedToCreateWorkoutErrorMessage'));
      console.error(error);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <FlatList
          data={days}
          keyExtractor={(item, index) => index.toString()}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.contentContainer}
          ListHeaderComponent={
            <>
              <View style={styles.header}>
                <TouchableOpacity
                  style={styles.backButton}
                  onPress={() => navigation.goBack()}
                >
                  <Ionicons name="arrow-back" size={28} color={theme.text} />
                </TouchableOpacity>
                <Text style={[styles.title, { color: theme.text }]}>{t('CreateAWorkout')}</Text>
              </View>

              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                <TouchableOpacity
                  onPress={() => {
                    setWorkoutType('strength');
                    setDays((prev) =>
                      prev.map((d) => ({
                        ...d,
                        exercises: [emptyExerciseForm('strength')],
                      })),
                    );
                  }}
                  activeOpacity={0.85}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 12,
                    alignItems: 'center',
                    borderWidth: 1,
                    borderColor: theme.border,
                    backgroundColor: workoutType === 'strength' ? theme.buttonBackground : theme.card,
                  }}
                >
                  <Text style={{ fontWeight: '700', color: workoutType === 'strength' ? theme.buttonText : theme.text }}>
                    Strength
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    setWorkoutType('cardio');
                    setDays((prev) =>
                      prev.map((d) => ({
                        ...d,
                        exercises: [emptyExerciseForm('cardio')],
                      })),
                    );
                  }}
                  activeOpacity={0.85}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 12,
                    alignItems: 'center',
                    borderWidth: 1,
                    borderColor: theme.border,
                    backgroundColor: workoutType === 'cardio' ? theme.buttonBackground : theme.card,
                  }}
                >
                  <Text style={{ fontWeight: '700', color: workoutType === 'cardio' ? theme.buttonText : theme.text }}>
                    Cardio
                  </Text>
                </TouchableOpacity>
              </View>

              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.card,
                    color: theme.text,
                    borderWidth: 1,
                    borderColor: theme.border,
                  },
                ]}
                placeholder={t('workoutNamePlaceholder')}
                placeholderTextColor={theme.text}
                value={workoutName}
                onChangeText={setWorkoutName}
              />
            </>
          }
          renderItem={({ item, index }) => {
            let daySwipeRef: Swipeable | null = null;

            const renderDayLeftActions = () => (
              <RectButton
                style={[styles.swipeAction, styles.swipeActionEdit]}
                onPress={() => {
                  daySwipeRef?.close();
                  requestAnimationFrame(() => dayNameRefs.current[index]?.focus());
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
                  deleteDay(index);
                }}
              >
                <Ionicons name="trash-outline" size={22} color="#fff" />
                <Text style={styles.swipeActionText}>{t('Delete')}</Text>
              </RectButton>
            );

            return (
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
                { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
              ]}
            >
              <TextInput
                ref={(r) => {
                  dayNameRefs.current[index] = r;
                }}
                style={[
                  styles.dayInput,
                  { color: theme.text, borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: 14 },
                ]}
                placeholder={t('dayNamePlaceholder')}
                placeholderTextColor={theme.text}
                value={item.dayName}
                onLongPress={() => deleteDay(index)}
                delayLongPress={450}
                onChangeText={(text) => {
                  const updatedDays = [...days];
                  updatedDays[index].dayName = text;
                  setDays(updatedDays);
                }}
              />

              {workoutType === 'strength' && item.exercises.map((exercise, exerciseIndex) => {
                let exerciseSwipeRef: Swipeable | null = null;
                const exKey = `${index}-${exerciseIndex}`;

                const renderExerciseLeftActions = () => (
                  <RectButton
                    style={[styles.swipeAction, styles.swipeActionEdit]}
                    onPress={() => {
                      exerciseSwipeRef?.close();
                      requestAnimationFrame(() =>
                        exerciseNameRefs.current[exKey]?.focus(),
                      );
                    }}
                  >
                    <Ionicons name="create-outline" size={20} color="#fff" />
                    <Text style={styles.swipeActionText}>{t('edit')}</Text>
                  </RectButton>
                );

                const renderExerciseRightActions = () => (
                  <RectButton
                    style={[styles.swipeAction, styles.swipeActionDelete]}
                    onPress={() => {
                      exerciseSwipeRef?.close();
                      deleteExercise(index, exerciseIndex);
                    }}
                  >
                    <Ionicons name="trash-outline" size={20} color="#fff" />
                    <Text style={styles.swipeActionText}>{t('Delete')}</Text>
                  </RectButton>
                );

                return (
                <Swipeable
                  key={exerciseIndex}
                  ref={(r) => {
                    exerciseSwipeRef = r;
                  }}
                  friction={2}
                  overshootLeft={false}
                  overshootRight={false}
                  renderLeftActions={renderExerciseLeftActions}
                  renderRightActions={renderExerciseRightActions}
                >
                <View
                  style={[
                    styles.exerciseCard,
                    {
                      backgroundColor: theme.background,
                      borderColor: theme.border,
                    },
                  ]}
                >
                  <View style={styles.exerciseRow}>
                    <TextInput
                      ref={(r) => {
                        exerciseNameRefs.current[exKey] = r;
                      }}
                      style={[
                        styles.exerciseInput,
                        {
                          backgroundColor: theme.card,
                          color: theme.text,
                          borderWidth: 1,
                          borderColor: theme.border,
                        },
                      ]}
                      placeholder={t('exerciseNamePlaceholder')}
                      placeholderTextColor={theme.text}
                      value={exercise.exerciseName}
                      onLongPress={() => deleteExercise(index, exerciseIndex)}
                      delayLongPress={450}
                      onChangeText={(text) => {
                        const updatedDays = [...days];
        updatedDays[index].exercises[exerciseIndex].exerciseName =
                          text;
                        setDays(updatedDays);
                      }}
                    />
                    <TextInput
                      style={[
                        styles.smallInput,
                        {
                          backgroundColor: theme.card,
                          color: theme.text,
                          borderWidth: 1,
                          borderColor: theme.border,
                        },
                      ]}
                      placeholder={t('setsPlaceholder') + " (> 0)"}
                      placeholderTextColor={theme.text}
                      keyboardType="numeric"
                      value={exercise.sets}
                      onChangeText={(text) => {
                        const sanitizedText = text.replace(/[^0-9]/g, ''); // Remove non-numeric characters
                        const updatedDays = [...days];
                        updatedDays[index].exercises[
                          exerciseIndex
                        ].sets = sanitizedText; // Allow empty string
                        setDays(updatedDays);
                      }}
                    />
                    <TextInput
                      style={[
                        styles.smallInput,
                        {
                          backgroundColor: theme.card,
                          color: theme.text,
                          borderWidth: 1,
                          borderColor: theme.border,
                        },
                      ]}
                      placeholder={t('repsPlaceholder') + " (> 0)"}
                      placeholderTextColor={theme.text}
                      keyboardType="numeric"
                      value={exercise.reps}
                      onChangeText={(text) => {
                        const sanitizedText = text.replace(/[^0-9]/g, '');
                        const updatedDays = [...days];
                        updatedDays[index].exercises[exerciseIndex].reps = sanitizedText;
                        setDays(updatedDays);
                      }}
                    />
                    <TextInput
                      style={[
                        styles.smallInput,
                        {
                          backgroundColor: theme.card,
                          color: theme.text,
                          minWidth: 56,
                          borderWidth: 1,
                          borderColor: theme.border,
                        },
                      ]}
                      placeholder={t('restSecondsPlaceholder') || 'Rest (s)'}
                      placeholderTextColor={theme.text}
                      keyboardType="numeric"
                      value={exercise.restSeconds}
                      onChangeText={(text) => {
                        const sanitizedText = text.replace(/[^0-9]/g, '');
                        const updatedDays = [...days];
                        updatedDays[index].exercises[exerciseIndex].restSeconds = sanitizedText;
                        setDays(updatedDays);
                      }}
                    />
                  </View>
                  <Text style={[styles.muscleGroupLabel, { color: theme.text }]}>{t('muscleGroup') || 'Muscle Groups'}</Text>
                  <View style={styles.muscleGroupChipGrid}>
                    {muscleGroups.map((mg) => {
                      const isSelected = exercise.muscle_groups.includes(mg.value);
                      return (
                        <TouchableOpacity
                          key={mg.value}
                          style={[
                            styles.muscleGroupChip,
                            {
                              backgroundColor: isSelected ? (theme.primary || '#7C9A7E') : theme.card,
                              borderColor: theme.border,
                            },
                          ]}
                          onPress={() => toggleMuscleGroup(index, exerciseIndex, mg.value)}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.muscleGroupChipText,
                              { color: isSelected ? '#fff' : theme.text },
                              isSelected && styles.muscleGroupChipTextSelected,
                            ]}
                          >
                            {mg.label}
                          </Text>
                          {isSelected && (
                            <Ionicons name="checkmark" size={16} color="#fff" style={styles.muscleGroupChipCheck} />
                          )}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
                </Swipeable>
                );
              })}

              {workoutType === 'cardio' &&
                item.exercises.map((exercise, exerciseIndex) => {
                  let cardioSwipeRef: Swipeable | null = null;
                  const exKeyC = `c-${index}-${exerciseIndex}`;
                  const renderCardioDelete = () => (
                    <RectButton
                      style={[styles.swipeAction, styles.swipeActionDelete]}
                      onPress={() => {
                        cardioSwipeRef?.close();
                        deleteExercise(index, exerciseIndex);
                      }}
                    >
                      <Ionicons name="trash-outline" size={20} color="#fff" />
                      <Text style={styles.swipeActionText}>{t('Delete')}</Text>
                    </RectButton>
                  );
                  return (
                    <Swipeable
                      key={`cardio-${exerciseIndex}`}
                      ref={(r) => {
                        cardioSwipeRef = r;
                      }}
                      friction={2}
                      overshootLeft={false}
                      overshootRight={false}
                      renderRightActions={renderCardioDelete}
                    >
                      <View
                        style={[
                          styles.exerciseCard,
                          {
                            backgroundColor: theme.background,
                            borderColor: theme.border,
                          },
                        ]}
                      >
                        <TextInput
                          ref={(r) => {
                            exerciseNameRefs.current[exKeyC] = r;
                          }}
                          style={[
                            styles.exerciseInput,
                            {
                              alignSelf: 'stretch',
                              width: '100%',
                              marginBottom: 8,
                              backgroundColor: theme.card,
                              color: theme.text,
                              borderWidth: 1,
                              borderColor: theme.border,
                            },
                          ]}
                          placeholder={t('exerciseNamePlaceholder')}
                          placeholderTextColor={theme.text}
                          value={exercise.exerciseName}
                          onChangeText={(text) => {
                            const updatedDays = [...days];
                            updatedDays[index].exercises[exerciseIndex].exerciseName = text;
                            setDays(updatedDays);
                          }}
                        />
                        <Text style={[styles.muscleGroupLabel, { color: theme.text }]}>
                          Duration (minutes)
                        </Text>
                        <TextInput
                          style={[
                            styles.exerciseInput,
                            {
                              marginBottom: 8,
                              backgroundColor: theme.card,
                              color: theme.text,
                              borderWidth: 1,
                              borderColor: theme.border,
                            },
                          ]}
                          placeholder="e.g. 30"
                          placeholderTextColor={theme.text}
                          keyboardType="decimal-pad"
                          value={exercise.durationMinutes}
                          onChangeText={(text) => {
                            const sanitized = text.replace(/[^0-9.,]/g, '');
                            const updatedDays = [...days];
                            updatedDays[index].exercises[exerciseIndex].durationMinutes = sanitized;
                            setDays(updatedDays);
                          }}
                        />
                        <Text style={[styles.muscleGroupLabel, { color: theme.text }]}>
                          Distance (optional)
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <TextInput
                            style={[
                              styles.exerciseInput,
                              {
                                flex: 1,
                                minWidth: 100,
                                backgroundColor: theme.card,
                                color: theme.text,
                                borderWidth: 1,
                                borderColor: theme.border,
                              },
                            ]}
                            placeholder="e.g. 5"
                            placeholderTextColor={theme.text}
                            keyboardType="decimal-pad"
                            value={exercise.distance}
                            onChangeText={(text) => {
                              const sanitized = text.replace(/[^0-9.,]/g, '');
                              const updatedDays = [...days];
                              updatedDays[index].exercises[exerciseIndex].distance = sanitized;
                              setDays(updatedDays);
                            }}
                          />
                          <TouchableOpacity
                            onPress={() => {
                              const updatedDays = [...days];
                              updatedDays[index].exercises[exerciseIndex].distanceUnit = 'km';
                              setDays(updatedDays);
                            }}
                            style={{
                              paddingVertical: 10,
                              paddingHorizontal: 14,
                              borderRadius: 8,
                              borderWidth: 1,
                              borderColor: theme.border,
                              backgroundColor:
                                exercise.distanceUnit === 'km' ? theme.buttonBackground : theme.card,
                            }}
                          >
                            <Text
                              style={{
                                fontWeight: '600',
                                color:
                                  exercise.distanceUnit === 'km' ? theme.buttonText : theme.text,
                              }}
                            >
                              km
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => {
                              const updatedDays = [...days];
                              updatedDays[index].exercises[exerciseIndex].distanceUnit = 'mi';
                              setDays(updatedDays);
                            }}
                            style={{
                              paddingVertical: 10,
                              paddingHorizontal: 14,
                              borderRadius: 8,
                              borderWidth: 1,
                              borderColor: theme.border,
                              backgroundColor:
                                exercise.distanceUnit === 'mi' ? theme.buttonBackground : theme.card,
                            }}
                          >
                            <Text
                              style={{
                                fontWeight: '600',
                                color:
                                  exercise.distanceUnit === 'mi' ? theme.buttonText : theme.text,
                              }}
                            >
                              mi
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    </Swipeable>
                  );
                })}

              {(workoutType === 'strength' || workoutType === 'cardio') && (
                <TouchableOpacity
                  style={[
                    styles.addExerciseButton,
                  ]}
                  onPress={() => addExercise(index)}
                >
                  <Text style={[styles.addButtonText, { color: theme.text }]}>
                    {t('addExercise')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            </Swipeable>
            );
          }}
          ListFooterComponent={
            <View>
              <TouchableOpacity
                style={[styles.addDayButton]}
                onPress={addDay}
              >
                <Text style={[styles.addButtonText, { color: theme.text }]}>{t('addDay')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  { backgroundColor: theme.buttonBackground },
                ]}
                onPress={handleSaveWorkout}
              >
                <Text
                  style={[styles.saveButtonText, { color: theme.buttonText }]}
                >
                  {t('saveWorkout')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.cancelButton,
                  {
                    borderColor: theme.border,
                    backgroundColor: theme.card,
                  },
                ]}
                onPress={() => navigation.goBack()}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.cancelButtonText,
                    { color: theme.textSecondary ?? theme.text },
                  ]}
                >
                  {t('Cancel')}
                </Text>
              </TouchableOpacity>
            </View>
          }
        />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingBottom: 60, // Ample space at the bottom
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    marginTop: 20,
  },
  backButton: {
    padding: 5, // make it easier to press
  },
  title: {
    fontSize: 34,
    fontWeight: '800', // A bit bolder for a strong title
    marginLeft: 16,
  },
  input: {
    borderRadius: 12,
    padding: 18,
    marginBottom: 24,
    fontSize: 22,
    fontWeight: 'bold',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  dayContainer: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  dayInput: {
    fontSize: 20,
    fontWeight: '700',
    paddingBottom: 12,
    marginBottom: 16,
  },
  /** One bordered panel per exercise so multiple exercises are visually separated on the day card. */
  exerciseCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  // The exercise row itself will be a touchable opacity
  exerciseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
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
  exerciseInput: {
    flex: 2,
    marginRight: 10,
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
  },
  smallInput: {
    flex: 1,
    textAlign: 'center',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
  },
  addExerciseButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 12,
  },
  addButtonText: {
    // For both Add Exercise and Add Day
    fontWeight: '700',
    fontSize: 16,
    marginLeft: 10,
  },
  addDayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    marginTop: 8,
  },
  saveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    borderRadius: 12,
    marginTop: 24,
  },
  saveButtonText: {
    fontWeight: 'bold',
    fontSize: 18,
  },
  cancelButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    marginTop: 12,
    borderWidth: 1,
  },
  cancelButtonText: {
    fontWeight: '600',
    fontSize: 16,
  },
  muscleGroupLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 8,
  },
  muscleGroupChipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16,
  },
  muscleGroupChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
  },
  muscleGroupChipText: {
    fontSize: 14,
    fontWeight: '500',
  },
  muscleGroupChipTextSelected: {
    fontWeight: '600',
  },
  muscleGroupChipCheck: {
    marginLeft: 6,
  },
});
