// utils/timerPersistenceUtils.ts
import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Storage key for timer state
const TIMER_STATE_KEY = '@workout_timer_state';

// Type definitions
export interface TimerState {
  workoutStartTime: number | null;
  /** Cumulative active time (cardio: sum of started segments; used for completion_time). */
  workoutDuration: number;
  /** Cardio: seconds for the current exercise only; resets when moving to the next exercise. */
  exerciseSegmentDuration: number;
  restStartTime: number | null;
  restRemaining: number | null;
  isResting: boolean;
  isExerciseRest: boolean;
  currentSetIndex: number;
  workoutStage: 'overview' | 'exercise' | 'rest' | 'completed';
  workoutStarted: boolean;
}

/** In-progress set logging (Weight_Log is only written on workout completion). */
export type SetProgressSnapshot = {
  exercise_name: string;
  set_number: number;
  weight: string;
  reps_done: string;
  set_logged: boolean;
  /** True when duration was saved from the cardio timer modal (even if it equals goal). */
  cardio_duration_saved_from_timer?: boolean;
};

export type PersistedTimerPayload = TimerState & {
  timestamp: number;
  workoutLogId?: number | null;
  setsSnapshot?: SetProgressSnapshot[];
  /** Cardio: timer interval stopped; do not add background elapsed to duration. */
  cardioTimerPaused?: boolean;
};

export interface TimerCallbacks {
  onRestore: (
    savedState: TimerState,
    elapsedSeconds: number,
    rawPayload?: PersistedTimerPayload,
  ) => void;
  onError?: (error: Error) => void;
}

export interface TimerPersistenceOptions {
  enabled?: boolean;
  debugMode?: boolean;
  /** When set, stored with timer blob so resume can verify the same workout. */
  workoutLogId?: number;
  /** Persists in-memory set progress when the app backgrounds. */
  getSetsSnapshot?: () => SetProgressSnapshot[];
  /** When true, saved on background so restore does not count background time toward duration. */
  getCardioTimerPaused?: () => boolean;
}

export function mergeExerciseSetsWithSnapshot<
  T extends {
    exercise_name: string;
    set_number: number;
    weight: string;
    reps_done: string;
    set_logged: boolean;
  },
>(sets: T[], snapshot: SetProgressSnapshot[]): T[] {
  const map = new Map(
    snapshot.map((s) => [`${s.exercise_name}\0${s.set_number}`, s] as const),
  );
  return sets.map((row) => {
    const snap = map.get(`${row.exercise_name}\0${row.set_number}`);
    if (!snap) return row;
    const merged = {
      ...row,
      weight: snap.weight,
      reps_done: snap.reps_done,
      set_logged: snap.set_logged,
    };
    if ('cardio_duration_saved_from_timer' in snap) {
      return {
        ...merged,
        cardio_duration_saved_from_timer: snap.cardio_duration_saved_from_timer,
      };
    }
    return merged;
  });
}

const setProgressKey = (exercise_name: string, set_number: number) =>
  `${exercise_name}\0${set_number}`;

/**
 * Reorder merged in-memory sets to match snapshot sequence (e.g. user reordered exercises mid-workout).
 * Returns `merged` unchanged if snapshot does not contain exactly the same sets as keys.
 */
export function orderMergedSetsLikeSnapshot<
  T extends { exercise_name: string; set_number: number },
>(merged: T[], snapshot: SetProgressSnapshot[]): T[] {
  if (snapshot.length === 0 || snapshot.length !== merged.length) return merged;
  const map = new Map(
    merged.map((s) => [setProgressKey(s.exercise_name, s.set_number), s] as const),
  );
  if (map.size !== merged.length) return merged;
  const out: T[] = [];
  for (const snap of snapshot) {
    const key = setProgressKey(snap.exercise_name, snap.set_number);
    const row = map.get(key);
    if (!row) return merged;
    out.push(row);
    map.delete(key);
  }
  return map.size === 0 ? out : merged;
}

