/** Per-exercise tracking: rep-based (reps > 0) vs time-based (duration_seconds > 0), never both. */

export const REPS_DURATION_BOTH_ERROR =
  "Use either Reps OR Duration, not both. Set the field you're not using to 0.";
export const REPS_DURATION_NONE_ERROR = 'Enter Reps or Duration for this exercise.';

export function parseTrackingInt(raw: string): number {
  const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isTimeBasedExercise(
  reps: number | null | undefined,
  durationSeconds: number | null | undefined,
): boolean {
  const d = durationSeconds ?? 0;
  const r = reps ?? 0;
  return d > 0 && r === 0;
}

export function isRepBasedExercise(
  reps: number | null | undefined,
  durationSeconds: number | null | undefined,
): boolean {
  const d = durationSeconds ?? 0;
  const r = reps ?? 0;
  return r > 0 && d === 0;
}

export type RepsDurationValidation =
  | { ok: true; reps: number; duration_seconds: number | null }
  | { ok: false; message: string };

export function validateRepsOrDurationInput(
  repsRaw: string | number,
  durationRaw: string | number,
): RepsDurationValidation {
  const reps =
    typeof repsRaw === 'number'
      ? repsRaw > 0
        ? Math.floor(repsRaw)
        : 0
      : parseTrackingInt(repsRaw);
  const duration =
    typeof durationRaw === 'number'
      ? durationRaw > 0
        ? Math.floor(durationRaw)
        : 0
      : parseTrackingInt(durationRaw);

  if (reps > 0 && duration > 0) {
    return { ok: false, message: REPS_DURATION_BOTH_ERROR };
  }
  if (reps === 0 && duration === 0) {
    return { ok: false, message: REPS_DURATION_NONE_ERROR };
  }
  if (duration > 0) {
    return { ok: true, reps: 0, duration_seconds: duration };
  }
  return { ok: true, reps, duration_seconds: null };
}

/** Active-workout countdown display, e.g. 45 → "0:45", 90 → "1:30". */
export function formatHoldCountdownDisplay(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** Seconds to persist when a time-based set is completed. */
export function computeTimeBasedSetLoggedSeconds(
  targetSeconds: number,
  remainingSeconds: number,
  timerEverStarted: boolean,
): number {
  const target = Math.max(0, Math.floor(targetSeconds));
  if (!timerEverStarted) return target > 0 ? target : 0;
  const remaining = Math.max(0, Math.floor(remainingSeconds));
  if (remaining <= 0) return target > 0 ? target : 0;
  return Math.max(1, target - remaining);
}
