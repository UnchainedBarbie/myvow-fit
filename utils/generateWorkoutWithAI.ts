/**
 * Calls Anthropic Claude API to generate a structured workout from a natural language description.
 * Returns data ready to insert into Workouts, Days, and Exercises tables.
 */

export interface AIExercise {
  exercise_name: string;
  sets: number;
  reps: number;
  web_link?: string | null;
  muscle_group?: string | null;
  exercise_notes?: string | null;
}

export interface AIDay {
  day_name: string;
  exercises: AIExercise[];
}

export interface AIWorkout {
  workout_name: string;
  days: AIDay[];
}

const SYSTEM_PROMPT = `You are a fitness coach. The user will describe a workout they want. You must respond with ONLY a single valid JSON object (no markdown, no code fence, no explanation) in this exact shape:

{
  "workout_name": "string - a short title for the workout",
  "days": [
    {
      "day_name": "string - e.g. Push Day, Day 1",
      "exercises": [
        {
          "exercise_name": "string",
          "sets": number,
          "reps": number,
          "web_link": "string or null",
          "muscle_group": "string or null (e.g. chest, back, shoulders, biceps, triceps, legs, abs)",
          "exercise_notes": "string or null"
        }
      ]
    }
  ]
}

Rules:
- workout_name must be unique and descriptive.
- Each day must have at least one exercise.
- sets and reps must be positive integers.
- muscle_group, web_link, and exercise_notes can be null if not applicable.
- Output only the JSON object, nothing else.`;

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  // If wrapped in ```json ... ``` or ``` ... ```, extract inner part
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  return trimmed;
}

function validateAndNormalize(data: unknown): AIWorkout {
  if (!data || typeof data !== 'object' || !('workout_name' in data) || !('days' in data))
    throw new Error('Invalid response: missing workout_name or days');
  const obj = data as Record<string, unknown>;
  const workout_name = obj.workout_name;
  const days = obj.days;
  if (typeof workout_name !== 'string' || !workout_name.trim())
    throw new Error('Invalid response: workout_name must be a non-empty string');
  if (!Array.isArray(days) || days.length === 0)
    throw new Error('Invalid response: days must be a non-empty array');
  const normalizedDays: AIDay[] = days.map((day, i) => {
    if (!day || typeof day !== 'object' || !('day_name' in day) || !('exercises' in day))
      throw new Error(`Invalid response: day ${i} missing day_name or exercises`);
    const d = day as Record<string, unknown>;
    const day_name = d.day_name;
    const exercises = d.exercises;
    if (typeof day_name !== 'string' || !day_name.trim())
      throw new Error(`Invalid response: day ${i} day_name must be a non-empty string`);
    if (!Array.isArray(exercises) || exercises.length === 0)
      throw new Error(`Invalid response: day ${i} must have at least one exercise`);
    const normalizedExercises: AIExercise[] = exercises.map((ex, j) => {
      if (!ex || typeof ex !== 'object' || !('exercise_name' in ex) || !('sets' in ex) || !('reps' in ex))
        throw new Error(`Invalid response: exercise ${j} in day ${i} missing exercise_name, sets, or reps`);
      const e = ex as Record<string, unknown>;
      const exercise_name = e.exercise_name;
      const sets = e.sets;
      const reps = e.reps;
      if (typeof exercise_name !== 'string' || !exercise_name.trim())
        throw new Error(`Invalid response: exercise ${j} in day ${i} exercise_name must be a non-empty string`);
      const setsNum = typeof sets === 'number' ? sets : parseInt(String(sets), 10);
      const repsNum = typeof reps === 'number' ? reps : parseInt(String(reps), 10);
      if (!Number.isInteger(setsNum) || setsNum < 1 || !Number.isInteger(repsNum) || repsNum < 1)
        throw new Error(`Invalid response: exercise ${j} in day ${i} sets and reps must be positive integers`);
      return {
        exercise_name: String(exercise_name).trim(),
        sets: setsNum,
        reps: repsNum,
        web_link: e.web_link != null ? String(e.web_link) : null,
        muscle_group: e.muscle_group != null ? String(e.muscle_group) : null,
        exercise_notes: e.exercise_notes != null ? String(e.exercise_notes) : null,
      };
    });
    return { day_name: String(day_name).trim(), exercises: normalizedExercises };
  });
  return { workout_name: workout_name.trim(), days: normalizedDays };
}

