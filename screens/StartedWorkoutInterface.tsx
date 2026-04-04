import {
  RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Notifications from 'expo-notifications';
import { useSQLiteContext } from 'expo-sqlite';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View
} from 'react-native';
import { AutoSizeText, ResizeTextMode } from 'react-native-auto-size-text';
import DraggableFlatList, {
  DragEndParams,
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import {
  GestureHandlerRootView,
  RectButton,
  Swipeable,
} from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { WorkoutLogStackParamList } from '../App';

type StartedWorkoutNavigationProp = StackNavigationProp<
  WorkoutLogStackParamList,
  'StartedWorkoutInterface'
>;
import { useSettings } from '../context/SettingsContext';
import { useTheme } from '../context/ThemeContext';
import {
  clearActiveWorkoutSession,
  saveActiveWorkoutSession,
} from '../utils/activeWorkoutSession';
import { showCelebrationNotification } from '../utils/notificationUtils';
import { loadRestTimerPreferences, saveRestTimerPreferences } from '../utils/startedWorkoutPreferenceUtils';
import {
  createTimerState,
  mergeExerciseSetsWithSnapshot,
  orderMergedSetsLikeSnapshot,
  PersistedTimerPayload,
  timerCalculations,
  TimerState,
  timerStateUtils,
  updateTimerState,
  useTimerPersistence,
} from '../utils/timerPersistenceUtils';
import { formatWorkoutHeaderTitle, sortWorkoutPlanExercisesForDisplay } from '../utils/workoutDisplayUtils';

type StartedWorkoutRouteProps = RouteProp<
  WorkoutLogStackParamList,
  'StartedWorkoutInterface'
>;

// Define interfaces for workout data
interface Exercise {
  exercise_name: string;
  sets: number;
  reps: number;
  logged_exercise_id: number;
  exercise_fully_logged: boolean;
  web_link: string | null;
  muscle_group: string | null;
  exercise_notes: string | null;
  rest_seconds: number | null;
}

interface ExerciseSet {
  exercise_name: string;
  exercise_id: number;
  set_number: number;
  total_sets: number;
  reps_goal: number;
  reps_done: string;
  weight: string;
  set_logged: boolean;
  /** Set when user saves duration from cardio timer modal (shows Logged line even if minutes equal goal). */
  cardio_duration_saved_from_timer?: boolean;
  web_link: string | null;
  muscle_group: string | null;
  exercise_notes: string | null;
}

function sortLoggedExercisesForWorkout<
  T extends { exercise_name: string; muscle_group: string | null }
>(list: T[]): T[] {
  return sortWorkoutPlanExercisesForDisplay(list);
}

/** Rebuild flat set list to match a new exercise order (set order within each exercise unchanged). */
function reorderAllSetsByExerciseOrder(
  sets: ExerciseSet[],
  orderedExercises: Exercise[],
): ExerciseSet[] {
  const byExId = new Map<number, ExerciseSet[]>();
  for (const s of sets) {
    const list = byExId.get(s.exercise_id);
    if (list) list.push(s);
    else byExId.set(s.exercise_id, [s]);
  }
  for (const list of byExId.values()) {
    list.sort((a, b) => a.set_number - b.set_number);
  }
  const out: ExerciseSet[] = [];
  for (const ex of orderedExercises) {
    const chunk = byExId.get(ex.logged_exercise_id);
    if (chunk?.length) out.push(...chunk);
  }
  return out;
}

function mapExercisesWithLoggedFlag(
  ordered: Omit<Exercise, 'exercise_fully_logged'>[],
  sets: ExerciseSet[],
): Exercise[] {
  const byId = new Map<number, ExerciseSet[]>();
  for (const s of sets) {
    const L = byId.get(s.exercise_id);
    if (L) L.push(s);
    else byId.set(s.exercise_id, [s]);
  }
  return ordered.map((e) => {
    const chunk = byId.get(e.logged_exercise_id) ?? [];
    return {
      ...e,
      exercise_fully_logged: chunk.length > 0 && chunk.every((s) => s.set_logged),
    };
  });
}

/** Order exercise rows to match first-seen exercise_id sequence in `sets` (keeps list modal / flow aligned). */
function orderLoggedExercisesLikeSets(
  sets: ExerciseSet[],
  exercisesSource: Omit<Exercise, 'exercise_fully_logged'>[],
): Exercise[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const s of sets) {
    if (!seen.has(s.exercise_id)) {
      seen.add(s.exercise_id);
      ids.push(s.exercise_id);
    }
  }
  const byId = new Map(exercisesSource.map((e) => [e.logged_exercise_id, e] as const));
  const ordered: Omit<Exercise, 'exercise_fully_logged'>[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (e) ordered.push(e);
  }
  for (const e of exercisesSource) {
    if (!seen.has(e.logged_exercise_id)) ordered.push(e);
  }
  return mapExercisesWithLoggedFlag(ordered, sets);
}