// Utility functions for timer state management
export const timerStateUtils = {
  /**
   * Save timer state to AsyncStorage
   */
  saveTimerState: async (
    timerState: TimerState,
    extra?: {
      workoutLogId?: number;
      setsSnapshot?: SetProgressSnapshot[];
      cardioTimerPaused?: boolean;
    },
  ): Promise<void> => {
    try {
      const stateWithTimestamp: PersistedTimerPayload = {
        ...timerState,
        timestamp: Date.now(),
        ...(extra?.workoutLogId != null ? { workoutLogId: extra.workoutLogId } : {}),
        ...(extra?.setsSnapshot != null && extra.setsSnapshot.length > 0
          ? { setsSnapshot: extra.setsSnapshot }
          : {}),
        ...(extra?.cardioTimerPaused === true ? { cardioTimerPaused: true } : {}),
      };

      await AsyncStorage.setItem(TIMER_STATE_KEY, JSON.stringify(stateWithTimestamp));

      if (__DEV__) {
        console.log('Timer state saved:', stateWithTimestamp);
      }
    } catch (error) {
      console.error('Error saving timer state:', error);
      throw error;
    }
  },

  /**
   * Load timer state from AsyncStorage
   */
  loadTimerState: async (): Promise<PersistedTimerPayload | null> => {
    try {
      const stored = await AsyncStorage.getItem(TIMER_STATE_KEY);

      if (!stored) {
        return null;
      }

      const parsedState = JSON.parse(stored);

      if (__DEV__) {
        console.log('Timer state loaded:', parsedState);
      }

      return parsedState;
    } catch (error) {
      console.error('Error loading timer state:', error);
      return null;
    }
  },

  /**
   * Clear timer state from AsyncStorage
   */
  clearTimerState: async (): Promise<void> => {
    try {
      await AsyncStorage.removeItem(TIMER_STATE_KEY);
    } catch (error) {
      console.error('Error clearing timer state:', error);
    }
  },

  /**
   * Calculate elapsed time since timestamp
   */
  calculateElapsedTime: (timestamp: number): number => {
    return Math.floor((Date.now() - timestamp) / 1000);
  },

  /**
   * Check if timer state is valid for restoration
   */
  isValidTimerState: (state: any): state is TimerState => {
    return (
      state &&
      typeof state === 'object' &&
      typeof state.workoutDuration === 'number' &&
      typeof state.currentSetIndex === 'number' &&
      typeof state.workoutStarted === 'boolean' &&
      ['overview', 'exercise', 'rest', 'completed'].includes(state.workoutStage)
    );
  },

  toTimerState: (payload: PersistedTimerPayload): TimerState => ({
    workoutStartTime: payload.workoutStartTime,
    workoutDuration: payload.workoutDuration,
    exerciseSegmentDuration:
      typeof payload.exerciseSegmentDuration === 'number'
        ? payload.exerciseSegmentDuration
        : 0,
    restStartTime: payload.restStartTime,
    restRemaining: payload.restRemaining,
    isResting: payload.isResting,
    isExerciseRest: payload.isExerciseRest,
    currentSetIndex: payload.currentSetIndex,
    workoutStage: payload.workoutStage,
    workoutStarted: payload.workoutStarted,
  }),
};

/**
 * Custom hook for timer persistence
 */