export async function generateWorkoutWithAI(
  apiKey: string,
  userDescription: string
): Promise<AIWorkout> {
  console.log('generateWorkoutWithAI called');
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) throw new Error('API key is required');
  const trimmedDesc = userDescription.trim();
  if (!trimmedDesc) throw new Error('Please describe the workout you want');

  console.log('Calling Anthropic API...');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': trimmedKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmedDesc }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    let message = `API error ${response.status}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.error?.message) message = errJson.error.message;
    } catch {
      if (errText) message = errText.slice(0, 200);
    }
    console.log('API error:', errText);
    throw new Error(message);
  }

  const data = await response.json();
  console.log('API response received:', data);
  const content = data.content;
  if (!Array.isArray(content) || content.length === 0)
    throw new Error('Invalid API response: no content');
  const textBlock = content.find((b: { type?: string }) => b.type === 'text');
  if (!textBlock || typeof (textBlock as { text?: string }).text !== 'string')
    throw new Error('Invalid API response: no text content');
  const rawText = (textBlock as { text: string }).text;
  const jsonStr = extractJsonFromText(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Could not parse workout from AI response');
  }
  return validateAndNormalize(parsed);
}

/**
 * Inserts or updates an AI-generated workout in the SQLite database (Workouts, Days, Exercises).
 * If a workout with the same workout_name exists, updates that row and replaces its Days and Exercises.
 */
export async function insertAIWorkout(db: { withTransactionAsync: (fn: () => Promise<void>) => Promise<void>; runAsync: (sql: string, params?: unknown[]) => Promise<unknown>; getAllAsync: <T>(sql: string, params?: unknown[]) => Promise<T[]> }, workout: AIWorkout): Promise<void> {
  await db.withTransactionAsync(async () => {
    const existing = await db.getAllAsync<{ workout_id: number }>(
      'SELECT workout_id FROM Workouts WHERE workout_name = ?;',
      [workout.workout_name]
    );
    let workoutId: number;

    if (existing.length > 0) {
      workoutId = existing[0].workout_id;
      await db.runAsync('UPDATE Workouts SET workout_name = ? WHERE workout_id = ?;', [workout.workout_name, workoutId]);
      await db.runAsync(
        'DELETE FROM Exercises WHERE day_id IN (SELECT day_id FROM Days WHERE workout_id = ?);',
        [workoutId]
      );
      await db.runAsync('DELETE FROM Days WHERE workout_id = ?;', [workoutId]);
    } else {
      await db.runAsync('INSERT INTO Workouts (workout_name) VALUES (?);', [workout.workout_name]);
      const workoutIdResult = (await db.getAllAsync<{ workout_id: number }>('SELECT last_insert_rowid() as workout_id;'));
      if (!workoutIdResult.length) throw new Error('Failed to retrieve workout ID.');
      workoutId = workoutIdResult[0].workout_id;
    }

    for (const day of workout.days) {
      await db.runAsync('INSERT INTO Days (workout_id, day_name) VALUES (?, ?);', [workoutId, day.day_name]);
      const dayIdResult = (await db.getAllAsync<{ day_id: number }>('SELECT last_insert_rowid() as day_id;'));
      if (!dayIdResult.length) throw new Error('Failed to retrieve day ID.');
      const dayId = dayIdResult[0].day_id;

      for (const ex of day.exercises) {
        await db.runAsync(
          'INSERT INTO Exercises (day_id, exercise_name, sets, reps, rest_seconds) VALUES (?, ?, ?, ?, ?);',
          [
            dayId,
            ex.exercise_name,
            ex.sets,
            ex.reps,
            null,
          ]
        );
      }
    }
  });
}

