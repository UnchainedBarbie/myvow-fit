/** Unicode dash/minus variants models often use instead of ASCII `-` (e.g. "Cool–down"). */
const UNICODE_DASH_OR_MINUS = /[\u2010\u2011\u2013\u2014\u2212\u00AD\uFE58\uFE63\uFF0D]/g;

function normalizeExerciseNameForSortTier(raw: string): string {
  let s = (raw ?? '').trim().replace(/^\uFEFF/, '');
  s = s.replace(UNICODE_DASH_OR_MINUS, '-');
  s = s.replace(/\u00A0/g, ' ');
  s = s.replace(/\*\*/g, '');
  s = s.replace(/^[*_•\s\-]+/g, '').trim();
  return s;
}

/**
 * Ordering for workout exercise lists: warmups first, main work in the middle, cool-downs last.
 * Handles exact Sage prefixes plus common model variants (spacing, hyphen, one-word "Cooldown").
 */
export function getWorkoutExerciseSortTier(exerciseName: string): 0 | 1 | 2 {
  const n = normalizeExerciseNameForSortTier(exerciseName);
  const lower = n.toLowerCase();
  if (
    lower.startsWith('warm-up:') ||
    lower.startsWith('warm up:') ||
    lower.startsWith('warmup:') ||
    /^warm[-\s]?up\b[:\s-]*/i.test(n)
  ) {
    return 0;
  }
  if (
    lower.startsWith('cool-down:') ||
    lower.startsWith('cool down:') ||
    lower.startsWith('cooldown:') ||
    /^cool[\s_-]*down\s*:/i.test(n) ||
    /^cool[\s_-]*down\b[:\s-]*/i.test(n)
  ) {
    return 2;
  }
  return 1;
}

/** True for Sage-style warm-up / cool-down rows (same rules as sort tier 0 and 2). */
export function isWarmupOrCooldownExerciseName(exerciseName: string): boolean {
  const tier = getWorkoutExerciseSortTier(exerciseName);
  return tier === 0 || tier === 2;
}

const COMPOUND_MUSCLE_GROUPS = new Set([
  'chest',
  'back',
  'legs',
  'shoulders',
  'glutes',
  'hamstrings',
  'quads',
]);

/**
 * Same ordering as active workout / Sage save: tier → (main only) compound before isolation → name.
 */
export function sortWorkoutPlanExercisesForDisplay<
  T extends { exercise_name: string; muscle_group?: string | null },
>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const an = (a.exercise_name ?? '').trim();
    const bn = (b.exercise_name ?? '').trim();
    const ta = getWorkoutExerciseSortTier(an);
    const tb = getWorkoutExerciseSortTier(bn);
    if (ta !== tb) return ta - tb;
    if (ta === 0 || ta === 2) return an.localeCompare(bn);

    const ac = COMPOUND_MUSCLE_GROUPS.has((a.muscle_group || '').toLowerCase()) ? 0 : 1;
    const bc = COMPOUND_MUSCLE_GROUPS.has((b.muscle_group || '').toLowerCase()) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return an.localeCompare(bn);
  });
}

export type ExerciseSetsVolumeLabels = {
  sets: string;
  reps: string;
  sec?: string;
};

/**
 * List/detail line for planned or logged exercises: "3 sets × 10 reps" or "3 sets × 45 sec".
 * Time-based when duration_seconds > 0 and reps is 0/null.
 */
export function formatExerciseSetsVolumeLine(
  sets: number,
  reps: number | null | undefined,
  duration_seconds: number | null | undefined,
  labels: ExerciseSetsVolumeLabels,
): string {
  const d = duration_seconds ?? 0;
  const r = reps ?? 0;
  const secLbl = labels.sec ?? 'sec';
  if (d > 0 && r === 0) {
    return `${sets} ${labels.sets} × ${d} ${secLbl}`;
  }
  return `${sets} ${labels.sets} × ${r} ${labels.reps}`;
}

/** Single title when workout and day labels are identical (avoids "Push - Push"). */
export function formatWorkoutHeaderTitle(
  workoutName: string | null | undefined,
  dayName: string | null | undefined
): string {
  const w = (workoutName ?? '').trim();
  const d = (dayName ?? '').trim();
  if (!w && !d) return '';
  if (!w) return d;
  if (!d) return w;
  if (w === d) return w;
  return `${w} - ${d}`;
}