/** Empty weight → 0 (bodyweight). Returns null if invalid. */
function parseWeightForLog(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (t === '') return 0;
  const n = parseFloat(t);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

function isValidRepsAndWeight(repsDone: string, weight: string): boolean {
  const reps = parseInt(repsDone.trim(), 10);
  if (repsDone.trim() === '' || Number.isNaN(reps) || reps < 0) return false;
  return parseWeightForLog(weight) !== null;
}

const CARDIO_NAME_PREFIX = 'Cardio:';

function isCardioExerciseName(name: string): boolean {
  return name.trimStart().startsWith(CARDIO_NAME_PREFIX);
}

/** Duration/timer UI for a set: whole cardio workout log, or legacy "Cardio:"-prefixed names in a strength log. */
function isCardioSetUI(exerciseName: string, logWorkoutType: 'strength' | 'cardio'): boolean {
  return logWorkoutType === 'cardio' || isCardioExerciseName(exerciseName);
}

/** Minutes stored in reps_goal / reps_done (Sage convention). */
function isValidCardioMinutes(mins: string): boolean {
  const n = parseFloat(mins.trim().replace(',', '.'));
  return !Number.isNaN(n) && n > 0;
}

function isValidCardioSet(repsDone: string, weight: string): boolean {
  if (!isValidCardioMinutes(repsDone)) return false;
  return parseWeightForLog(weight) !== null;
}

/** Show a value on the "Logged" line: set is saved, timer modal save, or reps differ from goal. Hides goal-only autofill. */
function shouldShowCardioLoggedMinutesDisplay(set: ExerciseSet): boolean {
  if (!isValidCardioMinutes(set.reps_done)) return false;
  if (set.set_logged) return true;
  if (set.cardio_duration_saved_from_timer) return true;
  const r = parseFloat(set.reps_done.trim().replace(',', '.'));
  const g = parseFloat(String(set.reps_goal).trim().replace(',', '.'));
  if (!Number.isFinite(r)) return false;
  if (!Number.isFinite(g)) return true;
  return Math.abs(r - g) > 1e-4;
}

function formatCardioCountdownMMSS(totalSec: number): string {
  const s = Math.max(0, totalSec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function formatElapsedMinutesForCardio(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '0';
  const rounded = Math.round(m * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

/** Display logged/planned minute strings as "X min" (not "reps"). */
function formatCardioMinutesLine(raw: string): string {
  const t = raw.trim().replace(',', '.');
  if (!t) return '';
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return `${raw.trim()} min`;
  const rounded = Math.round(n * 100) / 100;
  const s = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${s} min`;
}

export default function StartedWorkoutInterface() {
  const navigation = useNavigation<StartedWorkoutNavigationProp>();
  const route = useRoute<StartedWorkoutRouteProps>();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const { notificationPermissionGranted, weightFormat } = useSettings();
  
  const { workout_log_id, resume: isResumeParam } = route.params;
  const isResume = isResumeParam === true;
  
  // States for workout data
  const [loading, setLoading] = useState(true);
  const [workout, setWorkout] = useState<{
    workout_name: string;
    workout_date: number;
    day_name: string;
  } | null>(null);
  /** From Workout_Log.workout_type — drives simple timer vs exercise list for cardio. */
  const [workoutLogType, setWorkoutLogType] = useState<'strength' | 'cardio'>('strength');
  const workoutLogTypeRef = useRef<'strength' | 'cardio'>('strength');
  const [exercises, setExercises] = useState<Exercise[]>([]);
  
  // Workout flow states
  const [restTime, setRestTime] = useState('60');
  const [exerciseRestTime, setExerciseRestTime] = useState('60');
  const [isExerciseListModalVisible, setIsExerciseListModalVisible] = useState(false);
  const [autoFillWeight, setAutoFillWeight] = useState(true);
  const [autoFillReps, setAutoFillReps] = useState(true);
  const [useLogsForRepInput, setUseLogsForRepInput] = useState(false);
  const [enableSetSwitchSound, setEnableSetSwitchSound] = useState(false);
  
  // User preference toggles
  const [enableVibration, setEnableVibration] = useState(true);
  const [enableNotifications, setEnableNotifications] = useState(false);
  
  // Sets data for tracking workout
  const [allSets, setAllSets] = useState<ExerciseSet[]>([]);
  const allSetsRef = useRef<ExerciseSet[]>([]);
  useEffect(() => {
    allSetsRef.current = allSets;
  }, [allSets]);

  // State for notes modal
  const [isNotesModalVisible, setIsNotesModalVisible] = useState(false);
  const [notesModalContent, setNotesModalContent] = useState('');
  const [notesModalTitle, setNotesModalTitle] = useState('');

  const [cardioModalVisible, setCardioModalVisible] = useState(false);
  const [cardioCountdownSec, setCardioCountdownSec] = useState(0);
  const [cardioTimerRunning, setCardioTimerRunning] = useState(false);
  /** Optional typed minutes in the cardio modal (used if valid; otherwise elapsed timer). */
  const [cardioManualMinutes, setCardioManualMinutes] = useState('');
  /** True after user taps Start at least once this modal open; drives Start vs Resume label. */
  const [cardioCountdownSessionStarted, setCardioCountdownSessionStarted] =
    useState(false);
  const cardioInitialTotalSecRef = useRef(0);
  const cardioCountdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Timer state using the new utility
  const [timerState, setTimerState] = useState<TimerState>(createTimerState());
  const [isCompletingSet, setIsCompletingSet] = useState(false);

  const timerStateRef = useRef<TimerState>(timerState);
  useEffect(() => {
    timerStateRef.current = timerState;
  }, [timerState]);

  const persistWorkoutTimerBlob = useCallback(async () => {
    const ts = timerStateRef.current;
    if (!ts.workoutStarted || ts.workoutStage === 'completed') return;
    const setsSnapshot = allSetsRef.current.map((s) => ({
      exercise_name: s.exercise_name,
      set_number: s.set_number,
      weight: s.weight,
      reps_done: s.reps_done,
      set_logged: s.set_logged,
      ...(s.cardio_duration_saved_from_timer != null
        ? { cardio_duration_saved_from_timer: s.cardio_duration_saved_from_timer }
        : {}),
    }));
    try {
      const cardioPaused =
        workoutLogTypeRef.current === 'cardio' && isCardioTimerPausedRef.current;
      await timerStateUtils.saveTimerState(ts, {
        workoutLogId: workout_log_id,
        setsSnapshot: setsSnapshot.length > 0 ? setsSnapshot : undefined,
        ...(cardioPaused ? { cardioTimerPaused: true } : {}),
      });
    } catch (e) {
      console.error('Error persisting workout timer on blur/unmount:', e);
    }
  }, [workout_log_id]);

  useEffect(() => {
    const subBlur = navigation.addListener('blur', () => {
      void persistWorkoutTimerBlob();
    });
    return () => {
      void persistWorkoutTimerBlob();
      subBlur();
    };
  }, [navigation, persistWorkoutTimerBlob]);
  
  // Timer refs for intervals
  const workoutTimerRef = useRef<NodeJS.Timeout | null>(null);
  const restTimerRef = useRef<NodeJS.Timeout | null>(null);
  const restTimerEndAtRef = useRef<number | null>(null);
  const weightMapRef = useRef(new Map<string, string>());
  const repsMapRef = useRef(new Map<string, string>());
  // Rest seconds at moment user tapped Start Workout (so rest timer uses their chosen value)
  const restSecondsForWorkoutRef = useRef<{ setRestSeconds: number; exerciseRestSeconds: number } | null>(null);

  const [isCardioTimerPaused, setIsCardioTimerPaused] = useState(false);
  const isCardioTimerPausedRef = useRef(false);
  useEffect(() => {
    isCardioTimerPausedRef.current = isCardioTimerPaused;
  }, [isCardioTimerPaused]);

  const updateExerciseLoggedStatus = (exerciseId: number, currentSets: ExerciseSet[]) => {
    const exerciseSets = currentSets.filter(s => s.exercise_id === exerciseId);
    const allSetsLogged = exerciseSets.every(s => s.set_logged);

    setExercises(prevExercises =>
      prevExercises.map(ex =>
        ex.logged_exercise_id === exerciseId
          ? { ...ex, exercise_fully_logged: allSetsLogged }
          : ex
      )
    );
  };
  
  // Handle timer restoration from background
  const handleTimerRestore = (
    savedState: TimerState,
    elapsedSeconds: number,
    rawPayload?: PersistedTimerPayload,
  ) => {
    console.log('=== RESTORING TIMER STATE ===');
    console.log('Saved state:', savedState);
    console.log('Elapsed seconds:', elapsedSeconds);

    if (rawPayload?.cardioTimerPaused === true) {
      setIsCardioTimerPaused(true);

      setTimerState((prev) =>
        updateTimerState(prev, {
          workoutDuration: savedState.workoutDuration,
          exerciseSegmentDuration: savedState.exerciseSegmentDuration ?? 0,
          workoutStartTime: savedState.workoutStartTime,
          currentSetIndex: savedState.currentSetIndex,
          workoutStage: savedState.workoutStage,
          workoutStarted: savedState.workoutStarted,
          isResting: savedState.isResting,
          restRemaining: savedState.restRemaining,
          restStartTime: savedState.restStartTime,
          isExerciseRest: savedState.isExerciseRest,
        }),
      );
      stopWorkoutTimer();

      if (
        savedState.isResting &&
        savedState.restRemaining !== null &&
        savedState.restRemaining > 0
      ) {
        const newRestTime = Math.max(0, savedState.restRemaining - elapsedSeconds);
        if (newRestTime <= 0) {
          stopRestTimer();
          handleRestComplete(savedState.isExerciseRest);
        } else {
          setTimerState((prev) =>
            updateTimerState(prev, {
              restRemaining: newRestTime,
              isResting: true,
              isExerciseRest: savedState.isExerciseRest,
              restStartTime: Date.now(),
            }),
          );
          stopRestTimer();
          startRestTimer(newRestTime);
        }
      } else {
        stopRestTimer();
      }
      return;
    }

    // Restore workout timer (was running while app backgrounded)
    if (savedState.workoutStartTime) {
      const newDuration = savedState.workoutDuration + elapsedSeconds;
      const newStartTime = Date.now() - newDuration * 1000;

      setTimerState((prev) =>
        updateTimerState(prev, {
          workoutDuration: newDuration,
          exerciseSegmentDuration: savedState.exerciseSegmentDuration ?? 0,
          workoutStartTime: newStartTime,
          currentSetIndex: savedState.currentSetIndex,
          workoutStage: savedState.workoutStage,
          workoutStarted: savedState.workoutStarted,
        }),
      );

      stopWorkoutTimer();
      startWorkoutTimer();
      setIsCardioTimerPaused(false);
    }

    // Restore rest timer if needed
    if (
      !rawPayload?.cardioTimerPaused &&
      savedState.isResting &&
      savedState.restRemaining !== null &&
      savedState.restRemaining > 0
    ) {
      const newRestTime = Math.max(0, savedState.restRemaining - elapsedSeconds);
      
      if (newRestTime <= 0) {
        // Rest completed in background
        console.log('Rest completed during background');
        handleRestComplete(savedState.isExerciseRest);
      } else {
        // Continue rest timer
        setTimerState(prev => updateTimerState(prev, {
          restRemaining: newRestTime,
          isResting: true,
          isExerciseRest: savedState.isExerciseRest,
          restStartTime: Date.now()
        }));
        
        stopRestTimer();
        startRestTimer(newRestTime);
      }
    }
  };
  
  // Setup timer persistence
  useTimerPersistence(
    timerState,
    {
      onRestore: handleTimerRestore,
      onError: (error) => {
        console.error('Timer persistence error:', error);
        Alert.alert('Timer Error', 'There was an issue with timer persistence.');
      },
    },
    {
      enabled: timerState.workoutStarted,
      debugMode: __DEV__,
      workoutLogId: workout_log_id,
      getSetsSnapshot: () =>
        allSetsRef.current.map((s) => ({
          exercise_name: s.exercise_name,
          set_number: s.set_number,
          weight: s.weight,
          reps_done: s.reps_done,
          set_logged: s.set_logged,
          ...(s.cardio_duration_saved_from_timer != null
            ? { cardio_duration_saved_from_timer: s.cardio_duration_saved_from_timer }
            : {}),
        })),
      getCardioTimerPaused: () =>
        workoutLogTypeRef.current === 'cardio' && isCardioTimerPausedRef.current,
    },
  );
  
  // Handle AppState changes for notifications
  useEffect(() => {
    const handleAppStateChange = async (nextAppState: string) => {
      // Going to background - schedule notification if workout is active and notifications are enabled
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        // Stop active intervals when going to background
        // Let useTimerPersistence handle saving the actual current state
        stopWorkoutTimer();
        stopRestTimer();
        // clearRestTimerState(); // Clear timer state when going background // REMOVED

        if (timerState.workoutStarted && 
            timerState.workoutStage !== 'completed' && 
            enableNotifications && 
            notificationPermissionGranted) {
          
          console.log('App going to background - scheduling notification');
          
          try {
            // Clear any existing notifications first
            await Notifications.dismissAllNotificationsAsync();
            
            // Schedule workout progress notification
            await Notifications.scheduleNotificationAsync({
              content: {
                title: t("Workout in Progress"),
                body: t("Workout in Progress Message"),
                priority: 'min',
                data: { 
                  startTime: timerState.workoutStartTime,
                  type: 'workout_timer'
                },
              },
              trigger: null,
            });
            
          } catch (error) {
            console.error('Error scheduling notifications:', error);
          }
        }
      } 
      // Coming to foreground - clear notifications
      else if (nextAppState === 'active') {
        // clearRestTimerState(); // Clear timer state when coming to foreground // REMOVED
        if (enableNotifications) {
          console.log('App returning to foreground - clearing notifications');
          try {
            await Notifications.dismissAllNotificationsAsync();
          } catch (error) {
            console.error('Error clearing notifications:', error);
          }
        }
      }
    };
    
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      // clearRestTimerState(); // Clear on unmount // This was already correctly removed/commented
      subscription.remove();
    };
  }, [
    timerState.workoutStarted, 
    timerState.workoutStage, 
    enableNotifications, 
    notificationPermissionGranted,
    t,
    timerState.workoutStartTime
  ]);
  
  // Update enableNotifications only if permission is granted
  useEffect(() => {
    if (notificationPermissionGranted && !enableNotifications) {
      // Optional: enable notifications by default if permission is granted
      // setEnableNotifications(true);
    }
  }, [notificationPermissionGranted]);
  
  useEffect(() => {
    const loadInitialData = async () => {
        try {
            const preferences = await loadRestTimerPreferences();
            setRestTime(preferences.restTimeBetweenSets);
            setExerciseRestTime(preferences.restTimeBetweenExercises);
            setEnableVibration(preferences.enableVibration);
            setAutoFillWeight(preferences.autoFillWeight);
            setAutoFillReps(preferences.autoFillReps);
            setUseLogsForRepInput(preferences.useLogsForRepInput);
            setEnableSetSwitchSound(preferences.enableSetSwitchSound);
            if (notificationPermissionGranted) {
                setEnableNotifications(preferences.enableNotifications);
            } else {
                setEnableNotifications(false);
            }

            await fetchWorkoutDetails(
              preferences.autoFillWeight, 
              preferences.autoFillReps, 
              preferences.useLogsForRepInput
            );
        } catch (error) {
            console.error('Error loading initial data:', error);
            setLoading(false);
        }
    };

    loadInitialData();

    return () => {
        stopWorkoutTimer();
        stopRestTimer();
        deactivateKeepAwake();
    };
  }, [notificationPermissionGranted]);

  // Setup notification handler and keep awake
  useEffect(() => {
    const configureNotifications = async () => {
      await Notifications.setNotificationHandler({
        handleNotification: async (notification) => {
          // Handle different notification types
          const notificationType = notification.request.content.data?.type;
          
          return {
            shouldShowAlert: true,
            shouldPlaySound: notificationType === 'rest_complete',
            shouldSetBadge: false,
          };
        },
      });
    };
    
    if (timerState.workoutStarted) {
      activateKeepAwakeAsync();
      configureNotifications();
    }
    
    return () => {
      deactivateKeepAwake();
      // Clear notifications when component unmounts
      if (enableNotifications) {
        Notifications.dismissAllNotificationsAsync().catch(console.error);
      }
    };
  }, [timerState.workoutStarted, enableNotifications]);

  const showNotes = (notes: string, exerciseName: string) => {
    setNotesModalContent(notes);
    setNotesModalTitle(exerciseName);
    setIsNotesModalVisible(true);
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
  
  /**
   * Workout_Log rows are created when scheduling/logging (not in this screen):
   * - LogWorkout: INSERT with workout_type from Workouts
   * - WorkoutDetails (add to calendar): same
   * - recurringWorkoutUtils.scheduleWorkout: INSERT with workout_type from Workouts
   */
  const fetchWorkoutDetails = async (
    shouldAutoFill: boolean, 
    shouldAutoFillReps: boolean, 
    shouldUseLogsForReps: boolean
  ) => {
    let persistedPayload: Awaited<ReturnType<typeof timerStateUtils.loadTimerState>> = null;
    try {
      setLoading(true);
      setWorkoutLogType('strength');
      workoutLogTypeRef.current = 'strength';

      await db
        .runAsync("ALTER TABLE Workout_Log ADD COLUMN workout_type TEXT NOT NULL DEFAULT 'strength';")
        .catch(() => {});

      const workoutResult = await db.getAllAsync<{
        workout_name: string;
        workout_date: number;
        day_name: string;
        workout_type?: string | null;
      }>(
        `SELECT workout_name, workout_date, day_name, workout_type
         FROM Workout_Log 
         WHERE workout_log_id = ?;`,
        [workout_log_id]
      );
      
      if (workoutResult.length > 0) {
        const wo = { ...workoutResult[0] };
        let normalizedLogType: 'strength' | 'cardio' =
          (wo.workout_type || 'strength').toLowerCase() === 'cardio' ? 'cardio' : 'strength';

        // Canonical type lives on Workouts (Days has no workout_type). Fix logs created before recurring passed workout_type.
        const planWtRows = await db.getAllAsync<{ workout_type: string | null }>(
          'SELECT workout_type FROM Workouts WHERE workout_name = ? ORDER BY workout_id DESC LIMIT 1;',
          [wo.workout_name],
        );
        const planWorkoutType =
          (planWtRows[0]?.workout_type || 'strength').toLowerCase() === 'cardio'
            ? 'cardio'
            : 'strength';
        if (planWorkoutType === 'cardio' && normalizedLogType !== 'cardio') {
          await db.runAsync(
            'UPDATE Workout_Log SET workout_type = ? WHERE workout_log_id = ?;',
            ['cardio', workout_log_id],
          );
          wo.workout_type = 'cardio';
          normalizedLogType = 'cardio';
        }

        setWorkout(wo);
        setWorkoutLogType(normalizedLogType);
        workoutLogTypeRef.current = normalizedLogType;

        let exercisesResultRaw = await db.getAllAsync<Omit<Exercise, 'exercise_fully_logged'>>(
          `SELECT exercise_name, sets, reps, logged_exercise_id, web_link, muscle_group, exercise_notes, rest_seconds
           FROM Logged_Exercises 
           WHERE workout_log_id = ?
           ORDER BY logged_exercise_id ASC;`,
          [workout_log_id]
        );

        if (exercisesResultRaw.length === 0 && normalizedLogType === 'cardio') {
          const planRows = await db.getAllAsync<{
            exercise_name: string;
            sets: number;
            reps: number;
            web_link: string | null;
            muscle_group: string | null;
            exercise_notes: string | null;
            rest_seconds: number | null;
          }>(
            `SELECT e.exercise_name, e.sets, e.reps, e.web_link, e.muscle_group, e.exercise_notes, e.rest_seconds
             FROM Exercises e
             INNER JOIN Days d ON e.day_id = d.day_id
             INNER JOIN Workouts w ON d.workout_id = w.workout_id
             WHERE w.workout_name = ? AND d.day_name = ?;`,
            [wo.workout_name, wo.day_name]
          );
          const sortedPlan = sortWorkoutPlanExercisesForDisplay(planRows);
          if (sortedPlan.length > 0) {
            await db.withTransactionAsync(async () => {
              for (const ex of sortedPlan) {
                await db.runAsync(
                  `INSERT INTO Logged_Exercises (workout_log_id, exercise_name, sets, reps, web_link, muscle_group, exercise_notes, rest_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
                  [
                    workout_log_id,
                    ex.exercise_name,
                    ex.sets,
                    ex.reps,
                    ex.web_link ?? null,
                    ex.muscle_group ?? null,
                    ex.exercise_notes ?? null,
                    ex.rest_seconds ?? null,
                  ]
                );
              }
            });
            exercisesResultRaw = await db.getAllAsync<Omit<Exercise, 'exercise_fully_logged'>>(
              `SELECT exercise_name, sets, reps, logged_exercise_id, web_link, muscle_group, exercise_notes, rest_seconds
               FROM Logged_Exercises 
               WHERE workout_log_id = ?
               ORDER BY logged_exercise_id ASC;`,
              [workout_log_id]
            );
          }
        }

        const exercisesResult = sortLoggedExercisesForWorkout(exercisesResultRaw);

        // Sync rest time from workout plan: use first exercise's rest_seconds if set (so edits in plan are reflected)
        const firstRest = exercisesResult[0]?.rest_seconds;
        if (firstRest != null && firstRest > 0) {
          setRestTime(String(firstRest));
        }
        
        weightMapRef.current.clear();
        repsMapRef.current.clear();

        if (exercisesResult.length > 0) {
            const exerciseNames = exercisesResult.map(e => e.exercise_name);
            const placeholders = exerciseNames.map(() => '?').join(',');
        
            const lastLogResult = await db.getAllAsync<{ exercise_name: string; set_number: number; weight_logged: number; reps_logged: number }>(
                `SELECT wl.exercise_name, wl.set_number, wl.weight_logged, wl.reps_logged
                 FROM Weight_Log wl
                 INNER JOIN (
                   SELECT exercise_name, set_number, MAX(workout_log_id) as max_log_id
                   FROM Weight_Log
                   WHERE exercise_name IN (${placeholders})
                   GROUP BY exercise_name, set_number
                 ) as latest_logs
                 ON wl.exercise_name = latest_logs.exercise_name 
                 AND wl.set_number = latest_logs.set_number 
                 AND wl.workout_log_id = latest_logs.max_log_id;`,
                exerciseNames
              );
        
              lastLogResult.forEach(row => {
                weightMapRef.current.set(`${row.exercise_name}-${row.set_number}`, row.weight_logged.toString());
                repsMapRef.current.set(`${row.exercise_name}-${row.set_number}`, row.reps_logged.toString());
              });
        }
        
        // Prepare all sets data structure
        const setsData: ExerciseSet[] = [];
        exercisesResult.forEach(exercise => {
          for (let i = 1; i <= exercise.sets; i++) {
            const weight = shouldAutoFill ? (weightMapRef.current.get(`${exercise.exercise_name}-${i}`) || '') : '';
            
            let reps_done = '';
            if (shouldAutoFillReps) {
                if (shouldUseLogsForReps) {
                    reps_done = repsMapRef.current.get(`${exercise.exercise_name}-${i}`) || '';
                } else {
                    reps_done = exercise.reps.toString();
                }
            }

            setsData.push({
              exercise_name: exercise.exercise_name,
              exercise_id: exercise.logged_exercise_id,
              set_number: i,
              total_sets: exercise.sets,
              reps_goal: exercise.reps,
              reps_done: reps_done,
              weight: weight,
              set_logged: false,
              web_link: exercise.web_link || null,
              muscle_group: exercise.muscle_group || null,
              exercise_notes: exercise.exercise_notes || null
            });
          }
        });

        let finalSets = setsData;
        if (isResume) {
          persistedPayload = await timerStateUtils.loadTimerState();
          if (
            persistedPayload?.workoutLogId === workout_log_id &&
            persistedPayload.setsSnapshot &&
            persistedPayload.setsSnapshot.length > 0
          ) {
            const merged = mergeExerciseSetsWithSnapshot(
              setsData,
              persistedPayload.setsSnapshot,
            );
            finalSets = orderMergedSetsLikeSnapshot(merged, persistedPayload.setsSnapshot);
          }
        }

        setExercises(orderLoggedExercisesLikeSets(finalSets, exercisesResult));
        setAllSets(finalSets);
        allSetsRef.current = finalSets;

        if (!isResume && finalSets.length === 0) {
          setIsCardioTimerPaused(false);
          setTimerState((prev) =>
            updateTimerState(prev, {
              workoutStage: 'exercise',
              workoutStarted: false,
              workoutDuration: 0,
              exerciseSegmentDuration: 0,
              workoutStartTime: null,
              restStartTime: null,
              isResting: false,
              restRemaining: null,
              isExerciseRest: false,
              currentSetIndex: 0,
            }),
          );
        }
      }

      setLoading(false);

      if (isResume && workoutResult.length > 0) {
        saveActiveWorkoutSession(workout_log_id).catch(() => {});
        const prefs = await loadRestTimerPreferences();
        const setRs = parseInt(prefs.restTimeBetweenSets, 10);
        const exRs = parseInt(prefs.restTimeBetweenExercises, 10);
        restSecondsForWorkoutRef.current = {
          setRestSeconds: !Number.isNaN(setRs) && setRs >= 0 ? setRs : 60,
          exerciseRestSeconds: !Number.isNaN(exRs) && exRs >= 0 ? exRs : 60,
        };

        const resumedFinalSets =
          allSetsRef.current.length > 0 ? allSetsRef.current : [];

        const clampResumeSetIndex = (sets: ExerciseSet[], persistedIndex: number): number => {
          if (sets.length === 0) return 0;
          let idx = Math.max(0, Math.min(persistedIndex, sets.length - 1));
          if (sets[idx]?.set_logged) {
            const next = sets.findIndex((s) => !s.set_logged);
            idx = next >= 0 ? next : Math.max(0, sets.length - 1);
          }
          return idx;
        };

        let persisted = persistedPayload;
        if (!persisted) {
          persisted = await timerStateUtils.loadTimerState();
        }

        const canRestoreTimer =
          persisted &&
          persisted.workoutLogId === workout_log_id &&
          timerStateUtils.isValidTimerState(persisted) &&
          persisted.workoutStarted &&
          persisted.workoutStage !== 'completed' &&
          persisted.workoutStage !== 'overview';

        queueMicrotask(() => {
          if (canRestoreTimer && persisted) {
            const elapsed = timerStateUtils.calculateElapsedTime(persisted.timestamp);
            const baseTimer = timerStateUtils.toTimerState(persisted);
            const fixedIndex = clampResumeSetIndex(resumedFinalSets, baseTimer.currentSetIndex);
            handleTimerRestore(
              { ...baseTimer, currentSetIndex: fixedIndex },
              elapsed,
              persisted,
            );
          } else {
            const firstUnlogged = resumedFinalSets.findIndex((s) => !s.set_logged);
            const idx = firstUnlogged >= 0 ? firstUnlogged : 0;
            setTimerState((prev) =>
              updateTimerState(prev, {
                workoutStarted: true,
                workoutStage: 'exercise',
                currentSetIndex: idx,
                workoutStartTime: Date.now(),
                workoutDuration: 0,
                exerciseSegmentDuration: 0,
                isResting: false,
                restRemaining: null,
                isExerciseRest: false,
              }),
            );
            stopWorkoutTimer();
            setIsCardioTimerPaused(false);
            workoutTimerRef.current = setInterval(() => {
              setTimerState((prev) =>
                updateTimerState(prev, {
                  workoutDuration: prev.workoutDuration + 1,
                }),
              );
            }, 1000);
          }
        });

        await timerStateUtils.clearTimerState();
        return;
      }
    } catch (error) {
      console.error('Error fetching workout details:', error);
      setLoading(false);
    }
  };
  
  // Timer functions
  const startWorkoutTimer = () => {
    setTimerState((prev) => {
      const startTime = Date.now() - prev.workoutDuration * 1000;
      return updateTimerState(prev, { workoutStartTime: startTime });
    });

    workoutTimerRef.current = setInterval(() => {
      setTimerState((prev) =>
        updateTimerState(prev, {
          workoutDuration: prev.workoutDuration + 1,
        }),
      );
    }, 1000);
  };
  
  const stopWorkoutTimer = () => {
    if (workoutTimerRef.current) {
      clearInterval(workoutTimerRef.current);
      workoutTimerRef.current = null;
    }
  };

  const handleCardioTimerPause = () => {
    stopWorkoutTimer();
    setIsCardioTimerPaused(true);
  };

  const handleCardioTimerResume = () => {
    setIsCardioTimerPaused(false);
    startWorkoutTimer();
  };

  const startRestTimer = (seconds: number) => {
    const endAt = Date.now() + seconds * 1000;
    restTimerEndAtRef.current = endAt;

    setTimerState(prev => updateTimerState(prev, {
      restRemaining: seconds,
      restStartTime: Date.now(),
      isResting: true
    }));

    stopRestTimer();
    restTimerRef.current = setInterval(() => {
      setTimerState((prev) => {
        if (!prev.isResting) return prev;
        const end = restTimerEndAtRef.current;
        if (end == null) {
          stopRestTimer();
          return prev;
        }
        const wallRemaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
        if (wallRemaining <= 0) {
          stopRestTimer();
          restTimerEndAtRef.current = null;
          const wasExerciseRest = prev.isExerciseRest;
          setTimeout(() => handleRestComplete(wasExerciseRest), 0);
          return updateTimerState(prev, {
            restRemaining: null,
            isResting: false,
            isExerciseRest: false,
          });
        }
        const prevRem = prev.restRemaining ?? 0;
        const stepped = Math.max(0, prevRem - 1);
        let nextRem = Math.min(stepped, wallRemaining);
        if (nextRem === 0 && wallRemaining > 0) nextRem = wallRemaining;
        return updateTimerState(prev, { restRemaining: nextRem });
      });
    }, 1000);
  };
  
  const stopRestTimer = () => {
    if (restTimerRef.current) {
      clearInterval(restTimerRef.current);
      restTimerRef.current = null;
    }
  };
  
  const handleRestComplete = (wasExerciseRest: boolean) => {
  
    clearRestTimerState(); // Clear rest timer state before new set
    setTimerState(prev => updateTimerState(prev, {
      workoutStage: 'exercise'
    }));
    
    if (enableVibration) {
      Vibration.vibrate([500, 300, 500]);
    }
    if (enableSetSwitchSound) {
      playSound();
    }
  };
  
  const handleAutoFillToggle = (newValue: boolean) => {
    setAutoFillWeight(newValue);
    setAllSets(currentSets => 
      currentSets.map(set => {
        if (set.set_logged) {
          return set;
        }

        const newWeight = newValue ? (weightMapRef.current.get(`${set.exercise_name}-${set.set_number}`) || '') : '';

        return {
          ...set,
          weight: newWeight,
        };
      })
    );
  };

  const handleAutoFillRepsToggle = (newValue: boolean) => {
    setAutoFillReps(newValue);
    setAllSets(currentSets =>
      currentSets.map(set => {
        if (set.set_logged) {
          return set;
        }

        let newReps = '';
        if (newValue) {
          if (useLogsForRepInput) {
            newReps = repsMapRef.current.get(`${set.exercise_name}-${set.set_number}`) || '';
          } else {
            newReps = set.reps_goal.toString();
          }
        }

        return {
          ...set,
          reps_done: newReps,
          cardio_duration_saved_from_timer: false,
        };
      })
    );
  };

  const handleUseLogsForRepsToggle = (newValue: boolean) => {
    setUseLogsForRepInput(newValue);
    if (autoFillReps) {
      setAllSets(currentSets =>
        currentSets.map(set => {
          if (set.set_logged) {
            return set;
          }

          let newReps = '';
          if (newValue) {
            newReps = repsMapRef.current.get(`${set.exercise_name}-${set.set_number}`) || '';
          } else {
            newReps = set.reps_goal.toString();
          }

          return {
            ...set,
            reps_done: newReps,
            cardio_duration_saved_from_timer: false,
          };
        })
      );
    }
  };

  // Workout flow functions
  const startWorkout = async () => {
    const setRestSeconds = parseInt(restTime);
    const exerciseRestSeconds = parseInt(exerciseRestTime);
    
    if (isNaN(setRestSeconds) || setRestSeconds < 0) {
      Alert.alert(t('invalidRestTime'), t('pleaseEnterValidSeconds'));
      return;
    }
    
    if (isNaN(exerciseRestSeconds) || exerciseRestSeconds < 0) {
      Alert.alert(t('invalidExerciseRestTime'), t('pleaseEnterValidSeconds'));
      return;
    }

    try {
      await saveRestTimerPreferences({
        restTimeBetweenSets: restTime,
        restTimeBetweenExercises: exerciseRestTime,
        enableVibration: enableVibration,
        enableNotifications: enableNotifications,
        autoFillWeight: autoFillWeight,
        enableSetSwitchSound: enableSetSwitchSound,
        autoFillReps: autoFillReps,
        useLogsForRepInput: useLogsForRepInput,
      });
    } catch (error) {
      console.error('Error saving rest timer preferences:', error);
    }

    restSecondsForWorkoutRef.current = { setRestSeconds, exerciseRestSeconds };

    saveActiveWorkoutSession(workout_log_id).catch(() => {});

    setIsCardioTimerPaused(false);

    setTimerState(prev => updateTimerState(prev, {
      workoutStarted: true,
      workoutStage: 'exercise',
    }));
    
    startWorkoutTimer();
  };
  
  const handleNotificationToggle = async () => {
    if (!enableNotifications) {
      if (!notificationPermissionGranted) {
        Alert.alert(
          t('Permission Required'),
          t('Notification permission is required. Please enable notifications in the Settings page.'),
          [
            { text: t('Cancel'), style: 'cancel' },
            { 
              text: t('Go to Settings'), 
              onPress: () => navigation.navigate('Settings' as never),
              style: 'default' 
            },
          ]
        );
        return;
      }
      setEnableNotifications(true);
    } else {
      setEnableNotifications(false);
      // Clear any existing notifications when disabling
      try {
        await Notifications.dismissAllNotificationsAsync();
      } catch (error) {
        console.error('Error clearing notifications:', error);
      }
    }
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

  useEffect(() => {
    const configureAudio = async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
          interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
          playThroughEarpieceAndroid: false,
        });
      } catch (error) {
        console.error('Error configuring audio mode: ', error);
      }
    };
    configureAudio();
  }, []);

  async function playSound() {
    try {
      const { sound } = await Audio.Sound.createAsync(
        require('../assets/sounds/switch.mp3'),
      );
      sound.setOnPlaybackStatusUpdate(async (status) => {
        if (status.isLoaded && status.didJustFinish) {
          await sound.unloadAsync();
        }
      });
      await sound.playAsync();
    } catch (error) {
      console.log('Error playing sound', error);
    }
  }

  const stopCardioCountdown = useCallback(() => {
    if (cardioCountdownIntervalRef.current) {
      clearInterval(cardioCountdownIntervalRef.current);
      cardioCountdownIntervalRef.current = null;
    }
  }, []);

  const resetCardioModalTimerState = useCallback(() => {
    stopCardioCountdown();
    setCardioTimerRunning(false);
    setCardioCountdownSessionStarted(false);
    setCardioCountdownSec(0);
    cardioInitialTotalSecRef.current = 0;
  }, [stopCardioCountdown]);

  const triggerCardioIntervalComplete = useCallback(() => {
    if (enableVibration) {
      Vibration.vibrate([0, 400, 200, 400]);
    }
    void playSound();
    Alert.alert(
      t('cardioIntervalFinishedTitle') || 'Interval finished',
      t('cardioIntervalFinishedMessage') ||
        'Tap Log Set to save this interval.',
    );
  }, [enableVibration, t]);

  const proceedAfterSetLogged = useCallback(
    (updatedSets: ExerciseSet[], currentSetIndex: number) => {
      const findNextUnloggedSet = (startIndex: number) => {
        for (let i = startIndex; i < updatedSets.length; i++) {
          if (!updatedSets[i].set_logged) {
            return i;
          }
        }
        return -1;
      };

      const nextSetIndex = findNextUnloggedSet(currentSetIndex + 1);

      if (nextSetIndex !== -1) {
        const differentExercise =
          updatedSets[currentSetIndex].exercise_name !==
          updatedSets[nextSetIndex].exercise_name;
        const completedSet = updatedSets[currentSetIndex];
        const completedExercise = exercises.find(
          (ex) => ex.logged_exercise_id === completedSet?.exercise_id,
        );
        const planRestSeconds = completedExercise?.rest_seconds ?? null;
        const stored = restSecondsForWorkoutRef.current;
        const fallbackRest = differentExercise
          ? stored?.exerciseRestSeconds ?? parseInt(exerciseRestTime, 10)
          : stored?.setRestSeconds ?? parseInt(restTime, 10);
        const restSeconds =
          planRestSeconds != null && planRestSeconds > 0 ? planRestSeconds : fallbackRest;

        setTimerState((prev) =>
          updateTimerState(prev, {
            workoutStage: 'rest',
            isExerciseRest: differentExercise,
            currentSetIndex: nextSetIndex,
          }),
        );

        setIsCompletingSet(false);
        startRestTimer(restSeconds);
      } else {
        const anyUnlogged = updatedSets.some((s) => !s.set_logged);
        if (anyUnlogged) {
          Alert.alert(
            'Unsaved Sets',
            "You have sets that haven't been logged. Are you sure you want to skip this exercise?",
            [
            {
              text: t('Yes'),
              style: 'destructive',
              onPress: () => {
                setTimerState((prev) =>
                  updateTimerState(prev, { workoutStage: 'completed' }),
                );
                stopWorkoutTimer();
              },
            },
            {
              text: t('No'),
              style: 'cancel',
              onPress: () => {
                const firstUnloggedIndex = findNextUnloggedSet(0);
                if (firstUnloggedIndex !== -1) {
                  setTimerState((prev) =>
                    updateTimerState(prev, {
                      workoutStage: 'exercise',
                      currentSetIndex: firstUnloggedIndex,
                    }),
                  );
                }
                setIsCompletingSet(false);
              },
            },
          ], { onDismiss: () => setIsCompletingSet(false) });
        } else {
          setTimerState((prev) =>
            updateTimerState(prev, { workoutStage: 'completed' }),
          );
          stopWorkoutTimer();
        }
      }
    },
    [exercises, exerciseRestTime, restTime, t, startRestTimer, stopWorkoutTimer],
  );

  const openCardioModal = useCallback(() => {
    const idx = timerStateRef.current.currentSetIndex;
    const cs = allSetsRef.current[idx];
    if (!cs || !isCardioSetUI(cs.exercise_name, workoutLogType)) return;
    stopCardioCountdown();
    const plannedMin = Math.max(1 / 60, Number(cs.reps_goal) || 0);
    const totalSec = Math.max(1, Math.round(plannedMin * 60));
    cardioInitialTotalSecRef.current = totalSec;
    setCardioCountdownSec(totalSec);
    setCardioTimerRunning(false);
    setCardioCountdownSessionStarted(false);
    setCardioManualMinutes(
      isValidCardioMinutes(cs.reps_done)
        ? cs.reps_done.trim().replace(',', '.')
        : '',
    );
    setCardioModalVisible(true);
  }, [stopCardioCountdown, workoutLogType]);

  const handleCardioStartPauseResume = useCallback(() => {
    if (cardioCountdownSec <= 0) return;
    if (cardioTimerRunning) {
      stopCardioCountdown();
      setCardioTimerRunning(false);
      return;
    }
    stopCardioCountdown();
    setCardioCountdownSessionStarted(true);
    setCardioTimerRunning(true);
    cardioCountdownIntervalRef.current = setInterval(() => {
      setCardioCountdownSec((prev) => {
        if (prev <= 0) {
          return 0;
        }
        const next = prev - 1;
        const initial = cardioInitialTotalSecRef.current;
        if (next === 0) {
          stopCardioCountdown();
          setCardioTimerRunning(false);
          triggerCardioIntervalComplete();
        }
        return next;
      });
    }, 1000);
  }, [
    cardioCountdownSec,
    cardioTimerRunning,
    stopCardioCountdown,
    triggerCardioIntervalComplete,
  ]);

  const closeCardioModal = useCallback(() => {
    resetCardioModalTimerState();
    setCardioModalVisible(false);
  }, [resetCardioModalTimerState]);

  const handleCardioLogSetFromModal = useCallback(() => {
    const manualRaw = cardioManualMinutes.trim().replace(',', '.');
    let minsStr: string;
    if (isValidCardioMinutes(manualRaw)) {
      minsStr = manualRaw;
    } else {
      const initial = cardioInitialTotalSecRef.current;
      const elapsedSec = Math.max(0, initial - cardioCountdownSec);
      const elapsedMin = elapsedSec / 60;
      minsStr = formatElapsedMinutesForCardio(elapsedMin);
    }
    if (!isValidCardioMinutes(minsStr)) {
      Alert.alert(
        t('missingInformation'),
        t('cardioLogSetNeedTimer') ||
          'Enter minutes above or start the timer and let it run before saving.',
      );
      return;
    }
    const idx = timerStateRef.current.currentSetIndex;
    resetCardioModalTimerState();
    setCardioModalVisible(false);
    setAllSets((prev) => {
      if (idx < 0 || idx >= prev.length) return prev;
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        reps_done: minsStr.trim().replace(',', '.'),
        weight: '0',
        set_logged: false,
        cardio_duration_saved_from_timer: true,
      };
      return next;
    });
  }, [cardioCountdownSec, cardioManualMinutes, t, resetCardioModalTimerState]);

  useEffect(() => {
    return () => {
      stopCardioCountdown();
    };
  }, [stopCardioCountdown]);
  
  // Rest of the render functions remain the same...
  const renderOverview = () => {
    return (
      <View style={styles.overviewContainer}>
        <TouchableOpacity
          style={[styles.startButton, styles.startButtonTop, { backgroundColor: theme.buttonBackground }]}
          onPress={startWorkout}
        >
          <Ionicons name="stopwatch-outline" size={20} color={theme.buttonText} style={styles.buttonIcon} />
          <Text style={[styles.buttonText, { color: theme.buttonText }]}>{t('startWorkout')}</Text>
        </TouchableOpacity>
        <View style={[styles.workoutHeaderCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {workout && workout.workout_name.trim() === workout.day_name.trim() ? (
            <Text style={[styles.workoutName, { color: theme.text }]}>{workout.workout_name}</Text>
          ) : (
            <>
              <Text style={[styles.workoutName, { color: theme.text }]}>{workout?.workout_name}</Text>
              <Text style={[styles.workoutDay, { color: theme.text }]}>{workout?.day_name}</Text>
            </>
          )}
          <View style={styles.workoutStats}>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: theme.text }]}>{exercises.length}</Text>
              <Text style={[styles.statLabel, { color: theme.text }]}>{t('exercises')}</Text>
            </View>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: theme.text }]}>
                {allSets.length}
              </Text>
              <Text style={[styles.statLabel, { color: theme.text }]}>{t('totalSets')}</Text>
            </View>
          </View>
        </View>

        <View
          style={[
            styles.timerDisplay,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
              alignSelf: 'stretch',
              marginTop: 8,
            },
          ]}
        >
          <Text style={[styles.timerLabel, { color: theme.text }]}>{t('workoutTime')}</Text>
          <Text style={[styles.workoutTimerText, { color: theme.text }]}>
            {timerCalculations.formatTime(timerState.workoutDuration)}
          </Text>
          <Text style={[styles.exerciseDetails, { color: theme.textSecondary, marginTop: 6, textAlign: 'center' }]}>
            {t('workoutTimeOverviewHint')}
          </Text>
        </View>
        
        {exercises.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>{t('exercises')}</Text>
            <FlatList
              data={exercises}
              keyExtractor={(item) => item.logged_exercise_id.toString()}
              renderItem={({ item }) => {
                const muscleGroupInfo = muscleGroupData.find(mg => mg.value === item.muscle_group);
                let overviewSwipeRef: Swipeable | null = null;
                return (
                  <Swipeable
                    ref={(r) => {
                      overviewSwipeRef = r;
                    }}
                    friction={1}
                    overshootLeft={false}
                    overshootRight={false}
                    containerStyle={styles.swipeableContainer}
                    renderRightActions={() => (
                      <View style={styles.swipeDeleteActionHost}>
                        <RectButton
                          style={styles.swipeDeleteAction}
                          onPress={() => {
                            overviewSwipeRef?.close();
                            void removeLoggedExerciseFromSession(item.logged_exercise_id);
                          }}
                        >
                          <Ionicons name="trash-outline" size={20} color="#fff" />
                          <Text style={styles.swipeDeleteActionText}>{t('Delete')}</Text>
                        </RectButton>
                      </View>
                    )}
                  >
                    <View style={[styles.exerciseItem, { backgroundColor: theme.card, borderColor: theme.border }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1,}}>
                          <Text style={[styles.exerciseName, { color: theme.text, marginRight: 8 }]}>{item.exercise_name}</Text>
                          {muscleGroupInfo && muscleGroupInfo.value && (
                            <View style={[styles.muscleGroupBadgeOverview, { backgroundColor: theme.card, borderColor: theme.border }]}>
                              <Text style={[styles.muscleGroupBadgeText, { color: theme.text }]}>
                                {t(muscleGroupInfo.label)}
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                          {item.exercise_notes && (
                            <TouchableOpacity onPress={() => showNotes(item.exercise_notes!, item.exercise_name)} style={{ marginLeft: 10 }}>
                              <Ionicons name="bookmark-outline" size={22} color={theme.text} />
                            </TouchableOpacity>
                          )}
                          {item.web_link && (
                            <TouchableOpacity onPress={() => handleLinkPress(item.web_link)} style={{ marginLeft: 10 }}>
                              <Ionicons name="link-outline" size={22} color={theme.text} />
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                      <Text style={[styles.exerciseDetails, { color: theme.text, marginTop: 4 }]}>
                        {isCardioSetUI(item.exercise_name, workoutLogType)
                          ? `${t('durationMinutes') || 'Duration (minutes)'}: ${item.reps}`
                          : `${item.sets} ${t('Sets')} × ${item.reps} ${t('Reps')}`}
                      </Text>
                    </View>
                  </Swipeable>
                );
              }}
              scrollEnabled={false}
              style={styles.exercisesList}
            />
          </>
        )}
        
        <View style={styles.setupSection}>
          {exercises.length > 0 && (
            <>
              <Text style={[styles.setupLabel, { color: theme.text }]}>{t('restTimeBetweenSets')}:</Text>
              <TextInput
                style={[styles.restTimeInput, { 
                  backgroundColor: theme.card,
                  color: theme.text,
                  borderColor: theme.border
                }]}
                value={restTime}
                onChangeText={setRestTime}
                keyboardType="number-pad"
                maxLength={4}
                placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'}
              />
              
              <Text style={[styles.setupLabel, { color: theme.text }]}>{t('restTimeBetweenExercises')}:</Text>
              <TextInput
                style={[styles.restTimeInput, { 
                  backgroundColor: theme.card,
                  color: theme.text,
                  borderColor: theme.border
                }]}
                value={exerciseRestTime}
                onChangeText={setExerciseRestTime}
                keyboardType="number-pad"
                maxLength={4}
                placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'}
              />
            </>
          )}
          
          <Text style={[styles.setupLabel, { color: theme.text, marginTop: exercises.length > 0 ? 15 : 0 }]}>{t('workoutSettings')}:</Text>
          
          <View style={[styles.toggleRow, { 
            backgroundColor: theme.type === 'dark' ? '#121212' : '#f0f0f0',
            borderColor: theme.type === 'dark' ? '#000000' : '#e0e0e0'
          }]}>
            <Text style={[styles.toggleText, { color: theme.text }]}>{t('autoFillWeights')}</Text>
            <Switch
              value={autoFillWeight}
              onValueChange={handleAutoFillToggle}
              trackColor={{ false: theme.type === 'dark' ? '#444' : '#ccc', true: theme.buttonBackground }}
              thumbColor={autoFillWeight ? (theme.type === 'dark' ? '#fff' : '#fff') : (theme.type === 'dark' ? '#888' : '#f4f3f4')}
            />
          </View>

          <View style={[styles.toggleRow, {
            backgroundColor: theme.type === 'dark' ? '#121212' : '#f0f0f0',
            borderColor: theme.type === 'dark' ? '#000000' : '#e0e0e0'
          }]}>
            <Text style={[styles.toggleText, { color: theme.text }]}>{t('autoFillReps')}</Text>
            <Switch
              value={autoFillReps}
              onValueChange={handleAutoFillRepsToggle}
              trackColor={{ false: theme.type === 'dark' ? '#444' : '#ccc', true: theme.buttonBackground }}
              thumbColor={autoFillReps ? (theme.type === 'dark' ? '#fff' : '#fff') : (theme.type === 'dark' ? '#888' : '#f4f3f4')}
            />
          </View>
          
          {autoFillReps && (
            <View style={[styles.toggleRow, {
              backgroundColor: theme.type === 'dark' ? '#121212' : '#f0f0f0',
              borderColor: theme.type === 'dark' ? '#000000' : '#e0e0e0'
            }]}>
              <Text style={[styles.toggleText, { color: theme.text }]}>{t('useLogsForRepsTitle')}</Text>
              <Switch
                value={useLogsForRepInput}
                onValueChange={handleUseLogsForRepsToggle}
                trackColor={{ false: theme.type === 'dark' ? '#444' : '#ccc', true: theme.buttonBackground }}
                thumbColor={useLogsForRepInput ? (theme.type === 'dark' ? '#fff' : '#fff') : (theme.type === 'dark' ? '#888' : '#f4f3f4')}
              />
            </View>
          )}

          <View style={[styles.toggleRow, { 
            backgroundColor: theme.type === 'dark' ? '#121212' : '#f0f0f0',
            borderColor: theme.type === 'dark' ? '#000000' : '#e0e0e0'
          }]}>
            <Text style={[styles.toggleText, { color: theme.text }]}>{t('vibration')}</Text>
            <Switch
              value={enableVibration}
              onValueChange={setEnableVibration}
              trackColor={{ false: theme.type === 'dark' ? '#444' : '#ccc', true: theme.buttonBackground }}
              thumbColor={enableVibration ? (theme.type === 'dark' ? '#fff' : '#fff') : (theme.type === 'dark' ? '#888' : '#f4f3f4')}
            />
          </View>
          
          <View style={[styles.toggleRow, { 
            backgroundColor: theme.type === 'dark' ? '#121212' : '#f0f0f0',
            borderColor: theme.type === 'dark' ? '#000000' : '#e0e0e0'
          }]}>
            <Text style={[styles.toggleText, { color: theme.text }]}>{t('enableSetSwitchSound')}</Text>
            <Switch
              value={enableSetSwitchSound}
              onValueChange={setEnableSetSwitchSound}
              trackColor={{ false: theme.type === 'dark' ? '#444' : '#ccc', true: theme.buttonBackground }}
              thumbColor={enableSetSwitchSound ? (theme.type === 'dark' ? '#fff' : '#fff') : (theme.type === 'dark' ? '#888' : '#f4f3f4')}
            />
          </View>
          
          <View style={[styles.toggleRow, { 
            backgroundColor: theme.type === 'dark' ? '#121212' : '#f0f0f0',
            borderColor: theme.type === 'dark' ? '#000000' : '#e0e0e0'
          }]}>
            <Text style={[styles.toggleText, { color: theme.text }]}>{t('notifications')}</Text>
            <Switch
              value={enableNotifications}
              onValueChange={() => handleNotificationToggle()}
              trackColor={{ false: theme.type === 'dark' ? '#444' : '#ccc', true: theme.buttonBackground }}
              thumbColor={enableNotifications ? (theme.type === 'dark' ? '#fff' : '#fff') : (theme.type === 'dark' ? '#888' : '#f4f3f4')}
            />
          </View>
        </View>
      </View>
    );
  };
  
  // ... (rest of the render functions remain the same)
  
  const renderEmptyExercisesActiveWorkout = () => (
    <View style={styles.emptyActiveWorkoutContainer}>
      <Text style={[styles.emptyActiveWorkoutTimer, { color: theme.text }]}>
        {timerCalculations.formatTime(timerState.workoutDuration)}
      </Text>
      {!timerState.workoutStarted ? (
        <TouchableOpacity
          style={[styles.completeButton, { backgroundColor: theme.buttonBackground, marginTop: 24, alignSelf: 'stretch' }]}
          onPress={startWorkout}
        >
          <Text style={[styles.buttonText, { color: theme.buttonText }]}>{t('startWorkout')}</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.emptyActiveWorkoutButtonRow}>
          <TouchableOpacity
            style={[
              styles.emptyActiveWorkoutSecondaryButton,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
            onPress={isCardioTimerPaused ? handleCardioTimerResume : handleCardioTimerPause}
            activeOpacity={0.85}
          >
            <Text style={[styles.buttonText, { color: theme.text }]}>
              {isCardioTimerPaused ? t('resumeTimer') : t('pauseTimer')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.emptyActiveWorkoutPrimaryInRow,
              { backgroundColor: theme.buttonBackground },
            ]}
            onPress={handleFinishWorkout}
            activeOpacity={0.85}
          >
            <Text style={[styles.buttonText, { color: theme.buttonText }]}>{t('completeWorkout')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  const renderExerciseScreen = () => {
    if (allSets.length === 0) {
      return renderEmptyExercisesActiveWorkout();
    }

    const currentSet = allSets[timerState.currentSetIndex];
    if (!currentSet) return null;
    
    const muscleGroupInfo = muscleGroupData.find(mg => mg.value === currentSet.muscle_group);
    
    const isLastUnloggedSet = allSets.filter(s => !s.set_logged).length === 1;

    const loggedSetsCount = allSets.filter(s => s.set_logged).length;
    const progress = allSets.length > 0 ? (loggedSetsCount / allSets.length) * 100 : 0;
    
    const currentExerciseId = currentSet.exercise_id;
    const currentExerciseIndex = exercises.findIndex(ex => ex.logged_exercise_id === currentExerciseId);
    const isLastExercise = currentExerciseIndex === exercises.length - 1;
    const isLastSetOfExercise = currentSet.set_number === currentSet.total_sets;
    const isLastStructuralSet = isLastExercise && isLastSetOfExercise;
    const isCardio = isCardioSetUI(currentSet.exercise_name, workoutLogType);
    const currentIdx = timerState.currentSetIndex;
    let prevSameExerciseSetIndex = -1;
    let nextSameExerciseSetIndex = -1;
    if (currentSet.total_sets > 1) {
      for (let i = currentIdx - 1; i >= 0; i--) {
        if (allSets[i].exercise_id === currentSet.exercise_id) {
          prevSameExerciseSetIndex = i;
          break;
        }
      }
      for (let i = currentIdx + 1; i < allSets.length; i++) {
        if (allSets[i].exercise_id === currentSet.exercise_id) {
          nextSameExerciseSetIndex = i;
          break;
        }
      }
    }
    const canCompleteStrength =
      !!allSets[timerState.currentSetIndex] &&
      isValidRepsAndWeight(
        allSets[timerState.currentSetIndex].reps_done,
        allSets[timerState.currentSetIndex].weight,
      );
    const canCompleteCardio =
      !!allSets[timerState.currentSetIndex] &&
      isValidCardioSet(
        allSets[timerState.currentSetIndex].reps_done,
        allSets[timerState.currentSetIndex].weight || '0',
      );
    const canCompleteSet = isCardio ? canCompleteCardio : canCompleteStrength;
    const showCardioWholeWorkoutControls =
      workoutLogType === 'cardio' && allSets.length > 0;

    return (
      <View style={styles.exerciseScreenContainer}>
        <View style={[styles.timerDisplay, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.timerLabel, { color: theme.text }]}>{t('workoutTime')}</Text>
          <Text style={[styles.workoutTimerText, { color: theme.text }]}>
            {timerCalculations.formatTime(timerState.workoutDuration)}
          </Text>
        </View>

        {showCardioWholeWorkoutControls ? (
          <View
            style={{
              flexDirection: 'row',
              marginTop: 12,
              marginBottom: 18,
              alignSelf: 'stretch',
              justifyContent: 'center',
              gap: 12,
            }}
          >
            <TouchableOpacity
              style={[
                styles.secondaryButton,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                  flex: 1,
                  maxWidth: 220,
                },
              ]}
              onPress={isCardioTimerPaused ? handleCardioTimerResume : handleCardioTimerPause}
              activeOpacity={0.85}
            >
              <Text style={[styles.secondaryButtonText, { color: theme.text }]}>
                {isCardioTimerPaused ? t('resumeTimer') : t('pauseTimer')}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
        
        <View style={[styles.currentExerciseCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.currentExerciseName, { color: theme.text }]}>
            {currentSet.exercise_name}
          </Text>

          <View style={styles.badgeAndIconsContainer}>
            {muscleGroupInfo && muscleGroupInfo.value && (
              <View style={[styles.muscleGroupBadgeMain, { backgroundColor: theme.card, borderColor: theme.border, marginRight: 8 }]}>
                <Text style={[styles.muscleGroupBadgeText, { color: theme.text }]}>
                  {t(muscleGroupInfo.label)}
                </Text>
              </View>
            )}
            {currentSet.exercise_notes && (
              <TouchableOpacity onPress={() => showNotes(currentSet.exercise_notes!, currentSet.exercise_name)} style={{ marginRight: 8 }}>
                <Ionicons name="bookmark-outline" size={22} color={theme.text} />
              </TouchableOpacity>
            )}
            {currentSet.web_link && (
              <TouchableOpacity onPress={() => handleLinkPress(currentSet.web_link)}>
                <Ionicons name="link-outline" size={22} color={theme.text} />
              </TouchableOpacity>
            )}
          </View>
          
          {isCardio ? (
            <Pressable
              onPress={openCardioModal}
              style={({ pressed }) => [
                { alignSelf: 'stretch', opacity: pressed ? 0.75 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                t('cardioDurationTapLabel') || 'Duration — tap to open timer'
              }
            >
              <Text style={[styles.inputLabel, { color: theme.textSecondary, marginBottom: 6 }]}>
                {t('cardioDurationTapLabel') || 'Duration — tap to open timer'}
              </Text>
              <Text style={[styles.repInfo, { color: theme.text }]}>
                {t('goal')}:{' '}
                <Text style={{ fontWeight: '700', textDecorationLine: 'underline' }}>
                  {formatCardioMinutesLine(String(currentSet.reps_goal))}
                </Text>
              </Text>
              <Text style={[styles.repInfo, { color: theme.text, marginTop: 8 }]}>
                {t('loggedMinutesLabel') || 'Logged'}:{' '}
                {shouldShowCardioLoggedMinutesDisplay(currentSet) ? (
                  <Text style={{ fontWeight: '700', textDecorationLine: 'underline' }}>
                    {formatCardioMinutesLine(currentSet.reps_done)}
                  </Text>
                ) : (
                  <Text style={{ color: theme.textSecondary, fontStyle: 'italic', fontWeight: '400' }}>
                    {t('cardioLoggedMinutesEmpty') || '—'}
                  </Text>
                )}
              </Text>
              {!currentSet.set_logged ? (
                shouldShowCardioLoggedMinutesDisplay(currentSet) ? (
                  <Text style={[styles.repInfo, { color: theme.textSecondary, marginTop: 6, fontSize: 13 }]}>
                    {t('cardioMinutesReadyHint')}
                  </Text>
                ) : (
                  <Text style={[styles.repInfo, { color: theme.textSecondary, marginTop: 6, fontStyle: 'italic', fontSize: 13 }]}>
                    {t('cardioNoDurationLogged') || 'No minutes logged yet — tap above for timer'}
                  </Text>
                )
              ) : null}
            </Pressable>
          ) : (
            <>
              <Text style={[styles.setInfo, { color: theme.text }]}>
                {currentSet.set_number}/{currentSet.total_sets}
              </Text>
              <Text style={[styles.repInfo, { color: theme.text }]}>
                {t('goal')}: {currentSet.reps_goal} {t('Reps')}
              </Text>
            </>
          )}
          
          {!isCardio ? (
          <View style={styles.inputContainer}>
            <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: theme.text }]}>{t('repsDone')}</Text>
              <TextInput
                  style={[styles.input, { 
                  backgroundColor: theme.card,
              color: theme.text,
              borderColor: theme.border
            }]}
            value={currentSet.reps_done}
            onChangeText={(text) => {
              const updatedSets = [...allSets];
              updatedSets[timerState.currentSetIndex] = {
                ...updatedSets[timerState.currentSetIndex],
                reps_done: text
              };
              setAllSets(updatedSets);
            }}
            keyboardType="number-pad"
            maxLength={4}
            placeholder="0+"
            placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'}
          />
            </View>
            
            <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: theme.text }]}> {t('Weight')} ({weightFormat})</Text>
              <TextInput
                style={[styles.input, { 
                  backgroundColor: theme.card,
                  color: theme.text,
                  borderColor: theme.border
                }]}
                value={currentSet.weight}
                onChangeText={(text) => {
                  const updatedSets = [...allSets];
                  updatedSets[timerState.currentSetIndex] = {
                    ...updatedSets[timerState.currentSetIndex],
                    weight: text
                  };
                  setAllSets(updatedSets);
                }}
                keyboardType="decimal-pad"
                placeholder="0+"
                placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'}
              />
            </View>
          </View>
          ) : null}

          {currentSet.total_sets > 1 ? (
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                alignItems: 'center',
                gap: 28,
                marginTop: 12,
              }}
            >
              <TouchableOpacity
                disabled={prevSameExerciseSetIndex < 0}
                onPress={() => {
                  if (prevSameExerciseSetIndex < 0) return;
                  clearRestTimerState();
                  setTimerState((prev) =>
                    updateTimerState(prev, {
                      currentSetIndex: prevSameExerciseSetIndex,
                      workoutStage: 'exercise',
                    }),
                  );
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text
                  style={{
                    fontWeight: '600',
                    fontSize: 15,
                    color:
                      prevSameExerciseSetIndex < 0
                        ? theme.inactivetint
                        : theme.buttonBackground,
                  }}
                >
                  {t('previousSet')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={nextSameExerciseSetIndex < 0}
                onPress={() => {
                  if (nextSameExerciseSetIndex < 0) return;
                  clearRestTimerState();
                  setTimerState((prev) =>
                    updateTimerState(prev, {
                      currentSetIndex: nextSameExerciseSetIndex,
                      workoutStage: 'exercise',
                    }),
                  );
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text
                  style={{
                    fontWeight: '600',
                    fontSize: 15,
                    color:
                      nextSameExerciseSetIndex < 0
                        ? theme.inactivetint
                        : theme.buttonBackground,
                  }}
                >
                  {t('nextSet')}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
        
        <View style={styles.controlsContainer}>
            {!isLastStructuralSet &&
            <TouchableOpacity
                style={[styles.completeButton, { 
                backgroundColor: 
                    !canCompleteSet
                    ? theme.inactivetint 
                    : theme.buttonBackground
                }]}
                onPress={() => {
                const pressCurrentSet = allSets[timerState.currentSetIndex];
                if (!pressCurrentSet) return;
                const pressIsCardio = isCardioSetUI(pressCurrentSet.exercise_name, workoutLogType);
                const valid = pressIsCardio
                  ? isValidCardioSet(
                      pressCurrentSet.reps_done,
                      pressCurrentSet.weight || '0',
                    )
                  : isValidRepsAndWeight(
                      pressCurrentSet.reps_done,
                      pressCurrentSet.weight,
                    );
                if (!valid) {
                    Alert.alert(
                      t('missingInformation'),
                      pressIsCardio
                        ? t('enterCardioMinutes') ||
                          'Enter a valid duration in minutes (open the timer from the duration label if needed).'
                        : t('enterRepsAndWeight'),
                    );
                    return;
                }

                setIsCompletingSet(true);

                const currentSetIndex = timerState.currentSetIndex;
                setAllSets((prev) => {
                  if (currentSetIndex < 0 || currentSetIndex >= prev.length) return prev;
                  const next = [...prev];
                  const base = next[currentSetIndex];
                  const logged = {
                    ...base,
                    set_logged: true,
                    ...(pressIsCardio ? { weight: base.weight?.trim() || '0' } : {}),
                  };
                  next[currentSetIndex] = logged;
                  queueMicrotask(() => {
                    updateExerciseLoggedStatus(logged.exercise_id, next);
                    proceedAfterSetLogged(next, currentSetIndex);
                  });
                  return next;
                });
                }}
                disabled={
                    isCompletingSet ||
                    !canCompleteSet
                }
            >
                <Text style={[styles.buttonText, { color: theme.buttonText }]}>
                {isCompletingSet ? `${t('completing')}...` : (isLastUnloggedSet ? t('finishWorkout') : t('completeSet'))}
                </Text>
            </TouchableOpacity>
            }
            <View style={styles.secondaryControlsContainer}>
                {!isLastExercise &&
                  <TouchableOpacity
                  style={[styles.secondaryButton, { backgroundColor: theme.card, borderColor: theme.border }]}
                  onPress={handleSkipToNextExercise}
                  >
                    <AutoSizeText
                      fontSize={16}
                      numberOfLines={3}
                      mode={ResizeTextMode.max_lines}
                      style={[styles.secondaryButtonText, { color: theme.text }]}
                    >
                      {t('skipToNextExercise')}
                    </AutoSizeText>
                  </TouchableOpacity>
                }
                <TouchableOpacity
                  style={[
                    styles.secondaryButton, 
                    { backgroundColor: theme.card, borderColor: theme.border },
                    (isLastExercise && !isLastStructuralSet) && { width: '100%' },
                    (isLastExercise && isLastStructuralSet) && { width: '100%' }
                  ]}
                  onPress={handleFinishWorkout}
                >
                  <AutoSizeText
                    fontSize={16}
                    numberOfLines={3}
                    mode={ResizeTextMode.max_lines}
                    style={[styles.secondaryButtonText, { color: theme.text }]}
                  >
                    {t('finishWorkout')}
                  </AutoSizeText>
                </TouchableOpacity>
            </View>
        </View>
        
        <View style={styles.progressContainer}>
          <Text style={[styles.progressText, { color: theme.text }]}>
            {Math.round(progress)}%
          </Text>
          <View style={[styles.progressBar, { backgroundColor: theme.border }]}>
            <View 
              style={[
                styles.progressFill, 
                { 
                  backgroundColor: theme.buttonBackground,
                  width: `${progress}%`
                }
              ]} 
            />
          </View>
        </View>
        <Text style={[styles.tipText, { color: theme.text }]}>{t('startedWorkoutTip')}</Text>
      </View>
    );
  };
  
  const renderRestScreen = () => {
    const nextSet = allSets[timerState.currentSetIndex];
    
    const muscleGroupInfo = nextSet ? muscleGroupData.find(mg => mg.value === nextSet.muscle_group) : null;
    const nextIsCardio = nextSet ? isCardioSetUI(nextSet.exercise_name, workoutLogType) : false;

    let previousSetReps = null;
    let previousSetWeight = null;
    if (nextSet) {
      const setKey = `${nextSet.exercise_name}-${nextSet.set_number}`;
      previousSetReps = repsMapRef.current.get(setKey) || null;
      previousSetWeight = weightMapRef.current.get(setKey) || null;
    }
    
    return (
      <View style={styles.restScreenContainer}>
        <View style={[styles.restCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.restTitle, { color: theme.text }]}>{t('restTime')}</Text>
          
          <View style={styles.restTimerContainer}>
            <Text style={[styles.restTimerText, { color: theme.text }]}>
              {timerState.restRemaining}
            </Text>
            <Text style={[styles.restTimerUnit, { color: theme.text }]}>{t('sec')}</Text>
          </View>
          
          <TouchableOpacity
              style={[styles.addTimeButton, { backgroundColor: theme.type === 'dark' ? 'rgba(255,255,255,0.15)' : theme.border }]}
            onPress={() => {
              if (restTimerEndAtRef.current != null) {
                restTimerEndAtRef.current += 15000;
                const sec = Math.max(0, Math.ceil((restTimerEndAtRef.current - Date.now()) / 1000));
                setTimerState(prev => updateTimerState(prev, { restRemaining: sec }));
              } else {
                setTimerState(prev => updateTimerState(prev, {
                  restRemaining: (prev.restRemaining ?? 0) + 15
                }));
              }
            }}
          >
            <Text style={[styles.addTimeButtonText, { color: theme.type === 'dark' ? 'white' : 'rgba(255, 255, 255, 0.8)' }]}>{t('addTime')}</Text>
          </TouchableOpacity>
        </View>
        
        {nextSet && (
          <View style={[styles.upNextCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.upNextLabel, { color: theme.text }]}>{t('upNext')}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                <Text style={[styles.upNextExercise, { color: theme.text, marginRight: 8 }]}>
                  {nextSet.exercise_name}
                </Text>
                {muscleGroupInfo && muscleGroupInfo.value && (
                  <View style={[styles.muscleGroupBadgeModal, { backgroundColor: theme.card, borderColor: theme.border }]}>
                    <Text style={[styles.muscleGroupBadgeText, { color: theme.text }]}>
                      {t(muscleGroupInfo.label)}
                    </Text>
                  </View>
                )}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {nextSet.exercise_notes && (
                  <TouchableOpacity onPress={() => showNotes(nextSet.exercise_notes!, nextSet.exercise_name)} style={{ marginLeft: 10 }}>
                    <Ionicons name="bookmark-outline" size={22} color={theme.text} />
                  </TouchableOpacity>
                )}
                {nextSet.web_link && (
                  <TouchableOpacity onPress={() => handleLinkPress(nextSet.web_link)} style={{ marginLeft: 10 }}>
                    <Ionicons name="link-outline" size={22} color={theme.text} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
            <Text style={[styles.upNextSetInfo, { color: theme.text }]}>
              {t('upcomingSet')}: {nextSet.set_number}
            </Text>
            {(previousSetReps || previousSetWeight) && (
              <Text style={[styles.upNextSetInfo, { color: theme.text }]}>
                {t('lastWorkoutInfo')}:{' '}
                {previousSetReps
                  ? nextIsCardio
                    ? formatCardioMinutesLine(previousSetReps)
                    : `${previousSetReps} ${t('Reps')}`
                  : ''}
                {previousSetReps && previousSetWeight ? ' / ' : ''}
                {previousSetWeight ? `${previousSetWeight} ${weightFormat}` : ''}
              </Text>
            )}
          </View>
        )}
        
        <TouchableOpacity
          style={[styles.skipRestButton, { backgroundColor: theme.buttonBackground }]}
          onPress={() => {
            clearRestTimerState(); // Clear rest timer state when skipping
            setTimerState(prev => updateTimerState(prev, {
              workoutStage: 'exercise'
            }));
          }}
        >
          <Text style={[styles.buttonText, { color: theme.buttonText }]}>{t('skipRest')}</Text>
        </TouchableOpacity>
      </View>
    );
  };
  
  const renderCompletedScreen = () => {
    const loggedSets = allSets.filter(set => set.set_logged);
    
    const saveWorkout = async () => {
      try {
        console.log('Starting workout save process...');

        const prevMaxRows = await db.getAllAsync<{ exercise_name: string; max_weight: number }>(
          `SELECT exercise_name, MAX(weight_logged) as max_weight FROM Weight_Log WHERE workout_log_id != ? GROUP BY exercise_name;`,
          [workout_log_id]
        );
        const prevMaxByExercise: Record<string, number> = {};
        prevMaxRows.forEach((r) => { prevMaxByExercise[r.exercise_name] = r.max_weight; });

        await db.runAsync('BEGIN TRANSACTION;');

        console.log('Saving completion time to Workout_Log:', timerState.workoutDuration);
        await db.runAsync(
          `UPDATE Workout_Log 
           SET completion_time = ? 
           WHERE workout_log_id = ?;`,
          [timerState.workoutDuration, workout_log_id]
        );

        const prs: { exercise_name: string; weight: number; reps: number }[] = [];
        console.log('Saving completed sets:', loggedSets.length);
        for (let i = 0; i < loggedSets.length; i++) {
          const set = loggedSets[i];
          const wParsed = parseWeightForLog(set.weight);
          const w = wParsed ?? 0;
          const repsParsed = parseFloat(
            set.reps_done.trim().replace(',', '.'),
          );
          const reps = Number.isNaN(repsParsed) ? 0 : repsParsed;
          const prevMax = prevMaxByExercise[set.exercise_name] ?? 0;
          if (w > prevMax) prs.push({ exercise_name: set.exercise_name, weight: w, reps });

          await db.runAsync(
            `INSERT INTO Weight_Log (
              workout_log_id, 
              logged_exercise_id, 
              exercise_name, 
              set_number, 
              weight_logged, 
              reps_logged,
              muscle_group
            ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
            [
              workout_log_id,
              set.exercise_id,
              set.exercise_name,
              set.set_number,
              w,
              reps,
              set.muscle_group
            ]
          );
        }

        await db.runAsync('COMMIT;');
        console.log('Workout save completed successfully!');

        await clearActiveWorkoutSession();
        await timerStateUtils.clearTimerState();

        if (prs.length > 0) {
          const first = prs[0];
          const unit = weightFormat || 'lbs';
          await showCelebrationNotification(
            'You hit a PR!',
            `${first.exercise_name}: ${first.weight} ${unit} x ${first.reps}`
          );
        }

        Alert.alert(
          t('workoutSaved'),
          t('workoutSavedMessage'),
          [
            {
              text: t('OK'),
              onPress: () =>
                navigation.navigate('MyCalendar', { refresh: true }),
            },
          ],
        );
      } catch (error) {
        await db.runAsync('ROLLBACK;');
        console.error('Error saving workout:', error);
        Alert.alert(
          'Error',
          'There was an error saving your workout. Please try again.'
        );
      }
    };
    
    return (
      <View style={styles.completedContainer}>
        <Ionicons name="checkmark-circle" size={80} color={theme.buttonBackground} style={styles.completedIcon} />
        
        <Text style={[styles.completedTitle, { color: theme.text }]}>{t('workoutCompleted')}</Text>
        
        <View style={[styles.completedCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.completedWorkoutName, { color: theme.text }]}>
            {workout?.workout_name}
          </Text>
          
          <View style={styles.completedStats}>
            <View style={styles.completedStatItem}>
              <Text style={[styles.completedStatValue, { color: theme.text }]}>
                {timerCalculations.formatTime(timerState.workoutDuration)}
              </Text>
              <Text style={[styles.completedStatLabel, { color: theme.text }]}>{t('totalTime')}</Text>
            </View>
            
            <View style={styles.completedStatItem}>
              <Text style={[styles.completedStatValue, { color: theme.text }]}>
                {loggedSets.length}
              </Text>
              <Text style={[styles.completedStatLabel, { color: theme.text }]}>{t('setsCompleted')}</Text>
            </View>
          </View>
        </View>
        
        <TouchableOpacity
          style={[styles.saveButton, { backgroundColor: theme.buttonBackground }]}
          onPress={saveWorkout}
        >
          <Text style={[styles.buttonText, { color: theme.buttonText }]}>
            {t('completeWorkout')}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  const applyExerciseOrder = useCallback(
    (data: Exercise[]) => {
      const prevSets = allSetsRef.current;
      const prevTs = timerStateRef.current;
      const rebuilt = reorderAllSetsByExerciseOrder(prevSets, data);
      if (rebuilt.length === 0) return;

      const cur = prevSets[prevTs.currentSetIndex];
      let newIdx = prevTs.currentSetIndex;
      if (cur) {
        const found = rebuilt.findIndex(
          (s) => s.exercise_id === cur.exercise_id && s.set_number === cur.set_number,
        );
        if (found >= 0) newIdx = found;
      } else {
        newIdx = Math.min(prevTs.currentSetIndex, Math.max(0, rebuilt.length - 1));
      }

      allSetsRef.current = rebuilt;
      const nextTs = updateTimerState(prevTs, { currentSetIndex: newIdx });
      timerStateRef.current = nextTs;

      setAllSets(rebuilt);
      setExercises(mapExercisesWithLoggedFlag(data, rebuilt));
      setTimerState(nextTs);

      if (!nextTs.workoutStarted || nextTs.workoutStage === 'completed') return;
      const setsSnapshot = rebuilt.map((s) => ({
        exercise_name: s.exercise_name,
        set_number: s.set_number,
        weight: s.weight,
        reps_done: s.reps_done,
        set_logged: s.set_logged,
        ...(s.cardio_duration_saved_from_timer != null
          ? { cardio_duration_saved_from_timer: s.cardio_duration_saved_from_timer }
          : {}),
      }));
      const cardioPaused =
        workoutLogTypeRef.current === 'cardio' && isCardioTimerPausedRef.current;
      void timerStateUtils.saveTimerState(nextTs, {
        workoutLogId: workout_log_id,
        setsSnapshot: setsSnapshot.length > 0 ? setsSnapshot : undefined,
        ...(cardioPaused ? { cardioTimerPaused: true } : {}),
      });
    },
    [workout_log_id],
  );

  const handleExerciseListDragEnd = useCallback(
    ({ data }: DragEndParams<Exercise>) => {
      applyExerciseOrder(data);
    },
    [applyExerciseOrder],
  );

  const removeLoggedExerciseFromSession = useCallback(
    async (loggedExerciseId: number) => {
      const ids = new Set(allSetsRef.current.map((s) => s.exercise_id));
      if (ids.size <= 1 && ids.has(loggedExerciseId)) {
        Alert.alert(t('errorTitle'), t('cannotDeleteLastExercise'));
        return;
      }
      try {
        await db.runAsync(
          'DELETE FROM Weight_Log WHERE workout_log_id = ? AND logged_exercise_id = ?;',
          [workout_log_id, loggedExerciseId],
        );
        await db.runAsync(
          'DELETE FROM Logged_Exercises WHERE logged_exercise_id = ? AND workout_log_id = ?;',
          [loggedExerciseId, workout_log_id],
        );

        const prevSets = allSetsRef.current;
        const prevTs = timerStateRef.current;
        const rebuilt = prevSets.filter((s) => s.exercise_id !== loggedExerciseId);
        if (rebuilt.length === 0) return;

        const cur = prevSets[prevTs.currentSetIndex];
        let newIdx = prevTs.currentSetIndex;
        if (cur) {
          const found = rebuilt.findIndex(
            (s) => s.exercise_id === cur.exercise_id && s.set_number === cur.set_number,
          );
          if (found >= 0) newIdx = found;
          else newIdx = Math.min(prevTs.currentSetIndex, Math.max(0, rebuilt.length - 1));
        } else {
          newIdx = Math.min(prevTs.currentSetIndex, Math.max(0, rebuilt.length - 1));
        }

        allSetsRef.current = rebuilt;
        const nextTs = updateTimerState(prevTs, { currentSetIndex: newIdx });
        timerStateRef.current = nextTs;

        setAllSets(rebuilt);
        setExercises((prevEx) =>
          orderLoggedExercisesLikeSets(
            rebuilt,
            prevEx.filter((e) => e.logged_exercise_id !== loggedExerciseId),
          ),
        );
        setTimerState(nextTs);

        if (nextTs.workoutStarted && nextTs.workoutStage !== 'completed') {
          const setsSnapshot = rebuilt.map((s) => ({
            exercise_name: s.exercise_name,
            set_number: s.set_number,
            weight: s.weight,
            reps_done: s.reps_done,
            set_logged: s.set_logged,
            ...(s.cardio_duration_saved_from_timer != null
              ? { cardio_duration_saved_from_timer: s.cardio_duration_saved_from_timer }
              : {}),
          }));
          const cardioPaused =
            workoutLogTypeRef.current === 'cardio' && isCardioTimerPausedRef.current;
          void timerStateUtils.saveTimerState(nextTs, {
            workoutLogId: workout_log_id,
            setsSnapshot: setsSnapshot.length > 0 ? setsSnapshot : undefined,
            ...(cardioPaused ? { cardioTimerPaused: true } : {}),
          });
        }
      } catch (e) {
        console.error('Failed to remove exercise from active workout:', e);
        Alert.alert(
          t('errorTitle'),
          e instanceof Error ? e.message : 'Could not remove exercise.',
        );
      }
    },
    [db, t, workout_log_id],
  );
  
  const renderExerciseListModal = () => {
    const currentExerciseNameFromSet = allSets[timerState.currentSetIndex]?.exercise_name;

    return (
      <Modal
        visible={isExerciseListModalVisible}
        transparent={false}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          setIsExerciseListModalVisible(false);
        }}
      >
        <>
        {isExerciseListModalVisible ? (
          <StatusBar
            backgroundColor={theme.background}
            barStyle={theme.type === 'dark' ? 'light-content' : 'dark-content'}
          />
        ) : null}

        <SafeAreaView
          style={[styles.exerciseListModalRoot, { backgroundColor: theme.background }]}
          edges={['top', 'bottom']}
        >
          <View style={[styles.exerciseListModalHeader, { borderBottomColor: theme.border }]}>
            <View
              style={[
                styles.modalWorkoutTitleCard,
                {
                  borderColor: theme.border,
                  backgroundColor: theme.card,
                },
              ]}
            >
              <Text style={[styles.modalTitle, { color: theme.text }]}>
                {formatWorkoutHeaderTitle(workout?.workout_name, workout?.day_name)}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => setIsExerciseListModalVisible(false)}
              style={styles.modalCloseButton}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close-outline" size={28} color={theme.text} />
            </TouchableOpacity>
          </View>
          <GestureHandlerRootView style={styles.modalExerciseListGestureRoot}>
            <DraggableFlatList
              showsVerticalScrollIndicator={false}
              data={exercises}
              keyExtractor={(item) => item.logged_exercise_id.toString()}
              onDragEnd={handleExerciseListDragEnd}
              activationDistance={12}
              containerStyle={styles.modalDraggableListContainer}
              contentContainerStyle={styles.exerciseListModalListContent}
              renderItem={({ item, drag, isActive }) => {
                const isCurrent = item.exercise_name === currentExerciseNameFromSet;
                const muscleGroupInfo = muscleGroupData.find(mg => mg.value === item.muscle_group);
                const itemStyle = [
                  styles.modalExerciseItem,
                  { borderColor: theme.border },
                  isCurrent
                    ? { 
                        backgroundColor: theme.buttonBackground,
                      }
                    : { backgroundColor: theme.card }
                ];
                const nameStyle = [
                  styles.modalExerciseName,
                  isCurrent
                    ? { color: theme.buttonText }
                    : { color: theme.text }
                ];
                const detailStyle = [
                  styles.modalExerciseDetails,
                  isCurrent
                    ? { color: theme.buttonText }
                    : { color: theme.text }
                ];

                const handlePress = () => {
                  const targetIndex = item.exercise_fully_logged
                    ? allSets.findIndex((s) => s.exercise_id === item.logged_exercise_id)
                    : allSets.findIndex(
                        (s) =>
                          s.exercise_id === item.logged_exercise_id && !s.set_logged,
                      );

                  if (targetIndex !== -1) {
                    clearRestTimerState();
                    setTimerState((prev) =>
                      updateTimerState(prev, {
                        currentSetIndex: targetIndex,
                        workoutStage: 'exercise',
                      }),
                    );
                    setIsExerciseListModalVisible(false);
                  }
                };

                let modalExerciseSwipeRef: Swipeable | null = null;

                return (
                  <ScaleDecorator>
                    <Swipeable
                      ref={(r) => {
                        modalExerciseSwipeRef = r;
                      }}
                      enabled={!isActive}
                      friction={1}
                      overshootLeft={false}
                      overshootRight={false}
                      containerStyle={styles.swipeableContainer}
                      renderRightActions={() => (
                        <View style={styles.swipeDeleteActionHost}>
                          <RectButton
                            style={styles.swipeDeleteAction}
                            onPress={() => {
                              modalExerciseSwipeRef?.close();
                              void removeLoggedExerciseFromSession(item.logged_exercise_id);
                            }}
                          >
                            <Ionicons name="trash-outline" size={20} color="#fff" />
                            <Text style={styles.swipeDeleteActionText}>{t('Delete')}</Text>
                          </RectButton>
                        </View>
                      )}
                    >
                      <TouchableOpacity
                        onLongPress={drag}
                        delayLongPress={400}
                        disabled={isActive}
                        onPress={handlePress}
                        activeOpacity={0.7}
                        style={styles.modalExerciseRowMainTouchable}
                        accessibilityRole="button"
                        accessibilityLabel={
                          `${item.exercise_name}. ${t('reorderExerciseA11y', { defaultValue: 'Long press and drag to reorder' })}`
                        }
                      >
                        <View style={itemStyle}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
                              {item.exercise_fully_logged && (
                                <Ionicons name="checkmark-circle" size={20} color={isCurrent ? theme.buttonText : theme.buttonBackground} style={{ marginRight: 8 }} />
                              )}
                              <Text style={[nameStyle, { marginRight: 8 }]}>{item.exercise_name}</Text>
                              {muscleGroupInfo && muscleGroupInfo.value && (
                                <View style={[
                                  styles.muscleGroupBadgeModal,
                                  { 
                                    backgroundColor: isCurrent ? theme.text : theme.card,
                                    borderColor: isCurrent ? theme.buttonText : theme.border,
                                  }
                                ]}>
                                  <Text style={[
                                    styles.muscleGroupBadgeText,
                                    { color: isCurrent ? (theme.type === 'dark' ? '#000' : '#fff') : theme.text }
                                  ]}>
                                    {t(muscleGroupInfo.label)}
                                  </Text>
                                </View>
                              )}
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                              {item.web_link && (
                                <TouchableOpacity onPress={() => handleLinkPress(item.web_link)} style={{ marginLeft: 10 }}>
                                  <Ionicons name="link-outline" size={22} color={isCurrent ? theme.buttonText : theme.text} />
                                </TouchableOpacity>
                              )}
                            </View>
                          </View>
                          <Text style={[detailStyle, { marginTop: 4 }]}>
                            {isCardioSetUI(item.exercise_name, workoutLogType)
                              ? `${t('durationMinutes') || 'Duration (minutes)'}: ${item.reps}`
                              : `${item.sets} ${t('Sets')} × ${item.reps} ${t('Reps')}`}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </Swipeable>
                  </ScaleDecorator>
                );
              }}
            />
          </GestureHandlerRootView>
        </SafeAreaView>
        </>
      </Modal>
    );
  };
  
  const renderNotesModal = () => {
    return (
      <Modal
        visible={isNotesModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {
          setIsNotesModalVisible(false);
        }}
      >

        
    {isNotesModalVisible && (
          <StatusBar
            backgroundColor={theme.type === 'light' ? "rgba(0, 0, 0, 0.5)" : "black"}
            barStyle={'light-content'}          />
        )}



        
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={() => setIsNotesModalVisible(false)}
        >
          <View 
            style={[styles.modalContainer, { backgroundColor: theme.card, borderColor: theme.border }]}
            onStartShouldSetResponder={() => true} // Prevents modal from closing on inner press
          >
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>{notesModalTitle}</Text>
              <TouchableOpacity onPress={() => setIsNotesModalVisible(false)} style={styles.modalCloseButton}>
                <Ionicons name="close-outline" size={28} color={theme.text} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.notesSubHeader, { color: theme.text }]}>{t('exerciseNotes')}</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
                <Text style={[styles.notesModalText, { color: theme.text }]}>{notesModalContent}</Text>
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    );
  };

  const renderCardioModal = () => {
    const cs = allSets[timerState.currentSetIndex];
    const title = (() => {
      if (!cs) return t('completeSet');
      if (isCardioExerciseName(cs.exercise_name)) {
        return (
          cs.exercise_name.replace(new RegExp(`^\\s*${CARDIO_NAME_PREFIX}`), '').trim() ||
          cs.exercise_name
        );
      }
      if (workoutLogType === 'cardio') return cs.exercise_name;
      return t('completeSet');
    })();

    const timerPrimaryLabel = cardioTimerRunning
      ? t('pauseTimer')
      : cardioCountdownSessionStarted && cardioCountdownSec > 0
        ? t('resumeTimer')
        : cardioCountdownSec > 0
          ? t('startTimer')
          : '—';

    return (
      <Modal
        visible={cardioModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeCardioModal}
      >
        {cardioModalVisible ? (
          <StatusBar
            backgroundColor={
              theme.type === 'light' ? 'rgba(0, 0, 0, 0.5)' : 'black'
            }
            barStyle="light-content"
          />
        ) : null}
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPressOut={closeCardioModal}
        >
          <View
            style={[
              styles.modalContainer,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
            onStartShouldSetResponder={() => true}
          >
            <View
              style={[
                styles.modalHeader,
                { borderBottomColor: theme.border },
              ]}
            >
              <Text style={[styles.modalTitle, { color: theme.text }]}>
                {title}
              </Text>
              <TouchableOpacity
                onPress={closeCardioModal}
                style={styles.modalCloseButton}
                accessibilityLabel="Close"
              >
                <Ionicons name="close-outline" size={28} color={theme.text} />
              </TouchableOpacity>
            </View>
            <View style={{ paddingVertical: 8, paddingHorizontal: 4 }}>
              <Text style={[styles.inputLabel, { color: theme.textSecondary, marginBottom: 6 }]}>
                {t('durationMinutes') || 'Duration (minutes)'}
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.card,
                    color: theme.text,
                    borderColor: theme.border,
                    marginBottom: 12,
                  },
                ]}
                value={cardioManualMinutes}
                onChangeText={setCardioManualMinutes}
                keyboardType="decimal-pad"
                placeholder="15"
                placeholderTextColor={
                  theme.type === 'dark' ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)'
                }
                accessibilityLabel={t('durationMinutes') || 'Duration in minutes'}
              />
              <Text
                style={[
                  styles.cardioModalCountdown,
                  { color: theme.text },
                ]}
              >
                {formatCardioCountdownMMSS(cardioCountdownSec)}
              </Text>
              <TouchableOpacity
                style={[
                  styles.cardioModalPrimaryBtn,
                  { backgroundColor: theme.buttonBackground },
                ]}
                onPress={handleCardioStartPauseResume}
                disabled={cardioCountdownSec <= 0}
                activeOpacity={0.85}
              >
                <Text
                  style={[styles.buttonText, { color: theme.buttonText }]}
                >
                  {timerPrimaryLabel}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.completeButton,
                  {
                    backgroundColor: theme.buttonBackground,
                    marginTop: 16,
                  },
                ]}
                onPress={handleCardioLogSetFromModal}
                activeOpacity={0.85}
              >
                <Text style={[styles.buttonText, { color: theme.buttonText }]}>
                  {t('logSet')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    );
  };
  
  const clearRestTimerState = () => {
    restTimerEndAtRef.current = null;
    stopRestTimer();
    setTimerState(prev => updateTimerState(prev, {
      isResting: false,
      isExerciseRest: false,
      restRemaining: null,
      restStartTime: null
    }));
  };

  const handleSkipToNextExercise = () => {
    const currentExerciseId = allSets[timerState.currentSetIndex].exercise_id;
    const currentExerciseInExercisesIndex = exercises.findIndex(e => e.logged_exercise_id === currentExerciseId);

    let nextUnloggedExercise = null;
    for (let i = currentExerciseInExercisesIndex + 1; i < exercises.length; i++) {
        if (!exercises[i].exercise_fully_logged) {
            nextUnloggedExercise = exercises[i];
            break;
        }
    }

    if (nextUnloggedExercise) {
        const firstUnloggedSetIndex = allSets.findIndex(
            s => s.exercise_id === nextUnloggedExercise.logged_exercise_id && !s.set_logged
        );

        if (firstUnloggedSetIndex !== -1) {
            clearRestTimerState();
            setTimerState(prev =>
              updateTimerState(prev, {
                currentSetIndex: firstUnloggedSetIndex,
                workoutStage: 'exercise',
              })
            );
        }
    } else {
        Alert.alert(t('noMoreExercises'), t('allFollowingExercisesLogged'));
    }
  };
  const handleFinishWorkout = () => {
    setIsCardioTimerPaused(false);
    const currentSetIndex = timerState.currentSetIndex;

    setAllSets((prev) => {
      const currentSet = prev[currentSetIndex];
      if (currentSet) {
        const currentIsCardio = isCardioSetUI(currentSet.exercise_name, workoutLogType);
        const valid = currentIsCardio
          ? isValidCardioSet(currentSet.reps_done, currentSet.weight || '0')
          : isValidRepsAndWeight(currentSet.reps_done, currentSet.weight);
        if (valid) {
          const next = [...prev];
          const logged = {
            ...currentSet,
            set_logged: true,
            ...(currentIsCardio ? { weight: currentSet.weight?.trim() || '0' } : {}),
          };
          next[currentSetIndex] = logged;
          queueMicrotask(() => {
            updateExerciseLoggedStatus(logged.exercise_id, next);
          });
          return next;
        }
      }
      return prev;
    });

    stopWorkoutTimer();
    setTimerState(prev => updateTimerState(prev, { workoutStage: 'completed' }));
  };
  
  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.text} />
        <Text style={[styles.loadingText, { color: theme.text }]}>{t('loadingWorkout')}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            navigation.goBack();
          }}
        >
          <Ionicons name="arrow-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>
          {timerState.workoutStarted
            ? (workout ? formatWorkoutHeaderTitle(workout.workout_name, workout.day_name) : 'Workout')
            : t('startWorkout')}
        </Text>
        {timerState.workoutStarted ? (
          <TouchableOpacity 
            onPress={() => setIsExerciseListModalVisible(true)} 
            style={styles.headerListIcon}
          >
            <Ionicons name="reorder-three-outline" size={23} color={theme.text} />
          </TouchableOpacity>
        ) : (
          <View style={{ width: 23 + (styles.headerListIcon.padding * 2), marginLeft: styles.headerListIcon.marginLeft }} />
        )}
      </View>
      
      <ScrollView 
        showsVerticalScrollIndicator={false}
        style={styles.content} 
        contentContainerStyle={[
          styles.scrollContent,
          timerState.workoutStage === 'rest' && styles.restScrollContent,
          timerState.workoutStage === 'exercise' && styles.exerciseScrollContent
        ]}
      >
        {timerState.workoutStage === 'overview' && renderOverview()}
        {timerState.workoutStage === 'exercise' && renderExerciseScreen()}
        {timerState.workoutStage === 'rest' && renderRestScreen()}
        {timerState.workoutStage === 'completed' && renderCompletedScreen()}
      </ScrollView>
      {renderExerciseListModal()}
      {renderNotesModal()}
      {renderCardioModal()}
    </View>
  );
}

// Styles remain the same...
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 40,
    paddingBottom: 20,
    paddingHorizontal: 20,
  },
  backButton: {
    padding: 5,
    marginRight: 15,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    flex: 1,
    textAlign: 'center',
  },
  headerListIcon: {
    padding: 5,
    marginLeft: 15,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  exerciseScrollContent: {
    paddingTop: 0,
  },
  restScrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 20,
  },
  
  // Toggle styles
  toggleRow: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingVertical: 10, 
    paddingHorizontal: 15, 
    borderRadius: 8, 
    borderWidth: 1, 
    marginBottom: 10 
  },
  toggleText: { 
    fontSize: 16, 
    fontWeight: '600' 
  },
  
  // Overview screen styles
  overviewContainer: {
    width: '100%',
  },
  workoutHeaderCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
    alignItems: 'center',
  },
  workoutName: {
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  workoutDay: {
    fontSize: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  workoutStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 6,
  },
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  statLabel: {
    fontSize: 13,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  exercisesList: {
    marginBottom: 12,
  },
  exerciseItem: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
  },
  /** RNGH Swipeable defaults to overflow: 'hidden'; use visible so the 80pt delete column is not clipped. */
  swipeableContainer: {
    overflow: 'visible',
  },
  /** Fixed width so Swipeable measures right actions as exactly 80pt (see RNGH rightOffset layout). */
  swipeDeleteActionHost: {
    width: 80,
    alignSelf: 'stretch',
  },
  swipeDeleteAction: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 80,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#c62828',
    borderTopLeftRadius: 10,
    borderBottomLeftRadius: 10,
  },
  swipeDeleteActionText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    marginTop: 4,
  },
  exerciseName: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  exerciseDetails: {
    fontSize: 13,
  },
  setupSection: {
    marginTop: 8,
    marginBottom: 12,
  },
  setupLabel: {
    fontSize: 15,
    marginBottom: 6,
  },
  restTimeInput: {
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    marginBottom: 10,
  },
  startButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    paddingVertical: 15,
    marginTop: 10,
  },
  startButtonTop: {
    marginTop: 0,
    marginBottom: 16,
  },
  buttonIcon: {
    marginRight: 10,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  
  // Exercise screen styles
  exerciseScreenContainer: {
    width: '100%',
    paddingTop: 0,
  },
  timerDisplay: {
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  timerLabel: {
    fontSize: 11,
    marginBottom: 0,
  },
  workoutTimerText: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  badgeAndIconsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 2,
    marginBottom: 4,
    minHeight: 22,
  },
  currentExerciseCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    marginBottom: 8,
  },
  currentExerciseName: {
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  setInfo: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 2,
  },
  repInfo: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 6,
  },
  inputContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  inputGroup: {
    width: '48%',
  },
  inputLabel: {
    fontSize: 13,
    marginBottom: 4,
  },
  input: {
    height: 42,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  controlsContainer: {
    marginTop: 4,
    marginBottom: 10,
  },
  completeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 12,
  },
  progressContainer: {
    marginBottom: 12,
  },
  progressText: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  progressBar: {
    height: 8,
    borderRadius: 4,
    width: '100%',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  secondaryControlsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  secondaryButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
    width: '48%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  tipText: {
    marginTop: 15,
    textAlign: 'center',
    fontSize: 14,
    fontStyle: 'italic',
  },
  
  // Rest screen styles
  restScreenContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  restCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    alignItems: 'center',
    marginBottom: 16,
    width: '100%',
  },
  restTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  restTimerContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 6,
  },
  restTimerText: {
    fontSize: 44,
    fontWeight: 'bold',
    lineHeight: 44,
  },
  restTimerUnit: {
    fontSize: 18,
    marginBottom: 6,
    marginLeft: 4,
  },
  addTimeButton: {
    paddingVertical: 8,
    paddingHorizontal: 15,
    borderRadius: 20,
    marginBottom: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  addTimeButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  upNextCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    width: '100%',
    marginBottom: 14,
  },
  upNextLabel: {
    fontSize: 14,
    marginBottom: 5,
  },
  upNextExercise: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  upNextSetInfo: {
    fontSize: 16,
    fontWeight: '600',
  },
  skipRestButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },

  emptyActiveWorkoutContainer: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 16,
  },
  emptyActiveWorkoutTimer: {
    fontSize: 56,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  emptyActiveWorkoutButtonRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
    marginTop: 24,
    alignSelf: 'stretch',
    width: '100%',
  },
  emptyActiveWorkoutSecondaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
  },
  emptyActiveWorkoutPrimaryInRow: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  
  // Completed screen styles
  completedContainer: {
    width: '100%',
    alignItems: 'center',
    paddingTop: 30,
  },
  completedIcon: {
    marginBottom: 20,
  },
  completedTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 30,
    textAlign: 'center',
  },
  completedCard: {
    borderRadius: 15,
    borderWidth: 1,
    padding: 20,
    width: '100%',
    alignItems: 'center',
    marginBottom: 30,
  },
  completedWorkoutName: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  completedStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
  },
  completedStatItem: {
    alignItems: 'center',
  },
  completedStatValue: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  completedStatLabel: {
    fontSize: 14,
    marginTop: 5,
  },
  saveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    paddingVertical: 15,
    paddingHorizontal: 40,
    marginTop: 20,
  },
  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContainer: {
    width: '90%',
    maxHeight: '70%',
    flexDirection: 'column',
    borderRadius: 15,
    borderWidth: 1,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingBottom: 15,
    width: '100%',
  },
  modalWorkoutTitleCard: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginRight: 8,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  modalCloseButton: {
    padding: 5,
    alignSelf: 'flex-start',
  },
  exerciseListModalRoot: {
    flex: 1,
  },
  exerciseListModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
    width: '100%',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  exerciseListModalListContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
    flexGrow: 1,
  },
  modalExerciseListGestureRoot: {
    flex: 1,
  },
  modalDraggableListContainer: {
    flexGrow: 1,
  },
  modalExerciseRowMainTouchable: {
    flex: 1,
    minWidth: 0,
  },
  modalExerciseItem: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    marginBottom: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  modalExerciseName: {
    fontSize: 17,
    fontWeight: '600',
  },
  modalExerciseDetails: {
    fontSize: 14,
  },
  muscleGroupBadgeMain: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 15,
    borderWidth: 1,
    alignSelf: 'center',
  },
  muscleGroupBadgeOverview: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 15,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  muscleGroupBadgeModal: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 15,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  muscleGroupBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  notesModalText: {
    fontSize: 16,
    lineHeight: 24,
  },
  notesSubHeader: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  cardioModalCountdown: {
    fontSize: 48,
    fontWeight: '700',
    textAlign: 'center',
    marginVertical: 16,
    fontVariant: ['tabular-nums'],
  },
  cardioModalPrimaryBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
});
