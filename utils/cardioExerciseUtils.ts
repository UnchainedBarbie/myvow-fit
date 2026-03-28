/** Matches StartedWorkoutInterface / Sage cardio naming. */
export const CARDIO_EXERCISE_NAME_PREFIX = 'Cardio:';

export function exerciseNameLooksLikeCardio(name: string): boolean {
  return name.trimStart().startsWith(CARDIO_EXERCISE_NAME_PREFIX);
}

/** Prefix display name for DB + active workout if missing. */
export function ensureCardioExerciseName(displayName: string): string {
  const t = displayName.trim();
  if (!t) return '';
  return exerciseNameLooksLikeCardio(t) ? t : `${CARDIO_EXERCISE_NAME_PREFIX} ${t}`;
}

export function formatCardioDistanceForDb(
  distanceText: string,
  unit: 'km' | 'mi',
): string | null {
  const raw = distanceText.replace(',', '.').trim();
  if (!raw) return null;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n} ${unit}`;
}

export function parseStoredDistance(s: string | null | undefined): {
  value: string;
  unit: 'km' | 'mi';
} {
  if (!s || !String(s).trim()) return { value: '', unit: 'km' };
  const t = String(s).trim();
  const m = t.match(/^([\d.,]+)\s*(km|mi|miles?)?$/i);
  if (!m) return { value: t, unit: 'km' };
  const u = (m[2] || '').toLowerCase();
  const unit = u.startsWith('mi') ? 'mi' : 'km';
  return { value: m[1].replace(',', '.'), unit };
}

export function isCardioExerciseInEditor(
  workoutType: 'strength' | 'cardio',
  ex: { exercise_name: string; exercise_type?: string | null },
): boolean {
  if (workoutType === 'cardio') return true;
  return (
    exerciseNameLooksLikeCardio(ex.exercise_name) ||
    String(ex.exercise_type || '').toLowerCase() === 'cardio'
  );
}
