import AsyncStorage from '@react-native-async-storage/async-storage';

export const ACTIVE_WORKOUT_LOG_ID_KEY = '@active_workout_log_id';

export type ActiveWorkoutSession = { workoutLogId: number };

export async function saveActiveWorkoutSession(workoutLogId: number): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_WORKOUT_LOG_ID_KEY, String(workoutLogId));
}

export async function clearActiveWorkoutSession(): Promise<void> {
  await AsyncStorage.removeItem(ACTIVE_WORKOUT_LOG_ID_KEY);
}

export async function getActiveWorkoutSession(): Promise<ActiveWorkoutSession | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_WORKOUT_LOG_ID_KEY);
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  return { workoutLogId: n };
}