export const useTimerPersistence = (
  timerState: TimerState,
  callbacks: TimerCallbacks,
  options: TimerPersistenceOptions = {},
) => {
  const { enabled = true, debugMode = __DEV__, workoutLogId, getSetsSnapshot, getCardioTimerPaused } =
    options;
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const isRestoringRef = useRef(false);
  const workoutLogIdRef = useRef(workoutLogId);
  const getSetsSnapshotRef = useRef(getSetsSnapshot);
  const getCardioTimerPausedRef = useRef(getCardioTimerPaused);

  useEffect(() => {
    workoutLogIdRef.current = workoutLogId;
  }, [workoutLogId]);

  useEffect(() => {
    getSetsSnapshotRef.current = getSetsSnapshot;
  }, [getSetsSnapshot]);

  useEffect(() => {
    getCardioTimerPausedRef.current = getCardioTimerPaused;
  }, [getCardioTimerPaused]);

  const handleAppStateChange = useCallback(
    async (nextAppState: AppStateStatus) => {
      if (!enabled || !timerState.workoutStarted || timerState.workoutStage === 'completed') {
        appState.current = nextAppState;
        return;
      }

      try {
        // Going to background
        if (appState.current === 'active' && nextAppState.match(/inactive|background/)) {
          if (debugMode) {
            console.log('=== APP GOING TO BACKGROUND ===');
            console.log('Saving timer state:', timerState);
          }

          const setsSnapshot = getSetsSnapshotRef.current?.();
          const cardioPaused = getCardioTimerPausedRef.current?.() === true;
          await timerStateUtils.saveTimerState(timerState, {
            workoutLogId: workoutLogIdRef.current,
            setsSnapshot: setsSnapshot && setsSnapshot.length > 0 ? setsSnapshot : undefined,
            ...(cardioPaused ? { cardioTimerPaused: true } : {}),
          });
        }
        // Coming to foreground
        else if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
          if (debugMode) {
            console.log('=== APP RETURNING TO FOREGROUND ===');
          }

          // Prevent multiple restoration attempts
          if (isRestoringRef.current) {
            if (debugMode) {
              console.log('Restoration already in progress, skipping...');
            }
            return;
          }

          isRestoringRef.current = true;

          try {
            const savedState = await timerStateUtils.loadTimerState();

            if (savedState && timerStateUtils.isValidTimerState(savedState)) {
              const elapsedSeconds = timerStateUtils.calculateElapsedTime(savedState.timestamp);

              if (debugMode) {
                console.log('Elapsed time in background:', elapsedSeconds, 'seconds');
                console.log('Restoring state:', savedState);
              }

              callbacks.onRestore(
                timerStateUtils.toTimerState(savedState),
                elapsedSeconds,
                savedState,
              );
              await timerStateUtils.clearTimerState();
            } else if (debugMode) {
              console.log('No valid saved state found');
            }
          } finally {
            isRestoringRef.current = false;
          }
        }
      } catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        console.error('Error in app state change handler:', errorObj);

        if (callbacks.onError) {
          callbacks.onError(errorObj);
        }

        isRestoringRef.current = false;
      }

      appState.current = nextAppState;
    },
    [timerState, callbacks, enabled, debugMode],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      subscription.remove();
      // Do not clear timer blob on unmount — StartedWorkoutInterface persists on blur/unmount
      // and clears explicitly when the workout is saved or the user abandons it.
    };
  }, [handleAppStateChange, enabled]);

  // Return utility functions for manual control
  return {
    saveState: () =>
      timerStateUtils.saveTimerState(timerState, {
        workoutLogId: workoutLogIdRef.current,
        setsSnapshot: getSetsSnapshotRef.current?.(),
        ...(getCardioTimerPausedRef.current?.() === true ? { cardioTimerPaused: true } : {}),
      }),
    clearState: timerStateUtils.clearTimerState,
    loadState: timerStateUtils.loadTimerState,
  };
};

/**
 * Helper function to create timer state object
 */
export const createTimerState = (overrides: Partial<TimerState> = {}): TimerState => {
  return {
    workoutStartTime: null,
    workoutDuration: 0,
    exerciseSegmentDuration: 0,
    restStartTime: null,
    restRemaining: 0,
    isResting: false,
    isExerciseRest: false,
    currentSetIndex: 0,
    workoutStage: 'overview',
    workoutStarted: false,
    ...overrides,
  };
};

/**
 * Helper function to update timer state immutably
 */
export const updateTimerState = (currentState: TimerState, updates: Partial<TimerState>): TimerState => {
  return {
    ...currentState,
    ...updates,
  };
};

/**
 * Timer calculation utilities
 */
export const timerCalculations = {
  /**
   * Calculate current workout duration based on start time
   */
  getCurrentWorkoutDuration: (startTime: number | null): number => {
    if (!startTime) return 0;
    return Math.floor((Date.now() - startTime) / 1000);
  },

  /**
   * Calculate remaining rest time based on start time and initial duration
   */
  getCurrentRestRemaining: (startTime: number | null, initialDuration: number): number => {
    if (!startTime) return 0;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    return Math.max(0, initialDuration - elapsed);
  },

  /**
   * Format time in HH:MM:SS format
   */
  formatTime: (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  },
};

export default {
  useTimerPersistence,
  timerStateUtils,
  createTimerState,
  updateTimerState,
  timerCalculations,
};
