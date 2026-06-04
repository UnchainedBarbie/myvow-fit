import React, { useEffect, useRef, useState, useLayoutEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  Alert,
  Share,
  NativeSyntheticEvent,
  NativeScrollEvent,
  ActionSheetIOS,
  AppState,
  AppStateStatus,
  InteractionManager,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTheme } from '../context/ThemeContext';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { sortWorkoutPlanExercisesForDisplay } from '../utils/workoutDisplayUtils';
import { DEFAULT_REST_SECONDS_BETWEEN_SETS } from '../utils/startedWorkoutPreferenceUtils';
import { insertAIWorkout, AIWorkout, isAiExerciseCardio } from '../utils/generateWorkoutWithAI';
import { initMealPlansDb } from '../utils/initMealPlansDb';
import { initNutritionDb } from '../utils/nutritionDb';
import { initVowsDb } from '../utils/initVowsDb';
import { CreateOwnVowModal, type CreateOwnVowSubmitPayload, CATEGORY_DISPLAY_LABELS } from '../components/CreateOwnVowModal';
import { ChoiceListModal, type ChoiceListOption } from '../components/ChoiceListModal';
import {
  SageMessage,
  saveConversation,
  loadConversation,
  clearConversation as clearSageStorage,
} from '../utils/sageStorage';
import { stripMarkdownFromVowText } from '../utils/sageMarkdownStrip';
import {
  initPurchasedProductsDb,
  upsertProduct,
  getTopProducts,
  parseProductsTagNamesFromContent,
  stripProductsTagsFromMessage,
  areAllProductsInPurchasedTable,
} from '../utils/purchasedProducts';

/** Max recent messages sent to the API before prepending preserved meal-plan context. */
const SAGE_API_CONTEXT_TAIL_COUNT = 20;

const SAGE_WORKER_URL = 'https://myvow-fit-api.allison-spink.workers.dev';
const SAGE_MODEL = 'claude-sonnet-4-5';
/** Default cap for normal Sage chat (non–meal-plan-heavy turns). */
const SAGE_DEFAULT_MAX_TOKENS = 4096;
/** Output cap when the user is clearly asking for a full meal plan (multi-day JSON can be large). */
const MEAL_PLAN_MAX_TOKENS = 8192;
/** Receipt / image path: higher than legacy 1024; meal-plan–style receipt updates use {@link MEAL_PLAN_MAX_TOKENS}. */
const SAGE_RECEIPT_DEFAULT_MAX_TOKENS = 4096;

const SAGE_TRUNCATION_UI_COPY =
  "Response was cut off. Tap 'Continue' to finish.";
const SAGE_CONTINUATION_USER_MESSAGE =
  'Continue the previous response from where it left off. Do not repeat content already shown.';
const SAGE_MEALPLAN_INCOMPLETE_HINT =
  'Response incomplete — tap Continue above';

/** Sage assistant avatar (leaf); column width = diameter + gap to bubble. */
const SAGE_LEAF_AVATAR_DIAMETER = 34;
const SAGE_LEAF_AVATAR_GAP = 8;
const SAGE_LEAF_ICON_SIZE = 18;
const SAGE_LEAF_FILL = '#A8BEA8';

/** User text suggests a large meal-plan style reply (raise max_tokens only for that request). */
const MEAL_PLAN_INTENT_USER_RE =
  /\bmeal\s*plan\b|\b\d+\s*[- ]?\s*days?\b|\bweekly\s+(meal|meals|nutrition|food)s?\b|\b(day\s+by\s+day|each\s+day)\b.*\b(breakfast|lunch|dinner|snack|meal|macro)/i;

function looksLikeMealPlanGenerationRequest(userText: string): boolean {
  const t = userText.trim();
  if (!t) return false;
  return MEAL_PLAN_INTENT_USER_RE.test(t);
}

function chooseMaxTokensForSageUserText(userMessage: string): number {
  return looksLikeMealPlanGenerationRequest(userMessage)
    ? MEAL_PLAN_MAX_TOKENS
    : SAGE_DEFAULT_MAX_TOKENS;
}

function chooseMaxTokensForTruncationContinuation(msgs: SageMessage[]): number {
  const lastAssistant = [...msgs]
    .reverse()
    .find((m) => m.role === 'assistant' && !m.truncationUi);
  const c = lastAssistant?.content ?? '';
  if (/<mealplan\b/i.test(c)) return MEAL_PLAN_MAX_TOKENS;
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  return lastUser ? chooseMaxTokensForSageUserText(lastUser.content) : SAGE_DEFAULT_MAX_TOKENS;
}

function filterSageMessagesForApi(messages: SageMessage[]): SageMessage[] {
  return messages.filter((m) => !m.truncationUi);
}

/** True when `<mealplan>` has opened but no matching `</mealplan>` appears after it. */
function mealPlanBlockStartedNotClosed(content: string): boolean {
  const idx = content.search(/<mealplan\b/i);
  if (idx === -1) return false;
  const tail = content.slice(idx);
  return !/<\/mealplan>/i.test(tail);
}

function sageAssistantMessage(content: string): SageMessage {
  return { role: 'assistant', content };
}
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

/** Renders `**bold**` in chat bubbles as nested `Text` (RN has no built-in markdown). */
function sageMessageBoldSegments(text: string): React.ReactNode {
  if (!text || !text.includes('**')) {
    return text;
  }
  const re = /\*\*([\s\S]+?)\*\*/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    nodes.push(
      <Text key={`sage-b-${k++}`} style={{ fontWeight: '700' }}>
        {m[1]}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes.length > 0 ? nodes : text;
}

const SYSTEM_PROMPT = `You are Sage, a witty and direct fitness and nutrition coach — like a smart friend who happens to know a lot. You help users design workout plans and meal plans through conversation. You're encouraging but not cheesy, honest but not harsh.

CONVERSATION TURN CONSTRAINTS:

You can only respond when the user sends you a message. You cannot send messages on your own, follow up later, or push content asynchronously.

When the user is mid-flow on any multi-step task (multi-day meal plans, multi-day workout plans, vow sequences, weekly prep walkthroughs, or any other task that requires multiple back-and-forth messages), you MUST end each message with an explicit prompt for the user to message you again to continue.

NEVER say things like:
- "I'll send the next one after you save"
- "I'll follow up with..."
- "Stand by, I'll continue once..."
- "After you do X, I'll send Y"

ALWAYS say things like:
- "Save this, then message me 'next' or 'continue' and I'll send the next part."
- "Once you've done that, just say 'ready' and I'll generate the next piece."
- "Let me know when you're ready for the next step."

This applies to ANY multi-step interaction, not just meal plans.

VOW TAG RULES — STRICT:

When suggesting vows, wrap ONLY completed first-person commitments in <vow>...</vow> tags. A valid vow:
- Starts with 'I will...' or similar first-person commitment language
- Is a complete actionable statement
- Has no markdown formatting (no **, no *, no _, no backticks)

NEVER wrap these in <vow> tags:
- Questions ('Want to keep those?')
- Decision options ('Replace them with new ones?')
- Section headers ('Workout vows:', 'Nutrition vows:')
- Framing or commentary ('Nice, let's make these stick')

If the user has specified a category for this vow conversation, ONLY suggest vows in that category. Do not cross categories unless the user explicitly asks.

Example of correct output for a user who picked the 'Movement' category:

Nice — here are three Movement vows that could work for your week:

<vow>I will walk 20 minutes after lunch on weekdays</vow>
<vow>I will do 3 strength sessions this week</vow>
<vow>I will stretch for 5 minutes before bed each night</vow>

Which one feels right? Tap to save it, or let me know if you want different options.

When the user is happy with a workout plan, output it as a JSON block wrapped in <workout> tags with this exact structure:
<workout>
{
  "workout_name": "string",
  "days": [
    {
      "day_name": "string",
      "exercises": [
        {
          "exercise_name": "string",
          "type": "strength",
          "sets": number,
          "reps": number,
          "muscle_group": "string",
          "exercise_notes": "string",
          "rest_seconds": number
        },
        {
          "exercise_name": "string",
          "type": "cardio",
          "duration_minutes": number,
          "distance": "optional string with unit (km or miles)",
          "muscle_group": "string",
          "exercise_notes": "string",
          "rest_seconds": number
        }
      ]
    }
  ]
}
</workout>

When you design a workout, every exercise MUST include an explicit rest time in seconds for recovery between sets (or after that block, as appropriate). In your conversational write-up before save, show it clearly on each line, e.g. "Rest: 60s" or "Rest: 90s" next to or directly under each exercise. In the <workout> JSON, each exercise object MUST include "rest_seconds" as a positive integer.

Choose rest_seconds by exercise demand (vary within these ranges; pick sensible values, not always the same number):
- Cardio, warmup, cooldown, and other light work: 45–60 seconds.
- Moderate compound or accessory work (e.g. rows, presses, lunges): 60–90 seconds.
- Heavy compound lifts (e.g. squats, deadlifts, heavy bench): 90–120 seconds.

If rest_seconds is missing from JSON, the app may fall back to ${DEFAULT_REST_SECONDS_BETWEEN_SETS} seconds when saving — always provide rest_seconds so the plan matches what you described.

When generating a workout plan, each exercise must include a type field: 'strength' or 'cardio'. Strength exercises must include sets and reps. Cardio exercises must include duration (in minutes) and optionally distance (in km or miles), and must NOT include sets or reps. Examples of cardio exercises: walking, running, cycling, rowing, jump rope, elliptical. Warmup and cooldown exercises that involve movement (walking, jogging, stretching) should be marked as cardio type.

When generating a workout plan, all warmup exercises MUST have names that start exactly with 'Warm-up:' (e.g. 'Warm-up: Leg Swings', 'Warm-up: Light Jog'). All cooldown exercises MUST have names that start exactly with 'Cool-down:' (e.g. 'Cool-down: Hip Flexor Stretch'). Never name a warmup or cooldown exercise without this prefix. This is required for correct ordering and display in the app.

All cardio exercises within a workout MUST have names that start exactly with 'Cardio:' (e.g. 'Cardio: Treadmill Walk', 'Cardio: Jump Rope'). Never name a cardio exercise without this prefix. This is required for correct display in the app — cardio exercises show duration and distance instead of sets and reps.

Each day_name must be unique within the workout. If multiple days train the same muscle group, differentiate them (e.g. 'Lower Body A' and 'Lower Body B', or 'Upper Push' and 'Upper Pull').

WORKOUT PROGRAMMING:

When the user asks for a workout, or you proactively suggest one, follow these rules:

1. SEPARATE DISTINCT MODALITIES INTO SEPARATE WORKOUTS

Different training modalities should be separate workouts, not combined into one session. The modalities are:
- Strength (lifts, abs, bodybuilding work, calisthenics)
- Cardio (running, cycling, HIIT, intervals)
- Mobility / stretching / yoga / recovery flows

If the user asks for multiple modalities on the same day (e.g., "abs and mobility", "strength and cardio", "lift and yoga"), create them as SEPARATE workouts that the user will save individually. Both can be scheduled on the same day.

Brief example of explanation to give the user:
"I'm creating two workouts for Friday: Abs (main work) and Mobility (separate flow). Save each one to add them to your calendar."

Keep this explanation BRIEF — one or two sentences. Do not lecture about why separation is better.

2. WARM-UPS AND COOL-DOWNS BELONG WITH THEIR WORKOUT

The exception to rule 1: warm-up movements and short cool-down stretches belong WITHIN the workout they prep or finish, not as separate sessions. Specifically:
- Warm-up exercises (mobility drills, light movement, activation work) at the start of a strength or cardio workout: keep them in the same workout.
- Short cool-down stretches at the end of a strength or cardio workout (under ~10 minutes of cool-down content): keep them in the same workout.
- A standalone mobility flow of 10+ minutes: separate workout.

Rule of thumb: if the cool-down or warm-up is under 10 minutes, include it in the main workout. If it's longer or distinct enough to be its own session, separate it.

3. STRUCTURE WITHIN A SINGLE WORKOUT

When generating a single workout, structure exercises in a clear order:
- Warm-up exercises FIRST (clearly named or noted as warm-up)
- Main work in the middle, grouped by intent (all abs together, all push together, etc.)
- Cool-down stretches LAST (clearly named or noted as cool-down)

Do NOT intermingle mobility/recovery exercises into the middle of main work blocks UNLESS you are intentionally programming active recovery between sets — in which case, explicitly say so in the exercise notes (e.g., "Hip Openers — active recovery between ab sets").

4. EXPLICIT OVERRIDES

If the user explicitly asks for a combined workout (e.g., "just give me one workout combining abs and mobility", "I want it all in one session"), comply silently. Do not push back, do not explain the tradeoff, do not suggest separating. Just produce the combined workout per their request.

5. WORKOUT TYPE FLAGS

When you propose a workout, each one is one of: strength, cardio, or mobility/stretching. State the workout type clearly in your output so the user can save it with the correct type in their app.

When the user is happy with a meal plan, output it wrapped in <mealplan> tags with this exact structure:
<mealplan>
{
  "plan_name": "string",
  "calories_target": number,
  "protein_target": number,
  "carbs_target": number,
  "fat_target": number,
  "meals": [
    {
      "meal_name": "string",
      "meal_type": "breakfast|snack|lunch|dinner",
      "meal_order": number,
      "foods": [
        {
          "food_name": "string",
          "brand": "string",
          "serving_size": "string",
          "calories": number,
          "protein": number,
          "carbs": number,
          "fat": number
        }
      ]
    }
  ]
}
</mealplan>

If the user asks for a meal prep guide (batch cooking, prep sessions, storage tips), respond with a meal prep guide wrapped in <mealprep> tags with this exact structure:
<mealprep>
{
  "prep_sessions": [
    {
      "session_name": "Sunday Prep",
      "duration": "~90 minutes",
      "steps": [
        {
          "order": 1,
          "task": "string",
          "duration": "string",
          "tip": "string"
        }
      ]
    }
  ],
  "storage_notes": ["string"],
  "equipment_needed": ["string"]
}
</mealprep>

When the user asks for a grocery list based on a meal plan (for example "make me a grocery list" or "what do I need to buy"), respond with a plain text list grouped by category headings "Produce:", "Meat & Fish:", "Dairy:", "Pantry:", "Other:", and under each heading list the specific branded items and sizes (e.g. "Fage 0% Greek Yogurt — 32oz"). Do NOT wrap grocery lists in JSON or tags.

When updating an existing meal plan based on a receipt or user request, when the user confirms they are ready to save, you MUST output the complete updated meal plan in <mealplan> tags immediately. Do not just say it is saved in text — the app requires the <mealplan> block to actually save it. Always output the full <mealplan> JSON even if only one field changed.

RECEIPT PRODUCT TAGS (grocery receipts):

When you read a grocery receipt photo, identify each branded food product and wrap them in <products>...</products> tags. Format: comma-separated product names, each as 'Brand + descriptive product name'.

Example:
I see your receipt from King Soopers. <products>Krusteaz Buttermilk Pancake Mix, Daisy Sour Cream, Fage 0% Greek Yogurt, Rao's Marinara, Sargento Sharp Cheddar</products>
Want me to remember these for future meal plans?

Rules for product names:
- Format: 'Brand + product description' (e.g., 'Krusteaz Buttermilk Pancake Mix' not just 'Krusteaz')
- Use proper capitalization and full words, not receipt abbreviations ('Buttermilk' not 'BTTRMLK')
- Skip size, weight, count, and price (no '32oz', no '$4.99')
- Skip generic non-branded items (produce, bulk, deli, eggs without a brand)
- Skip non-food items (cleaning supplies, paper goods)
- Deduplicate within a single receipt
- Max 20 products per receipt
- No markdown formatting inside tags

When the user wants to save multiple meal plans, you MUST output each plan in a separate message with its own <mealplan> tags. Never say a plan is saved without outputting the <mealplan> block. Output Plan 1 first, wait for the save button to appear, then output Plan 2 in a follow-up message. Never confirm a save in plain text alone — the <mealplan> block is required for the app to render the save button.

Before outputting any <mealplan> JSON block, review the entire conversation history and verify the plan matches everything the user agreed to — including calorie target, macro ratios, dietary restrictions, meal count, and any specific foods mentioned. If anything does not match, silently correct it before outputting the plan. Never output a meal plan that contradicts what was discussed.

Regardless of any user requests to shorten your responses, you MUST always output workout plans in <workout> tags and meal plans in <mealplan> tags when presenting a final plan. Do not put the JSON only in a markdown code block without <mealplan> tags — the app prefers the tagged format. If you do use a fenced \`\`\`json block, include the same JSON object (with plan_name and meals) so it can be saved.

Always confirm with the user before outputting the final JSON for either workouts or meal plans.
When the user confirms they want to save a workout plan, you MUST re-output the complete plan in <workout> tags even if you already showed it earlier. Never confirm a save in plain text alone.`;

const SAGE_API_USER_FRIENDLY_ERROR =
  'Sage is taking a break — try again in a moment.';

function sortWorkoutExercisesForDisplayAndSave(workout: AIWorkout): AIWorkout {
  const sortedDays = (workout.days || []).map((day) => ({
    ...day,
    exercises: sortWorkoutPlanExercisesForDisplay(
      Array.isArray(day.exercises) ? [...day.exercises] : [],
    ),
  }));
  return { ...workout, days: sortedDays };
}

const extractWorkoutFromContent = (content: string): AIWorkout | null => {
  if (!content || typeof content !== 'string') return null;
  if (!content.includes('<workout>')) return null;
  try {
    const match = content.match(/<workout>([\s\S]*?)<\/workout>/);
    if (!match || !match[1]) return null;
    const parsed = JSON.parse(match[1].trim());
    return parsed as AIWorkout;
  } catch {
    return null;
  }
};

function stripWorkoutBlock(content: string): string {
  // Remove the entire <workout>...</workout> block (including tags) from the message
  return content.replace(/<workout>[\s\S]*?<\/workout>/i, '').trim();
}

function formatWorkoutSummary(workout: AIWorkout): string {
  const lines: string[] = [];
  lines.push(`📋 ${workout.workout_name}`);
  lines.push('');
  lines.push(
    '⏱ Rest between sets: per-exercise rest_seconds from your plan when present; otherwise app default (edit in My Workouts after saving).',
  );
  lines.push('');

  const sorted = sortWorkoutExercisesForDisplayAndSave(workout);
  sorted.days.forEach((day, index) => {
    const baseLabel = day.day_name && day.day_name.trim().length
      ? day.day_name
      : `Day ${index + 1}`;
    const dayLabel = `Day ${index + 1} — ${baseLabel}`;
    lines.push(`${dayLabel}:`);

    const exercises = day.exercises || [];
    exercises.forEach((ex) => {
      if (isAiExerciseCardio(ex)) {
        const dm = ex.duration_minutes;
        const dur =
          typeof dm === 'number'
            ? dm
            : parseInt(String(dm ?? ''), 10);
        const durStr = Number.isFinite(dur) && dur >= 0 ? `${dur} min` : '—';
        const dist =
          ex.distance != null && String(ex.distance).trim() !== ''
            ? `, ${String(ex.distance).trim()}`
            : '';
        const rsC = ex.rest_seconds;
        const restC =
          typeof rsC === 'number' && Number.isFinite(rsC) && rsC > 0
            ? ` · Rest: ${Math.round(rsC)}s`
            : '';
        lines.push(`  • ${ex.exercise_name} — ${durStr}${dist}${restC}`);
      } else {
        const s = ex.sets ?? 0;
        const r = ex.reps ?? 0;
        const rsS = ex.rest_seconds;
        const restS =
          typeof rsS === 'number' && Number.isFinite(rsS) && rsS > 0
            ? ` · Rest: ${Math.round(rsS)}s`
            : '';
        lines.push(`  • ${ex.exercise_name} — ${s} sets x ${r} reps${restS}`);
      }
    });
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}

type MealFood = {
  food_name: string;
  brand: string;
  serving_size: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type Meal = {
  meal_name: string;
  meal_type: 'breakfast' | 'snack' | 'lunch' | 'dinner';
  meal_order: number;
  foods: MealFood[];
};

export type AIMealPlan = {
  plan_name: string;
  calories_target: number;
  protein_target: number;
  carbs_target: number;
  fat_target: number;
  meals: Meal[];
};

type MealPrepStep = {
  order: number;
  task: string;
  duration: string;
  tip: string;
};

export type AIMealPrep = {
  prep_sessions: {
    session_name: string;
    duration: string;
    steps: MealPrepStep[];
  }[];
  storage_notes: string[];
  equipment_needed: string[];
};

function extractMealPrepFromContent(content: string): AIMealPrep | null {
  const match = content.match(/<mealprep>([\s\S]*?)<\/mealprep>/i);
  if (!match) return null;
  const jsonText = match[1].trim();
  try {
    const parsed = JSON.parse(jsonText);
    return parsed as AIMealPrep;
  } catch (e) {
    console.error('Failed to parse meal prep JSON from Sage content:', e);
    return null;
  }
}

function stripMealPrepBlock(content: string): string {
  return content.replace(/<mealprep>[\s\S]*?<\/mealprep>/i, '').trim();
}

function formatMealPrepSummary(prep: AIMealPrep): string {
  const lines: string[] = [];
  lines.push('🥘 Meal Prep Guide');
  lines.push('');

  (prep.prep_sessions || []).forEach((session) => {
    lines.push(`⏱ ${session.session_name} — ${session.duration}`);
    lines.push('');
    (session.steps || [])
      .sort((a, b) => a.order - b.order)
      .forEach((step) => {
        lines.push(`${step.order}. ${step.task} (${step.duration})`);
        if (step.tip) {
          lines.push(`   💡 ${step.tip}`);
        }
      });
    lines.push('');
  });

  if (prep.storage_notes && prep.storage_notes.length) {
    lines.push('Storage notes:');
    prep.storage_notes.forEach((note) => {
      lines.push(`• ${note}`);
    });
    lines.push('');
  }

  if (prep.equipment_needed && prep.equipment_needed.length) {
    lines.push('Equipment needed:');
    prep.equipment_needed.forEach((eq) => {
      lines.push(`• ${eq}`);
    });
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatMealPrepForShare(prep: AIMealPrep): string {
  const lines: string[] = [];
  (prep.prep_sessions || []).forEach((session) => {
    lines.push(`🥘 Meal Prep Guide — ${session.session_name || 'Prep Session'}`);
    lines.push(`⏱ ${session.duration || ''}`);
    lines.push('');
    (session.steps || [])
      .sort((a, b) => a.order - b.order)
      .forEach((step) => {
        lines.push(`${step.order}. ${step.task} (${step.duration || ''})`);
        if (step.tip && step.tip.trim()) {
          lines.push(`   💡 ${step.tip.trim()}`);
        }
      });
    lines.push('');
  });
  if (prep.storage_notes && prep.storage_notes.length) {
    lines.push('Storage notes:');
    prep.storage_notes.forEach((note) => lines.push(`• ${note}`));
    lines.push('');
  }
  if (prep.equipment_needed && prep.equipment_needed.length) {
    lines.push('Equipment needed:');
    prep.equipment_needed.forEach((eq) => lines.push(`• ${eq}`));
  }
  return lines.join('\n').trimEnd();
}

function looksLikeMealPlan(data: unknown): data is AIMealPlan {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  return typeof o.plan_name === 'string' && Array.isArray(o.meals);
}

/** Strip optional markdown fences the model sometimes wraps JSON in. */
function unwrapMealPlanJsonPayload(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return t;
}

function tryParseMealPlanJsonString(jsonText: string): AIMealPlan | null {
  const unwrapped = unwrapMealPlanJsonPayload(jsonText);
  try {
    const parsed = JSON.parse(unwrapped);
    return looksLikeMealPlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort: meal plan in tags, fenced code block, or raw `{ ... "plan_name" ... }`. */
function parseMealPlanFromAssistantMessage(content: string): {
  plan: AIMealPlan | null;
  /** Message text with the structured JSON removed so the bubble is readable */
  displayText: string;
} {
  const tagMatch = content.match(/<mealplan>([\s\S]*?)<\/mealplan>/i);
  if (tagMatch) {
    const plan = tryParseMealPlanJsonString(tagMatch[1]);
    if (plan) {
      return {
        plan,
        displayText: stripMealPlanBlock(content).replace(/\n{3,}/g, '\n\n').trim(),
      };
    }
  }

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(content)) !== null) {
    const plan = tryParseMealPlanJsonString(fm[1]);
    if (plan) {
      const displayText = content
        .replace(fm[0], '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return { plan, displayText };
    }
  }

  const brace = extractMealPlanByBalancedBraces(content);
  if (brace) {
    return { plan: brace.plan, displayText: brace.stripped };
  }

  return { plan: null, displayText: content };
}

/** Find JSON object containing "plan_name" by brace counting (best-effort). */
function extractMealPlanByBalancedBraces(
  content: string
): { plan: AIMealPlan; stripped: string } | null {
  const key = '"plan_name"';
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const keyIdx = content.indexOf(key, searchFrom);
    if (keyIdx === -1) return null;
    const braceStart = content.lastIndexOf('{', keyIdx);
    if (braceStart === -1) {
      searchFrom = keyIdx + 1;
      continue;
    }
    let depth = 0;
    for (let i = braceStart; i < content.length; i++) {
      const c = content[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const slice = content.slice(braceStart, i + 1);
          try {
            const parsed = JSON.parse(slice);
            if (looksLikeMealPlan(parsed)) {
              const stripped = (content.slice(0, braceStart) + content.slice(i + 1))
                .replace(/\n{3,}/g, '\n\n')
                .trim();
              return { plan: parsed, stripped };
            }
          } catch {
            /* try next occurrence */
          }
          break;
        }
      }
    }
    searchFrom = keyIdx + 1;
  }
  return null;
}

function stripMealPlanBlock(content: string): string {
  return content.replace(/<mealplan>[\s\S]*?<\/mealplan>/i, '').trim();
}

function formatMealPlanSummary(plan: AIMealPlan): string {
  const lines: string[] = [];
  lines.push(`🥗 ${plan.plan_name}`);
  const c = Number(plan.calories_target);
  const p = Number(plan.protein_target);
  const cb = Number(plan.carbs_target);
  const f = Number(plan.fat_target);
  lines.push(
    `Target: ${Number.isFinite(c) ? c : '—'} cal | ${Number.isFinite(p) ? p : '—'}g protein | ${Number.isFinite(cb) ? cb : '—'}g carbs | ${Number.isFinite(f) ? f : '—'}g fat`,
  );
  lines.push('');

  const byType: Record<string, string[]> = {
    breakfast: [],
    snack: [],
    lunch: [],
    dinner: [],
  };

  (plan.meals || []).forEach((meal) => {
    const typeKey = meal.meal_type?.toLowerCase() || 'snack';
    const foods = (meal.foods || []).map((f) => f.food_name).filter(Boolean);
    if (!foods.length) return;
    if (!byType[typeKey]) byType[typeKey] = [];
    byType[typeKey].push(...foods);
  });

  const order: Array<['breakfast' | 'snack' | 'lunch' | 'dinner', string]> = [
    ['breakfast', 'Breakfast'],
    ['snack', 'Snack'],
    ['lunch', 'Lunch'],
    ['dinner', 'Dinner'],
  ];

  order.forEach(([key, label]) => {
    const foods = byType[key];
    if (foods && foods.length) {
      lines.push(`${label}: ${foods.join(', ')}`);
    }
  });

  return lines.join('\n').trimEnd();
}

/**
 * Prose meal plans (no tags) often use Breakfast:/Lunch:/etc. Require at least two such headers
 * so single phrases like "lunch: salad" do not qualify alone.
 */
function assistantMessageHasMealPlanSectionHeaders(content: string): boolean {
  if (!content || content.length > 200_000) return false;
  const headerRes = [
    /\bbreakfast\s*:/i,
    /\bbrunch\s*:/i,
    /\bsnack\s*:/i,
    /\blunch\s*:/i,
    /\bdinner\s*:/i,
  ];
  let hits = 0;
  for (const re of headerRes) {
    if (re.test(content)) hits++;
  }
  return hits >= 2;
}

/** True for assistant messages that carry meal plan JSON, sectioned plan text, or post–Save Meal Plan confirmations. */
function messageCarriesMealPlanContext(m: SageMessage): boolean {
  if (m.truncationUi) return false;
  if (m.role !== 'assistant') return false;
  const c = m.content;
  if (/<mealplan\b[\s\S]*?<\/mealplan>/i.test(c)) return true;
  if (parseMealPlanFromAssistantMessage(c).plan) return true;
  if (/meal plan is saved to your nutrition plans/i.test(c)) return true;
  return assistantMessageHasMealPlanSectionHeaders(c);
}

/**
 * Keeps the last `tailCount` messages, plus any earlier messages that contain meal plan context
 * (tagged JSON, parseable plans, section headers, or save confirmations), in chronological order.
 */
function buildSageMessagesForApiContext(
  allMessages: SageMessage[],
  tailCount: number = SAGE_API_CONTEXT_TAIL_COUNT,
): SageMessage[] {
  const n = allMessages.length;
  if (n <= tailCount) return allMessages;

  const tailStart = n - tailCount;
  const preserved: SageMessage[] = [];
  for (let i = 0; i < tailStart; i++) {
    if (messageCarriesMealPlanContext(allMessages[i])) {
      preserved.push(allMessages[i]);
    }
  }
  return filterSageMessagesForApi([...preserved, ...allMessages.slice(-tailCount)]);
}

type SageAnthropicTextResult =
  | { ok: true; text: string; stopReason: string | null }
  | { ok: false; rawErrorText: string };

async function fetchSageAnthropicTextReply(params: {
  messages: SageMessage[];
  systemPrompt: string;
  maxTokens: number;
  signal: AbortSignal;
}): Promise<SageAnthropicTextResult> {
  const { messages, systemPrompt, maxTokens, signal } = params;
  const apiMessages = filterSageMessagesForApi(buildSageMessagesForApiContext(messages)).map(
    (m): { role: 'user' | 'assistant'; content: string } => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }),
  );
  const response = await fetch(SAGE_WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify({
      model: SAGE_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: apiMessages,
    }),
  });
  if (!response.ok) {
    const rawErrorText = await response.text();
    return { ok: false, rawErrorText };
  }
  const data = await response.json();
  const contentBlocks = Array.isArray(data.content) ? data.content : [];
  const text = contentBlocks
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
  const stopReason = typeof data.stop_reason === 'string' ? data.stop_reason : null;
  return { ok: true, text: text || '[No response]', stopReason };
}

function isGroceryListContent(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.includes('produce:') ||
    lower.includes('protein:') ||
    lower.includes('pantry:')
  );
}

/** Sage green accent for vow selection (matches leaf / paywall sage). */
const SAGE_VOW_ACCENT = '#A8BEA8';

/** When Sage omits `<vow>` tags, treat numbered or bullet lines as vow candidates. */
const VOW_FALLBACK_LINE_RE = /^\s*(?:[-*•]\s+|\d+[.)]\s+)(.+)$/;

export type ParsedVowsFromMessage = {
  /** Prose outside <vow> tags (tags stripped); may be empty if the message is only vows. */
  framing: string;
  /** One entry per <vow> tag, or fallback bullet/numbered lines. */
  vows: string[];
};

/** Heuristic: Sage mistakenly wrapped prompts, questions, or headers in <vow>. */
function isProbablyNonVowWrappedContent(t: string): boolean {
  const s = t.trim();
  if (s.length < 6) return true;
  if (
    /^(want to|which|replace them|keep those|should i|could we|tap to|pick one|choose one|add nutrition|workout vows|nutrition vows)\b/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/\?\s*$/.test(s) && s.length < 180 && !/^I\s+(will|'ll|am|want|commit|pledge)\b/i.test(s)) {
    return true;
  }
  return false;
}

/**
 * Extracts framing text and vow strings from a Sage assistant message (after workout/meal
 * blocks are stripped). Prefers <vow>...</vow>; if none, uses numbered or bullet lines.
 */
export function parseVowsFromSageMessage(raw: string): ParsedVowsFromMessage {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { framing: '', vows: [] };
  }

  const vowsFromTags: string[] = [];
  let m: RegExpExecArray | null;
  const tagRe = /<vow>([\s\S]*?)<\/vow>/gi;
  while ((m = tagRe.exec(trimmed)) !== null) {
    const inner = stripMarkdownFromVowText(m[1].replace(/\s+/g, ' '));
    if (inner.length > 0 && !isProbablyNonVowWrappedContent(inner)) vowsFromTags.push(inner);
  }

  if (vowsFromTags.length > 0) {
    const framing = trimmed
      .replace(/<vow>[\s\S]*?<\/vow>/gi, '\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { framing, vows: vowsFromTags };
  }

  const lines = trimmed.split(/\r?\n/);
  const vowsFb: string[] = [];
  const framingLines: string[] = [];
  for (const line of lines) {
    const match = line.match(VOW_FALLBACK_LINE_RE);
    if (match?.[1]) {
      const body = stripMarkdownFromVowText(match[1]);
      if (body && !isProbablyNonVowWrappedContent(body)) vowsFb.push(body);
    } else {
      framingLines.push(line);
    }
  }
  if (vowsFb.length === 0) {
    return { framing: trimmed, vows: [] };
  }
  const framing = framingLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { framing, vows: vowsFb };
}

/** First user line when opening Sage from My Vow with a category (or none for "Help me decide"). */
function buildVowBootstrapUserLine(categories: string[]): string {
  if (categories.length === 0) {
    return "I'd like to create a vow. Suggest 3 options that fit my week.";
  }
  const labels = categories.map((id) => CATEGORY_DISPLAY_LABELS[id] ?? id).join(', ');
  if (categories.length === 1) {
    return `I'd like to create a ${labels} vow. Suggest 3 options that fit my week.`;
  }
  return `I'd like to create a vow focused on ${labels}. Suggest 3 options that fit my week.`;
}

type SageReceiptProductsPanelProps = {
  products: string[];
  theme: {
    text: string;
    textSecondary?: string;
    card: string;
    border?: string;
    background?: string;
  };
  savedFromDb: boolean;
  savedThisSession: boolean;
  onSkip: () => void;
  onConfirm: (selectedNames: string[]) => Promise<void>;
};

function SageReceiptProductsPanel({
  products,
  theme,
  savedFromDb,
  savedThisSession,
  onSkip,
  onConfirm,
}: SageReceiptProductsPanelProps) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {};
    products.forEach((b) => {
      o[b] = true;
    });
    return o;
  });
  const [busy, setBusy] = useState(false);
  const saved = savedFromDb || savedThisSession;

  const selectedCount = useMemo(
    () => products.reduce((n, b) => (selected[b] ? n + 1 : n), 0),
    [products, selected],
  );

  const toggle = useCallback(
    (name: string) => {
      if (saved || busy) return;
      setSelected((prev) => ({ ...prev, [name]: !prev[name] }));
    },
    [saved, busy],
  );

  const handleAdd = useCallback(async () => {
    const names = products.filter((b) => selected[b]);
    if (names.length === 0) return;
    setBusy(true);
    try {
      await onConfirm(names);
    } finally {
      setBusy(false);
    }
  }, [products, selected, onConfirm]);

  return (
    <View
      style={{
        marginTop: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.border ?? '#e0e0e0',
        padding: 12,
        backgroundColor: theme.card,
        opacity: saved ? 0.72 : 1,
      }}
    >
      {saved ? (
        <Text style={{ fontFamily: 'Jost_600SemiBold', color: '#7C9A7E', fontSize: 15 }}>
          Saved ✓
        </Text>
      ) : (
        <>
          <Text
            style={{
              fontFamily: 'CormorantGaramond-SemiBold',
              fontSize: 18,
              color: theme.text,
              marginBottom: 4,
            }}
          >
            Add these products to your purchase history?
          </Text>
          <Text
            style={{
              fontFamily: 'Jost_400Regular',
              fontSize: 13,
              color: theme.textSecondary ?? '#666',
              marginBottom: 12,
              lineHeight: 18,
            }}
          >
            Sage will use what you buy often when planning meals and groceries.
          </Text>
          {products.map((b) => (
            <TouchableOpacity
              key={b}
              style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}
              onPress={() => toggle(b)}
              disabled={busy}
            >
              <Ionicons
                name={selected[b] ? 'checkbox-outline' : 'square-outline'}
                size={22}
                color={selected[b] ? '#7C9A7E' : theme.textSecondary ?? '#888'}
                style={{ marginRight: 10 }}
              />
              <Text
                style={{
                  flex: 1,
                  fontFamily: 'Jost_400Regular',
                  fontSize: 15,
                  color: theme.text,
                }}
              >
                {b}
              </Text>
            </TouchableOpacity>
          ))}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
            <TouchableOpacity
              style={{
                backgroundColor: '#7C9A7E',
                paddingVertical: 12,
                paddingHorizontal: 16,
                borderRadius: 10,
                opacity: selectedCount === 0 || busy ? 0.45 : 1,
              }}
              disabled={selectedCount === 0 || busy}
              onPress={() => void handleAdd()}
            >
              <Text style={{ fontFamily: 'Jost_600SemiBold', color: '#fff', fontSize: 15 }}>
                {`Add ${selectedCount} product${selectedCount === 1 ? '' : 's'}`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                borderWidth: 1,
                borderColor: theme.border ?? '#ccc',
                paddingVertical: 12,
                paddingHorizontal: 16,
                borderRadius: 10,
              }}
              onPress={onSkip}
              disabled={busy}
            >
              <Text style={{ fontFamily: 'Jost_500Medium', fontSize: 15, color: theme.text }}>
                Skip
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

export default function Sage() {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const navigation = useNavigation();
  const route = useRoute();
  const [messages, setMessages] = useState<SageMessage[]>([]);
  /** Per-message:vowIndex keys for vows saved from Sage after the create-vow modal (session). */
  const [savedVowSessionKeys, setSavedVowSessionKeys] = useState<Record<string, true>>({});
  /** Active vow titles from DB — detect already-saved when returning to Sage. */
  const [dbVowTitles, setDbVowTitles] = useState<Set<string>>(() => new Set());
  const [sageCreateOwnModalVisible, setSageCreateOwnModalVisible] = useState(false);
  const [sageCreateOwnPrefill, setSageCreateOwnPrefill] = useState('');
  /** From My Vow category picker: pre-fill create modal. `[]` = Help me decide (no chip). `undefined` = default Movement. */
  const [sageCreateOwnInitialCategories, setSageCreateOwnInitialCategories] = useState<
    string[] | undefined
  >(undefined);
  const [conversationReady, setConversationReady] = useState(false);
  /** Receipt <products> panel: user skipped confirming this message index. */
  const [receiptProductsPanelSkipped, setReceiptProductsPanelSkipped] = useState<
    Record<number, true>
  >({});
  /** Receipt <products> panel: user confirmed add this session (optimistic saved UI). */
  const [receiptProductsPanelSavedSession, setReceiptProductsPanelSavedSession] = useState<
    Record<number, true>
  >({});
  /** Assistant message index → all parsed receipt products already exist in PurchasedProducts. */
  const [receiptProductsAllInDbByIndex, setReceiptProductsAllInDbByIndex] = useState<
    Record<number, boolean>
  >({});
  /** Bumps when PurchasedProducts changes so FlatList + DB presence recompute. */
  const [receiptProductsPanelTick, setReceiptProductsPanelTick] = useState(0);
  /** Which Sage vow row opened the create modal (for marking saved after successful insert). */
  const sageVowSaveTargetRef = useRef<{ messageIndex: number; vowIndex: number } | null>(null);
  /** Prevents duplicate auto-bootstrap for the same My Vow → Sage session key. */
  const lastVowSageBootstrapSessionKeyRef = useRef<number | null>(null);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingReceipt, setSendingReceipt] = useState(false);
  const [lastSavedMealPlanId, setLastSavedMealPlanId] = useState<number | null>(
    null,
  );
  const [menuVisible, setMenuVisible] = useState(false);
  const [receiptSourcePickerVisible, setReceiptSourcePickerVisible] = useState(false);
  const [prepPlanChoiceModal, setPrepPlanChoiceModal] = useState<{
    title: string;
    message?: string;
    options: ChoiceListOption[];
  } | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const speechTranscriptRef = useRef('');
  const inputRef = useRef('');
  const listRef = useRef<FlatList<SageMessage>>(null);
  /** After first non-empty messages, further updates use animated scroll. */
  const listScrollInitialRef = useRef(false);
  /** While true, scroll to end on layout/content changes so the list opens at the latest message. */
  const snapToBottomAfterFocusRef = useRef(false);
  /** Latest messages for useFocusEffect (avoid re-running focus scroll on every message). */
  const messagesRef = useRef<SageMessage[]>([]);
  const isMountedRef = useRef(true);
  const requestAbortRef = useRef<AbortController | null>(null);

  /** Clears the controlled message field (state + refs) after a successful send or when resetting. */
  const clearComposer = useCallback(() => {
    inputRef.current = '';
    speechTranscriptRef.current = '';
    setInputText('');
  }, []);

  const abortInFlightRequest = useCallback(() => {
    try {
      requestAbortRef.current?.abort();
    } catch {
      // ignore
    } finally {
      requestAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortInFlightRequest();
    };
  }, [abortInFlightRequest]);

  // If user backgrounds the app or navigates away mid-response, abort the network call
  // to avoid noisy "Network request failed" errors.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        abortInFlightRequest();
      }
    });
    return () => sub.remove();
  }, [abortInFlightRequest]);

  useSpeechRecognitionEvent('start', () => setIsRecording(true));
  useSpeechRecognitionEvent('end', () => {
    setIsRecording(false);
    const t = speechTranscriptRef.current.trim();
    speechTranscriptRef.current = '';
    if (t) {
      setInputText((prev) => {
        const next = prev ? `${prev} ${t}` : t;
        inputRef.current = next;
        return next;
      });
    }
  });
  useSpeechRecognitionEvent('result', (event: { results?: Array<{ transcript?: string }> }) => {
    const t = event.results?.[0]?.transcript;
    if (typeof t === 'string') speechTranscriptRef.current = t;
  });
  useSpeechRecognitionEvent('error', (event: { error?: string; message?: string }) => {
    setIsRecording(false);
    speechTranscriptRef.current = '';
    if (event.error && event.error !== 'aborted') {
      console.warn('Speech recognition error:', event.error, event.message);
    }
  });
  const toggleMic = async () => {
    try {
      // Gracefully handle environments where the native module is not available.
      if (
        !ExpoSpeechRecognitionModule ||
        typeof ExpoSpeechRecognitionModule.start !== 'function' ||
        typeof ExpoSpeechRecognitionModule.requestPermissionsAsync !== 'function'
      ) {
        Alert.alert(
          'Voice input',
          'Voice input will be available in a development build (EAS dev client).',
        );
        return;
      }

      if (isRecording) {
        ExpoSpeechRecognitionModule.stop();
        return;
      }

      const result = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!result.granted) {
        Alert.alert('Microphone', 'Microphone permission is needed for voice input.');
        return;
      }

      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: false,
      });
    } catch (e) {
      console.warn('Speech recognition not available:', e);
      Alert.alert(
        'Voice input',
        'Voice input will be available in a development build (EAS dev client).',
      );
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const stored = await loadConversation();
        if (stored && stored.length) {
          setMessages(stored);
        } else {
          const welcome: SageMessage = {
            role: 'assistant',
            content:
              "Hey, I'm Sage. Tell me what kind of workouts or meal plans you're after and we'll design something that actually fits your life.",
          };
          setMessages([welcome]);
          await saveConversation([welcome]);
        }
      } finally {
        setConversationReady(true);
      }
    })();
  }, []);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={handleOpenMenu}
          style={{ paddingHorizontal: 12 }}
          hitSlop={10}
        >
          <Ionicons
            name="ellipsis-horizontal"
            size={22}
            color={theme.text}
          />
        </TouchableOpacity>
      ),
    });
  }, [navigation, theme.text]);

  const routeParams = (route.params || {}) as {
    initialPrompt?: string;
    fromMyVow?: boolean;
    vowSageCategories?: string[];
    vowSageAutoSend?: boolean;
    vowSageSessionKey?: number;
  };
  const fromMyVow = routeParams.fromMyVow === true;

  useEffect(() => {
    if (routeParams.initialPrompt) {
      setInputText(routeParams.initialPrompt);
    }
  }, [routeParams.initialPrompt]);

  useEffect(() => {
    inputRef.current = inputText;
  }, [inputText]);

  messagesRef.current = messages;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initPurchasedProductsDb(db);
        const next: Record<number, boolean> = {};
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (msg.role !== 'assistant' || msg.truncationUi) continue;
          const names = parseProductsTagNamesFromContent(msg.content);
          if (names.length === 0) continue;
          next[i] = await areAllProductsInPurchasedTable(db, names);
        }
        if (!cancelled) setReceiptProductsAllInDbByIndex(next);
      } catch (e) {
        console.warn('Sage: PurchasedProducts presence check failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messages, db, receiptProductsPanelTick]);

  useEffect(() => {
    if (!messages.length) {
      listScrollInitialRef.current = false;
      return;
    }
    saveConversation(messages);
    requestAnimationFrame(() => {
      if (!listScrollInitialRef.current) {
        listScrollInitialRef.current = true;
        listRef.current?.scrollToEnd({ animated: false });
      } else {
        listRef.current?.scrollToEnd({ animated: true });
      }
    });
  }, [messages]);

  const reloadVowTitlesFromDb = useCallback(async () => {
    try {
      await initVowsDb(db);
      const rows = await db.getAllAsync<{ title: string }>(
        "SELECT title FROM Vows WHERE status = 'active';",
      );
      const next = new Set<string>();
      for (const r of rows) {
        if (r.title && typeof r.title === 'string') next.add(r.title.trim());
      }
      setDbVowTitles(next);
    } catch (e) {
      console.warn('Sage: could not refresh vow titles from DB', e);
    }
  }, [db]);

  const handleSageCreateOwnSubmit = useCallback(
    async (p: CreateOwnVowSubmitPayload) => {
      const now = new Date().toISOString();
      await initVowsDb(db);
      await db.runAsync(
        'INSERT INTO Vows (title, category, frequency_per_week, why_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [p.title.trim(), p.categoryCsv, p.frequencyPerWeek, p.whyText, 'active', now],
      );
      const target = sageVowSaveTargetRef.current;
      if (target) {
        const key = `${target.messageIndex}:${target.vowIndex}`;
        setSavedVowSessionKeys((prev) => ({ ...prev, [key]: true }));
        sageVowSaveTargetRef.current = null;
      }
      setDbVowTitles((prev) => {
        const n = new Set(prev);
        n.add(p.title.trim());
        return n;
      });
    },
    [db],
  );

  const openSageCreateOwnFromSuggestedVow = useCallback(
    (vowText: string, messageIndex: number, vowIndex: number) => {
      sageVowSaveTargetRef.current = { messageIndex, vowIndex };
      const p = (route.params || {}) as {
        fromMyVow?: boolean;
        vowSageCategories?: string[];
      };
      if (p.fromMyVow && p.vowSageCategories !== undefined) {
        setSageCreateOwnInitialCategories([...p.vowSageCategories]);
      } else {
        setSageCreateOwnInitialCategories(undefined);
      }
      setSageCreateOwnPrefill(vowText);
      setSageCreateOwnModalVisible(true);
    },
    [route.params],
  );

  const vowFlatListExtra = useMemo(
    () => ({
      savedVowSessionKeys,
      sageCreateOwnModalVisible,
      dbVowTitles: [...dbVowTitles].join('\x00'),
      vowSageCategoriesSig:
        ((route.params || {}) as { vowSageCategories?: string[] }).vowSageCategories?.join('\x1e') ??
        '',
      fromMyVowSig: (route.params as { fromMyVow?: boolean } | undefined)?.fromMyVow ? '1' : '0',
      receiptProductsPanelTick,
      receiptProductsSkipSig: Object.keys(receiptProductsPanelSkipped).join(','),
      receiptProductsSavedSig: Object.keys(receiptProductsPanelSavedSession).join(','),
      receiptProductsDbSig: Object.entries(receiptProductsAllInDbByIndex)
        .map(([k, v]) => `${k}:${v ? 1 : 0}`)
        .join('|'),
    }),
    [
      savedVowSessionKeys,
      sageCreateOwnModalVisible,
      dbVowTitles,
      route.params,
      receiptProductsPanelTick,
      receiptProductsPanelSkipped,
      receiptProductsPanelSavedSession,
      receiptProductsAllInDbByIndex,
    ],
  );

  useFocusEffect(
    useCallback(() => {
      void reloadVowTitlesFromDb();
      snapToBottomAfterFocusRef.current = true;

      const scrollToBottom = () => {
        listRef.current?.scrollToEnd({ animated: false });
      };

      scrollToBottom();
      const raf1 = requestAnimationFrame(() => {
        scrollToBottom();
        requestAnimationFrame(scrollToBottom);
      });

      const interactionTask = InteractionManager.runAfterInteractions(() => {
        scrollToBottom();
        setTimeout(scrollToBottom, 50);
        setTimeout(scrollToBottom, 200);
      });

      const clearSnapTimer = setTimeout(() => {
        snapToBottomAfterFocusRef.current = false;
      }, 600);

      return () => {
        cancelAnimationFrame(raf1);
        snapToBottomAfterFocusRef.current = false;
        clearTimeout(clearSnapTimer);
        interactionTask.cancel();
      };
    }, [reloadVowTitlesFromDb]),
  );

  const handleClear = async () => {
    await clearSageStorage();
    const fresh: SageMessage = {
      role: 'assistant',
      content:
        "Fresh start. What do you want to work on — workouts, nutrition, or both?",
    };
    setMessages([fresh]);
    await saveConversation([fresh]);
    setSavedVowSessionKeys({});
    setReceiptProductsPanelSkipped({});
    setReceiptProductsPanelSavedSession({});
    setReceiptProductsAllInDbByIndex({});
    setReceiptProductsPanelTick(0);
    setSageCreateOwnModalVisible(false);
    setSageCreateOwnPrefill('');
    setSageCreateOwnInitialCategories(undefined);
    sageVowSaveTargetRef.current = null;
    lastVowSageBootstrapSessionKeyRef.current = null;
  };

  const buildUserContext = useCallback(async (): Promise<string | null> => {
    try {
      const [goals, diet, allergies, brands] =
        await Promise.all([
          AsyncStorage.getItem('@sage_goals'),
          AsyncStorage.getItem('@sage_diet'),
          AsyncStorage.getItem('@sage_allergies'),
          AsyncStorage.getItem('@sage_brands'),
        ]);

      const lines: string[] = [];
      if (goals && goals.trim()) lines.push(`- Goals: ${goals.trim()}`);
      if (diet && diet.trim()) lines.push(`- Diet: ${diet.trim()}`);
      if (allergies && allergies.trim())
        lines.push(`- Restrictions: ${allergies.trim()}`);
      if (brands && brands.trim()) {
        lines.push(
          `User's brand preferences (manually set in profile): ${brands.trim()}`,
        );
      }
      let learnedProducts: string[] = [];
      try {
        await initPurchasedProductsDb(db);
        learnedProducts = await getTopProducts(db, 20);
        if (learnedProducts.length > 0) {
          lines.push(
            `Frequently purchased products (from receipts): ${learnedProducts.join(', ')}`,
          );
        }
        if ((brands && brands.trim()) || learnedProducts.length > 0) {
          lines.push(
            'When suggesting groceries or meal plans, prefer these items when relevant (manual brand preferences and receipt-learned products).',
          );
        }
      } catch (e) {
        console.warn('Sage: PurchasedProducts context skipped', e);
      }

      const [favFoodsRows, workoutNamesRows] = await Promise.all([
        db.getAllAsync<{ food_name: string; brand: string | null }>(
          'SELECT food_name, brand FROM FavoriteFoods;',
        ),
        db.getAllAsync<{ workout_name: string }>(
          'SELECT workout_name FROM Workouts ORDER BY workout_name;',
        ),
      ]);
      if (favFoodsRows.length > 0) {
        const parts = favFoodsRows.map((r) =>
          r.brand ? `${r.food_name} (${r.brand})` : r.food_name,
        );
        lines.push(`- Favorite foods (from Nutrition): ${parts.join(', ')}`);
      }
      if (workoutNamesRows.length > 0) {
        const names = workoutNamesRows.map((r) => r.workout_name);
        lines.push(`- Your workouts (from My Workouts): ${names.join(', ')}`);
      }

      try {
        await initVowsDb(db);
        const vowRows = await db.getAllAsync<{ title: string }>(
          "SELECT title FROM Vows WHERE status = 'active' ORDER BY created_at DESC;"
        );
        if (vowRows.length > 0) {
          lines.push(`- Active vows: ${vowRows.map((r) => r.title).join('; ')}`);
        }
      } catch (_) {}

      const [bodyRows, strengthRows] = await Promise.all([
        db.getAllAsync<{
          weight: number | null;
          muscle_mass: number | null;
          body_fat: number | null;
          body_water: number | null;
          bmi: number | null;
        }>(
          'SELECT weight, muscle_mass, body_fat, body_water, bmi FROM BodyMetrics ORDER BY log_date DESC LIMIT 1;'
        ),
        db.getAllAsync<{ exercise_name: string; weight: number | null; reps: number | null; one_rep_max: number | null }>(
          'SELECT exercise_name, weight, reps, one_rep_max FROM StrengthRecords ORDER BY one_rep_max DESC LIMIT 5;'
        ),
      ]);
      if (bodyRows.length > 0) {
        const b = bodyRows[0];
        const bodyParts: string[] = [];
        if (b.weight != null) bodyParts.push(`${b.weight} lbs`);
        if (b.muscle_mass != null) bodyParts.push(`muscle ${b.muscle_mass}%`);
        if (b.body_fat != null) bodyParts.push(`body fat ${b.body_fat}%`);
        if (b.body_water != null) bodyParts.push(`water ${b.body_water}%`);
        if (b.bmi != null) bodyParts.push(`BMI ${b.bmi.toFixed(1)}`);
        if (bodyParts.length) {
          lines.push(`- Most recent body metrics: ${bodyParts.join(', ')}`);
        }
      }
      if (strengthRows.length > 0) {
        const prParts = strengthRows
          .filter((r) => r.weight != null && r.reps != null)
          .map((r) => `${r.exercise_name}: ${r.weight}×${r.reps}`);
        if (prParts.length) {
          lines.push(`- Top 5 strength PRs: ${prParts.join('; ')}`);
        }
      }

      const routeVow = (route.params || {}) as {
        fromMyVow?: boolean;
        vowSageCategories?: string[];
      };
      if (routeVow.fromMyVow && routeVow.vowSageCategories !== undefined) {
        if (routeVow.vowSageCategories.length === 0) {
          lines.push(
            '- Vow session: user chose "Help me decide" — you may suggest across categories unless they narrow it.',
          );
        } else {
          lines.push(
            `- Current vow category: ${routeVow.vowSageCategories.join(', ')}. Only suggest vows in this category unless the user explicitly asks otherwise.`,
          );
        }
      }

      if (!lines.length) return null;
      return ['User context:', ...lines].join('\n');
    } catch (e) {
      console.error('Error building Sage user context:', e);
      return null;
    }
  }, [db, route]);

  const runSageReplyForMessages = useCallback(
    async (
      nextMessages: SageMessage[],
      opts?: { userTextForMaxTokens?: string },
    ): Promise<void> => {
      const userText =
        opts?.userTextForMaxTokens?.trim() ||
        [...nextMessages].reverse().find((m) => m.role === 'user')?.content?.trim() ||
        '';

      try {
        console.log('Sage: calling AI API with conversation', nextMessages);

        const userContext = await buildUserContext();
        const systemPrompt = userContext
          ? `${SYSTEM_PROMPT}\n\n${userContext}`
          : SYSTEM_PROMPT;

        abortInFlightRequest();
        const controller = new AbortController();
        requestAbortRef.current = controller;

        const maxTokens = chooseMaxTokensForSageUserText(userText);
        console.log('Sage: calling AI API with conversation', nextMessages, { maxTokens });

        const result = await fetchSageAnthropicTextReply({
          messages: nextMessages,
          systemPrompt,
          maxTokens,
          signal: controller.signal,
        });

        if (!result.ok) {
          console.error('Sage API error raw:', result.rawErrorText);
          const withError: SageMessage[] = [
            ...nextMessages,
            sageAssistantMessage(SAGE_API_USER_FRIENDLY_ERROR),
          ];
          if (isMountedRef.current) {
            setMessages(withError);
            await saveConversation(withError);
          }
          return;
        }

        console.log('Sage API response:', { stopReason: result.stopReason });

        const reply: SageMessage = {
          role: 'assistant',
          content: result.text,
        };
        let updated: SageMessage[] = [...nextMessages, reply];
        if (result.stopReason === 'max_tokens') {
          updated = [
            ...updated,
            { role: 'assistant', content: SAGE_TRUNCATION_UI_COPY, truncationUi: true },
          ];
        }
        if (isMountedRef.current) {
          setMessages(updated);
          await saveConversation(updated);
        }
      } catch (e) {
        const isAbort =
          (e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'))) ||
          String(e).toLowerCase().includes('abort');
        if (isAbort) {
          return;
        }
        console.error('Sage chat error:', e);
        const withError: SageMessage[] = [
          ...nextMessages,
          sageAssistantMessage(SAGE_API_USER_FRIENDLY_ERROR),
        ];
        if (isMountedRef.current) {
          setMessages(withError);
          await saveConversation(withError);
        }
      } finally {
        if (requestAbortRef.current) requestAbortRef.current = null;
        if (isMountedRef.current) setLoading(false);
      }
    },
    [buildUserContext, abortInFlightRequest],
  );

  useEffect(() => {
    if (!conversationReady) return;
    const p = (route.params || {}) as {
      fromMyVow?: boolean;
      vowSageAutoSend?: boolean;
      vowSageSessionKey?: number;
      vowSageCategories?: string[];
    };
    if (!p.fromMyVow || !p.vowSageAutoSend) return;

    const sessionKey = p.vowSageSessionKey ?? 0;
    if (lastVowSageBootstrapSessionKeyRef.current === sessionKey) return;
    lastVowSageBootstrapSessionKeyRef.current = sessionKey;

    navigation.setParams({
      vowSageAutoSend: false,
    } as never);

    const cats = p.vowSageCategories ?? [];
    const bootstrap = buildVowBootstrapUserLine(cats);

    setMessages((prev) => {
      const next: SageMessage[] = [...prev, { role: 'user', content: bootstrap }];
      queueMicrotask(() => {
        void (async () => {
          if (!isMountedRef.current) return;
          setLoading(true);
          await runSageReplyForMessages(next, { userTextForMaxTokens: bootstrap });
        })();
      });
      return next;
    });
  }, [conversationReady, route.params, navigation, runSageReplyForMessages]);

  const sendMessage = async () => {
    if (isRecording) {
      try {
        ExpoSpeechRecognitionModule.stop();
      } catch {
        // ignore stop errors; we'll send whatever transcript is available
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      const liveSpoken = speechTranscriptRef.current.trim();
      const currentInput = inputRef.current.trim();
      if (liveSpoken) {
        const alreadyIncluded = currentInput
          .toLowerCase()
          .endsWith(liveSpoken.toLowerCase());
        const merged = alreadyIncluded
          ? currentInput
          : currentInput
            ? `${currentInput} ${liveSpoken}`
            : liveSpoken;
        speechTranscriptRef.current = '';
        inputRef.current = merged;
        setInputText(merged);
      }
    }

    const trimmed = inputRef.current.trim();
    if (!trimmed || loading) return;
    inputRef.current = '';
    setInputText('');
    const nextMessages: SageMessage[] = [
      ...messages,
      { role: 'user', content: trimmed },
    ];
    setMessages(nextMessages);
    setLoading(true);

    await runSageReplyForMessages(nextMessages, { userTextForMaxTokens: trimmed });
  };

  const handleTruncationContinue = useCallback(async () => {
    if (loading || sendingReceipt) return;
    const stripped = messagesRef.current.filter((m) => !m.truncationUi);
    const continuation: SageMessage = {
      role: 'user',
      content: SAGE_CONTINUATION_USER_MESSAGE,
    };
    const nextMessages = [...stripped, continuation];
    setMessages(nextMessages);
    setLoading(true);
    try {
      const userContext = await buildUserContext();
      const systemPrompt = userContext
        ? `${SYSTEM_PROMPT}\n\n${userContext}`
        : SYSTEM_PROMPT;
      const maxTokens = chooseMaxTokensForTruncationContinuation(nextMessages);
      abortInFlightRequest();
      const controller = new AbortController();
      requestAbortRef.current = controller;
      const result = await fetchSageAnthropicTextReply({
        messages: nextMessages,
        systemPrompt,
        maxTokens,
        signal: controller.signal,
      });
      if (!result.ok) {
        console.error('Sage continue API error raw:', result.rawErrorText);
        const withError: SageMessage[] = [
          ...nextMessages,
          sageAssistantMessage(SAGE_API_USER_FRIENDLY_ERROR),
        ];
        if (isMountedRef.current) {
          setMessages(withError);
          await saveConversation(withError);
        }
        return;
      }
      const reply: SageMessage = { role: 'assistant', content: result.text };
      let updated: SageMessage[] = [...nextMessages, reply];
      if (result.stopReason === 'max_tokens') {
        updated = [
          ...updated,
          { role: 'assistant', content: SAGE_TRUNCATION_UI_COPY, truncationUi: true },
        ];
      }
      if (isMountedRef.current) {
        setMessages(updated);
        await saveConversation(updated);
      }
    } catch (e) {
      const isAbort =
        (e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'))) ||
        String(e).toLowerCase().includes('abort');
      if (isAbort) {
        return;
      }
      console.error('Sage continue error:', e);
      const withError: SageMessage[] = [
        ...stripped,
        continuation,
        sageAssistantMessage(SAGE_API_USER_FRIENDLY_ERROR),
      ];
      if (isMountedRef.current) {
        setMessages(withError);
        await saveConversation(withError);
      }
    } finally {
      if (requestAbortRef.current) requestAbortRef.current = null;
      if (isMountedRef.current) setLoading(false);
    }
  }, [loading, sendingReceipt, buildUserContext]);


  const handleSaveWorkout = async (workout: AIWorkout) => {
    try {
      const normalized = sortWorkoutExercisesForDisplayAndSave(workout);
      await insertAIWorkout(db as any, normalized);
      const confirmation: SageMessage = {
        role: 'assistant',
        content: `Done! "${workout.workout_name}" is saved to your workouts.`,
      };
      const updated: SageMessage[] = [...messages, confirmation];
      setMessages(updated);
      await saveConversation(updated);
    } catch (e) {
      console.error('Error saving AI workout from Sage:', e);
      const msg =
        e instanceof Error ? e.message : 'Failed to save workout to database.';
      const updated: SageMessage[] = [...messages, sageAssistantMessage(msg)];
      setMessages(updated);
      await saveConversation(updated);
    }
  };

  const handleSaveMealPlan = async (plan: AIMealPlan) => {
    const resolvedPlanName =
      (plan.plan_name && String(plan.plan_name).trim()) || 'Meal plan from Sage';

    console.log('Sage: <mealplan> save requested', {
      plan_name: plan.plan_name,
      resolvedPlanName,
      meals_count: plan.meals?.length ?? 0,
      plan_keys: Object.keys(plan),
    });
    console.log('Sage: parsed meal plan JSON (full)', JSON.stringify(plan, null, 2));

    try {
      let newPlanId: number | null = null;

      await initMealPlansDb(db as any);
      await initNutritionDb(db as any);

      await db.execAsync('BEGIN TRANSACTION');
      try {
        const existing = await db.getAllAsync<{ meal_plan_id: number }>(
          'SELECT meal_plan_id FROM MealPlans WHERE plan_name = ? OR name = ?;',
          [resolvedPlanName, resolvedPlanName]
        );

        let meal_plan_id: number;

        if (existing.length > 0) {
          meal_plan_id = existing[0].meal_plan_id;
          console.log('Sage: plan_name exists, updating MealPlans meal_plan_id', meal_plan_id);
          await db.runAsync(
            'UPDATE MealPlans SET name = ?, plan_name = ?, calories_target = ?, protein_target = ?, carbs_target = ?, fat_target = ? WHERE meal_plan_id = ?;',
            [
              resolvedPlanName,
              resolvedPlanName,
              plan.calories_target,
              plan.protein_target,
              plan.carbs_target,
              plan.fat_target,
              meal_plan_id,
            ],
          );
          await db.runAsync(
            'DELETE FROM FoodItems WHERE meal_id IN (SELECT meal_id FROM PlannedMeals WHERE meal_plan_id = ?);',
            [meal_plan_id],
          );
          await db.runAsync('DELETE FROM PlannedMeals WHERE meal_plan_id = ?;', [meal_plan_id]);
        } else {
          const mealPlanWeekStart = (route.params as { mealPlanWeekStart?: string } | undefined)?.mealPlanWeekStart ?? null;
          console.log('Sage: INSERT INTO MealPlans', resolvedPlanName, mealPlanWeekStart ? `week_start=${mealPlanWeekStart}` : '');
          await db.runAsync(
            'INSERT INTO MealPlans (name, plan_name, calories_target, protein_target, carbs_target, fat_target, created_date, week_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
            [
              resolvedPlanName,
              resolvedPlanName,
              plan.calories_target,
              plan.protein_target,
              plan.carbs_target,
              plan.fat_target,
              new Date().toISOString(),
              mealPlanWeekStart,
            ],
          );
          const planRow = await db.getAllAsync<{ meal_plan_id: number }>(
            'SELECT last_insert_rowid() as meal_plan_id;',
          );
          if (!planRow.length) {
            throw new Error('Failed to retrieve meal_plan_id');
          }
          meal_plan_id = planRow[0].meal_plan_id;
          console.log('Sage: got meal_plan_id', meal_plan_id);
        }

        newPlanId = meal_plan_id;

        for (const meal of plan.meals || []) {
          console.log('Sage: INSERT INTO PlannedMeals', meal.meal_name, meal.meal_type);
          await db.runAsync(
            'INSERT INTO PlannedMeals (meal_plan_id, meal_name, meal_type, meal_order) VALUES (?, ?, ?, ?);',
            [
              meal_plan_id,
              meal.meal_name,
              meal.meal_type,
              meal.meal_order ?? 0,
            ],
          );
          const mealRow = await db.getAllAsync<{ meal_id: number }>(
            'SELECT last_insert_rowid() as meal_id;',
          );
          if (!mealRow.length) {
            throw new Error('Failed to retrieve meal_id');
          }
          const meal_id = mealRow[0].meal_id;
          console.log('Sage: got meal_id', meal_id, 'for', meal.meal_name);

          for (const food of meal.foods || []) {
            await db.runAsync(
              'INSERT INTO FoodItems (meal_id, food_name, brand, serving_size, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
              [
                meal_id,
                food.food_name,
                food.brand,
                food.serving_size,
                food.calories,
                food.protein,
                food.carbs,
                food.fat,
              ],
            );
          }
          console.log('Sage: inserted', meal.foods?.length ?? 0, 'foods for meal', meal.meal_name);
        }

        await db.execAsync('COMMIT');
        console.log('Sage: transaction COMMIT ok');
      } catch (txError) {
        console.error('Sage: transaction error, rolling back', txError);
        await db.execAsync('ROLLBACK');
        throw txError;
      }

      if (newPlanId != null) {
        setLastSavedMealPlanId(newPlanId);
      }

      const confirmation: SageMessage = {
        role: 'assistant',
        content: `Done! "${resolvedPlanName}" meal plan is saved to your nutrition plans.`,
      };
      const updated: SageMessage[] = [...messages, confirmation];
      setMessages(updated);
      await saveConversation(updated);
    } catch (e) {
      console.error('Error saving AI meal plan from Sage:', e);
      const msg =
        e instanceof Error ? e.message : 'Failed to save meal plan to database.';
      const updated: SageMessage[] = [...messages, sageAssistantMessage(msg)];
      setMessages(updated);
      await saveConversation(updated);
    }
  };

  const savePrepToPlan = async (
    mealPlanId: number,
    prepGuideText: string,
    planName: string,
  ) => {
    try {
      await db.runAsync(
        'UPDATE MealPlans SET prep_guide = ? WHERE meal_plan_id = ?;',
        [prepGuideText, mealPlanId],
      );
      const confirmation: SageMessage = {
        role: 'assistant',
        content: `Prep guide saved to ${planName}.`,
      };
      const updated = [...messages, confirmation];
      setMessages(updated);
      await saveConversation(updated);
      Alert.alert('', `Prep guide saved to ${planName}`);
    } catch (e) {
      console.error('Error saving prep guide:', e);
      Alert.alert('Error', 'Failed to save prep guide.');
    }
  };

  const handleSaveMealPrep = async (prep: AIMealPrep) => {
    const prepGuideText = formatMealPrepSummary(prep);
    const params = route.params as { prepGuideForPlanId?: number; prepGuideForPlanName?: string } | undefined;
    const targetPlanId = params?.prepGuideForPlanId ?? lastSavedMealPlanId;

    if (targetPlanId != null) {
      const planName = params?.prepGuideForPlanName ?? (await db.getFirstAsync<{ plan_name: string }>(
        'SELECT plan_name FROM MealPlans WHERE meal_plan_id = ?;',
        [targetPlanId],
      ))?.plan_name ?? 'Meal plan';
      await savePrepToPlan(targetPlanId, prepGuideText, planName);
      return;
    }

    try {
      const plans = await db.getAllAsync<{
        meal_plan_id: number;
        plan_name: string;
      }>(
        'SELECT meal_plan_id, plan_name FROM MealPlans ORDER BY created_date DESC LIMIT 15;',
      );
      if (plans.length === 0) {
        Alert.alert(
          'No meal plans',
          'Save a meal plan first, then you can attach a prep guide to it.',
        );
        return;
      }
      setPrepPlanChoiceModal({
        title: 'Save prep guide to',
        message: 'Choose a meal plan to attach this prep guide to:',
        options: plans.map((p) => ({
          key: String(p.meal_plan_id),
          label: p.plan_name,
          onPress: () =>
            void savePrepToPlan(p.meal_plan_id, prepGuideText, p.plan_name),
        })),
      });
    } catch (e) {
      console.error('Error loading meal plans for prep save:', e);
      Alert.alert('Error', 'Could not load meal plans.');
    }
  };

  const handleShareMealPrep = async (prep: AIMealPrep) => {
    try {
      const message = formatMealPrepForShare(prep);
      await Share.share({
        message,
        title: 'Meal Prep Guide',
      });
    } catch (e) {
      if ((e as any)?.message !== 'User did not share') {
        console.error('Error sharing meal prep:', e);
        Alert.alert('Error', 'Could not open share sheet.');
      }
    }
  };

  /** Compress image to under 5MB for API. Cap both dimensions so tall images don't stay huge. */
  const MAX_RECEIPT_IMAGE_BYTES = 4.5 * 1024 * 1024; // 4.5MB decoded
  const MAX_RECEIPT_BASE64_LENGTH = 5 * 1024 * 1024; // 5MB base64 chars

  const compressImageForReceipt = async (imageUri: string): Promise<string> => {
    console.log('[Sage receipt] URI before manipulation:', imageUri);

    // Presets: [maxWidth, maxHeight], compress. Cap both dimensions to limit pixel count.
    const presets: Array<{ width: number; compress: number }> = [
      { width: 600, compress: 0.3 },
      { width: 400, compress: 0.2 },
      { width: 300, compress: 0.1 },
      { width: 200, compress: 0.05 },
    ];
  
    let lastBase64 = '';
    let lastSizeBytes = Infinity;
  
    for (let i = 0; i < presets.length; i++) {
      const { width, compress } = presets[i];
      const result = await ImageManipulator.manipulateAsync(
        imageUri,
        [{ resize: { width } }],
        {
          compress,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: false,
        }
      );
      const base64 = await FileSystem.readAsStringAsync(result.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const sizeBytes = Math.floor((base64.length * 3) / 4);
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
      console.log(`[Sage receipt] Pass ${i + 1}: width ${width}, quality ${compress} → ${sizeMB} MB`);
  
      lastBase64 = base64;
      lastSizeBytes = sizeBytes;
  
      if (sizeBytes <= 4.5 * 1024 * 1024) {
        console.log('[Sage receipt] Under limit, using this pass.');
        return base64;
      }
    }
  
    console.warn('[Sage receipt] Still over limit after all passes; sending smallest.', lastSizeBytes, 'bytes');
    return lastBase64;
  };

  const processReceiptImage = async (base64Data: string) => {
    const trimmed = inputText.trim();

    const userContext = await buildUserContext();
    const systemPrompt = userContext
      ? `${SYSTEM_PROMPT}\n\n${userContext}`
      : SYSTEM_PROMPT;

    // Use the current input text (if any) as the user message; otherwise send a bare image.
    const userContent = trimmed.length > 0 ? trimmed : '[Image attached]';

    const nextMessages: SageMessage[] = [
      ...messages,
      { role: 'user', content: userContent },
    ];
    setMessages(nextMessages);
    clearComposer();
    setSendingReceipt(true);

    try {
      abortInFlightRequest();
      const controller = new AbortController();
      requestAbortRef.current = controller;

      const tailForApi = buildSageMessagesForApiContext(nextMessages);
      const anthropicMessages = tailForApi.map((m) => ({
        role: m.role,
        content: [{ type: 'text', text: m.content }] as any[],
      }));

      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last) {
        last.content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Data,
          },
        });
      }

      const receiptMaxTokens = looksLikeMealPlanGenerationRequest(userContent)
        ? MEAL_PLAN_MAX_TOKENS
        : SAGE_RECEIPT_DEFAULT_MAX_TOKENS;

      const response = await fetch(SAGE_WORKER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: SAGE_MODEL,
          max_tokens: receiptMaxTokens,
          system: systemPrompt,
          messages: anthropicMessages,
        }),
      });

      if (!response.ok) {
        const txt = await response.text();
        console.error('Sage receipt API error raw:', txt);
        const withError: SageMessage[] = [
          ...nextMessages,
          sageAssistantMessage(SAGE_API_USER_FRIENDLY_ERROR),
        ];
        if (isMountedRef.current) {
          setMessages(withError);
          await saveConversation(withError);
        }
        return;
      }

      const data = await response.json();
      console.log('Sage receipt API response:', { stopReason: data.stop_reason });
      const contentBlocks = Array.isArray(data.content) ? data.content : [];
      const text = contentBlocks
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
        .trim();

      const reply: SageMessage = {
        role: 'assistant',
        content: text || '[No response]',
      };
      let updated: SageMessage[] = [...nextMessages, reply];
      if (data.stop_reason === 'max_tokens') {
        updated = [
          ...updated,
          { role: 'assistant', content: SAGE_TRUNCATION_UI_COPY, truncationUi: true },
        ];
      }
      if (isMountedRef.current) {
        setMessages(updated);
        await saveConversation(updated);
        clearComposer();
      }
    } catch (e) {
      const isAbort =
        (e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'))) ||
        String(e).toLowerCase().includes('abort');
      if (isAbort) {
        return;
      }
      console.error('Sage receipt import error:', e);
      const withError: SageMessage[] = [
        ...nextMessages,
        sageAssistantMessage(SAGE_API_USER_FRIENDLY_ERROR),
      ];
      if (isMountedRef.current) {
        setMessages(withError);
        await saveConversation(withError);
      }
    } finally {
      if (requestAbortRef.current) requestAbortRef.current = null;
      if (isMountedRef.current) setSendingReceipt(false);
    }
  };

  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        const withError: SageMessage[] = [
          ...messages,
          sageAssistantMessage(
            'I need camera permission to take a photo of your receipt. Please enable it in system settings.',
          ),
        ];
        setMessages(withError);
        await saveConversation(withError);
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (result.canceled || !result.assets?.length || !result.assets[0].uri) {
        return;
      }
      const compressedBase64 = await compressImageForReceipt(result.assets[0].uri);
      await processReceiptImage(compressedBase64);
    } catch (e) {
      console.error('Sage camera error:', e);
      const withError: SageMessage[] = [
        ...messages,
        sageAssistantMessage(
          e instanceof Error ? e.message : 'Could not open camera or read photo.',
        ),
      ];
      setMessages(withError);
      await saveConversation(withError);
      setSendingReceipt(false);
    }
  };

  const handleChooseFromLibrary = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        const withError: SageMessage[] = [
          ...messages,
          sageAssistantMessage(
            'I need photo library permission to read your receipt. Please enable it in system settings.',
          ),
        ];
        setMessages(withError);
        await saveConversation(withError);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (result.canceled || !result.assets?.length || !result.assets[0].uri) {
        return;
      }
      const compressedBase64 = await compressImageForReceipt(result.assets[0].uri);
      await processReceiptImage(compressedBase64);
    } catch (e) {
      console.error('Sage library picker error:', e);
      const withError: SageMessage[] = [
        ...messages,
        sageAssistantMessage(
          e instanceof Error ? e.message : 'Could not read image from library.',
        ),
      ];
      setMessages(withError);
      await saveConversation(withError);
      setSendingReceipt(false);
    }
  };

  const handlePickReceipt = async () => {
    if (Platform.OS === 'ios' && ActionSheetIOS) {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Take Photo', 'Choose from Library', 'Cancel'],
          cancelButtonIndex: 2,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) handleTakePhoto();
          else if (buttonIndex === 1) handleChooseFromLibrary();
        }
      );
    } else {
      setReceiptSourcePickerVisible(true);
    }
  };

  const handleOpenMenu = () => {
    setMenuVisible(true);
  };

  const renderItem = ({ item, index }: { item: SageMessage; index: number }) => {
    if (item.truncationUi) {
      return (
        <View style={[styles.messageRow, { justifyContent: 'flex-start' }]}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 10,
              paddingHorizontal: 4,
            }}
          >
            <Text
              style={{
                color: theme.textSecondary ?? '#666',
                fontSize: 14,
                flexShrink: 1,
              }}
            >
              {item.content}
            </Text>
            <TouchableOpacity
              onPress={handleTruncationContinue}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Continue truncated response"
            >
              <Text
                style={{
                  color: theme.text,
                  fontWeight: '700',
                  fontSize: 15,
                  textDecorationLine: 'underline',
                }}
              >
                Continue
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    const isUser = item.role === 'user';
    const workout = item.role === 'assistant'
      ? extractWorkoutFromContent(item.content)
      : null;
    const mealPlanParse =
      item.role === 'assistant'
        ? parseMealPlanFromAssistantMessage(item.content)
        : { plan: null as AIMealPlan | null, displayText: item.content };
    const mealPlan = mealPlanParse.plan;
    if (mealPlan) {
      console.log('Sage: meal plan parsed for UI/save:', mealPlan.plan_name);
    }
    const mealPrep = item.role === 'assistant'
      ? extractMealPrepFromContent(item.content)
      : null;
    const receiptProducts =
      item.role === 'assistant' ? parseProductsTagNamesFromContent(item.content) : [];
    let displayText = isUser ? item.content : mealPlanParse.displayText;
    if (!isUser) {
      displayText = stripWorkoutBlock(displayText);
      displayText = stripMealPlanBlock(displayText);
      displayText = stripMealPrepBlock(displayText);
      displayText = stripProductsTagsFromMessage(displayText);
    }
    const isGroceryList = !isUser && isGroceryListContent(item.content);
    const vowParse =
      !isUser && fromMyVow && !workout && !mealPlan && !mealPrep && !isGroceryList
        ? parseVowsFromSageMessage(displayText)
        : { framing: '', vows: [] as string[] };
    const hasVowCandidates = vowParse.vows.length > 0;
    const prev = index > 0 ? messages[index - 1] : null;
    const showSageLeaf =
      !isUser &&
      (prev == null ||
        prev.role !== 'assistant' ||
        prev.truncationUi === true);

    const bubbleAndSummaries = () => (
      <>
        <View
          style={[
            styles.bubble,
            isUser
              ? {
                  backgroundColor: theme.buttonBackground,
                  alignSelf: 'flex-end',
                }
              : {
                  backgroundColor: theme.card,
                  alignSelf: 'flex-start',
                },
          ]}
        >
          {isUser ? (
            <Text
              style={{
                color: theme.buttonText,
              }}
            >
              {sageMessageBoldSegments(displayText)}
            </Text>
          ) : hasVowCandidates ? (
            <View>
              {vowParse.framing ? (
                <Text style={{ color: theme.text }}>
                  {sageMessageBoldSegments(vowParse.framing)}
                </Text>
              ) : null}
              {vowParse.vows.map((vowText, vi) => {
                const rowKey = `${index}:${vi}`;
                const savedRow =
                  !!savedVowSessionKeys[rowKey] || dbVowTitles.has(vowText.trim());
                return (
                  <TouchableOpacity
                    key={`vow-candidate-${index}-${vi}`}
                    activeOpacity={savedRow ? 1 : 0.72}
                    disabled={savedRow}
                    accessibilityRole="button"
                    accessibilityLabel={`Vow: ${vowText}`}
                    accessibilityState={{ disabled: savedRow }}
                    onPress={() => {
                      if (savedRow) return;
                      openSageCreateOwnFromSuggestedVow(vowText, index, vi);
                    }}
                    style={[
                      {
                        marginTop: vi === 0 ? (vowParse.framing ? 10 : 0) : 10,
                        flexDirection: 'row',
                        alignItems: 'flex-start',
                        paddingVertical: 10,
                        paddingHorizontal: 10,
                        borderRadius: 10,
                        borderWidth: 2,
                        borderColor: 'transparent',
                      },
                      !savedRow && {
                        marginLeft: 4,
                        backgroundColor: 'rgba(168, 190, 168, 0.12)',
                        borderColor: theme.border ?? '#e5e5e5',
                      },
                      savedRow && { opacity: 0.55 },
                    ]}
                  >
                    <Ionicons
                      name="leaf-outline"
                      size={18}
                      color={SAGE_VOW_ACCENT}
                      style={{ marginRight: 8, marginTop: 2 }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.text }}>
                        {sageMessageBoldSegments(vowText)}
                      </Text>
                      {savedRow ? (
                        <Text
                          style={{
                            marginTop: 6,
                            fontSize: 12,
                            fontWeight: '700',
                            color: SAGE_VOW_ACCENT,
                          }}
                        >
                          Saved
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <Text
              style={{
                color: theme.text,
              }}
            >
              {sageMessageBoldSegments(displayText)}
            </Text>
          )}
        </View>
        {!isUser &&
          mealPlanBlockStartedNotClosed(item.content) &&
          !mealPlan &&
          !mealPrep && (
            <Text
              style={{
                marginTop: 6,
                fontSize: 13,
                color: theme.textSecondary ?? '#888',
              }}
            >
              {SAGE_MEALPLAN_INCOMPLETE_HINT}
            </Text>
          )}
        {workout && (
          <View style={styles.summaryContainer}>
            <View
              style={[
                styles.summaryBox,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={{ color: theme.text, fontSize: 14 }}>
                {formatWorkoutSummary(workout)}
              </Text>
            </View>
            <TouchableOpacity
              style={[
                styles.saveButton,
                { borderColor: theme.border },
              ]}
              onPress={() => handleSaveWorkout(workout)}
            >
              <Ionicons
                name="save-outline"
                size={18}
                color={theme.text}
                style={{ marginRight: 6 }}
              />
              <Text style={{ color: theme.text, fontWeight: '600' }}>
                Save Workout ✓
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {mealPlan && (
          <View style={styles.summaryContainer}>
            <View
              style={[
                styles.summaryBox,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={{ color: theme.text, fontSize: 14 }}>
                {formatMealPlanSummary(mealPlan)}
              </Text>
            </View>
            <TouchableOpacity
              style={[
                styles.saveButton,
                { borderColor: theme.border },
              ]}
              onPress={() => handleSaveMealPlan(mealPlan)}
            >
              <Ionicons
                name="save-outline"
                size={18}
                color={theme.text}
                style={{ marginRight: 6 }}
              />
              <Text style={{ color: theme.text, fontWeight: '600' }}>
                Save Meal Plan ✓
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {mealPrep && (
          <View style={styles.summaryContainer}>
            <View
              style={[
                styles.summaryBox,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                },
              ]}
            >
              <Text style={{ color: theme.text, fontSize: 14 }}>
                {formatMealPrepSummary(mealPrep)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  { borderColor: theme.border },
                ]}
                onPress={() => handleSaveMealPrep(mealPrep)}
              >
                <Ionicons
                  name="save-outline"
                  size={18}
                  color={theme.text}
                  style={{ marginRight: 6 }}
                />
                <Text style={{ color: theme.text, fontWeight: '600' }}>
                  Save to Meal Plan ✓
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  { borderColor: theme.border },
                ]}
                onPress={() => handleShareMealPrep(mealPrep)}
              >
                <Ionicons
                  name="share-outline"
                  size={18}
                  color={theme.text}
                  style={{ marginRight: 6 }}
                />
                <Text style={{ color: theme.text, fontWeight: '600' }}>
                  Share ↑
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {!isUser && receiptProducts.length > 0 && !receiptProductsPanelSkipped[index] && (
          <SageReceiptProductsPanel
            key={`rp-${index}-${receiptProducts.join('\x1e')}`}
            products={receiptProducts}
            theme={theme}
            savedFromDb={!!receiptProductsAllInDbByIndex[index]}
            savedThisSession={!!receiptProductsPanelSavedSession[index]}
            onSkip={() => setReceiptProductsPanelSkipped((p) => ({ ...p, [index]: true }))}
            onConfirm={async (names) => {
              for (const n of names) {
                await upsertProduct(db, n);
              }
              setReceiptProductsPanelSavedSession((p) => ({ ...p, [index]: true }));
              setReceiptProductsPanelTick((t) => t + 1);
              Alert.alert(
                'Products saved',
                `Added ${names.length} ${names.length === 1 ? 'product' : 'products'} to your history.`,
              );
            }}
          />
        )}
      </>
    );

    return (
      <View
        style={[
          styles.messageRow,
          { justifyContent: isUser ? 'flex-end' : 'flex-start' },
        ]}
      >
        {isUser ? (
          bubbleAndSummaries()
        ) : (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              width: '100%',
            }}
          >
            <View
              style={{
                width: SAGE_LEAF_AVATAR_DIAMETER + SAGE_LEAF_AVATAR_GAP,
                alignItems: 'flex-start',
              }}
            >
              {showSageLeaf ? (
                <View
                  style={{
                    width: SAGE_LEAF_AVATAR_DIAMETER,
                    height: SAGE_LEAF_AVATAR_DIAMETER,
                    borderRadius: SAGE_LEAF_AVATAR_DIAMETER / 2,
                    backgroundColor: SAGE_LEAF_FILL,
                    marginRight: SAGE_LEAF_AVATAR_GAP,
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <Ionicons
                    name="leaf"
                    size={SAGE_LEAF_ICON_SIZE}
                    color="#FFFFFF"
                  />
                </View>
              ) : null}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>{bubbleAndSummaries()}</View>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
    >
      <KeyboardAvoidingView
        style={styles.flexWrapper}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={120}
      >
        <View style={styles.inner}>
          <FlatList
            style={styles.list}
            ref={listRef}
            data={messages}
            keyExtractor={(_, index) => String(index)}
            extraData={vowFlatListExtra}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => {
              if (snapToBottomAfterFocusRef.current) {
                listRef.current?.scrollToEnd({ animated: false });
              }
            }}
            onLayout={() => {
              if (snapToBottomAfterFocusRef.current) {
                listRef.current?.scrollToEnd({ animated: false });
              }
            }}
            onScroll={(
              e: NativeSyntheticEvent<NativeScrollEvent>,
            ) => {
              const {
                layoutMeasurement,
                contentOffset,
                contentSize,
              } = e.nativeEvent;
              const paddingToBottom = 20;
              const atBottom =
                layoutMeasurement.height + contentOffset.y >=
                contentSize.height - paddingToBottom;
              setShowScrollToBottom(!atBottom);
            }}
            scrollEventThrottle={16}
          />

          <View
            style={[
              styles.inputBar,
              { borderTopColor: theme.border, backgroundColor: theme.card },
            ]}
          >
            <TextInput
              style={[styles.input, { color: theme.text }]}
              placeholder="Message..."
              placeholderTextColor={theme.textSecondary || theme.text}
              value={inputText}
              onChangeText={(text) => {
                inputRef.current = text;
                setInputText(text);
              }}
              multiline
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={() => {
                void sendMessage();
              }}
            />
            <TouchableOpacity
              style={[styles.micButton, isRecording && styles.micButtonRecording]}
              onPress={toggleMic}
              disabled={sendingReceipt}
            >
              <Ionicons
                name="mic-outline"
                size={20}
                color={theme.textSecondary || theme.text}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.micButton,
                sendingReceipt && { backgroundColor: theme.buttonBackground },
              ]}
              onPress={handlePickReceipt}
              disabled={sendingReceipt}
            >
              <Ionicons
                name="camera-outline"
                size={20}
                color={sendingReceipt ? theme.buttonText : theme.text}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.sendButton,
                { backgroundColor: theme.buttonBackground },
              ]}
              onPress={sendMessage}
              disabled={loading || (!inputText.trim() && !isRecording)}
            >
              {loading ? (
                <ActivityIndicator color={theme.buttonText} size="small" />
              ) : (
                <Ionicons name="send" size={20} color={theme.buttonText} />
              )}
            </TouchableOpacity>
          </View>
          {showScrollToBottom && (
            <TouchableOpacity
              style={[
                styles.scrollDownButton,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                },
              ]}
              onPress={() =>
                listRef.current?.scrollToEnd({ animated: true })
              }
            >
              <Ionicons
                name="chevron-down"
                size={20}
                color={theme.primary}
              />
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>

      {menuVisible && (
        <View
          style={{
            position: 'absolute',
            top: 56,
            right: 12,
            backgroundColor: theme.card,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.border,
            paddingVertical: 4,
            paddingHorizontal: 8,
          }}
        >
          <TouchableOpacity
            onPress={() => {
              setMenuVisible(false);
              Alert.alert(
                'Start fresh?',
                'This will clear your conversation with Sage.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Clear',
                    style: 'destructive',
                    onPress: () => {
                      handleClear();
                    },
                  },
                ],
              );
            }}
            style={{ paddingVertical: 6, paddingHorizontal: 4 }}
          >
            <Text
              style={{
                color: theme.text,
                fontSize: 14,
              }}
            >
              🗑 Clear Conversation
            </Text>
          </TouchableOpacity>
        </View>
      )}
      <ChoiceListModal
        visible={receiptSourcePickerVisible}
        title="Add receipt"
        message="Take a photo or choose from your library."
        options={[
          {
            key: 'camera',
            label: 'Take Photo',
            onPress: () => void handleTakePhoto(),
          },
          {
            key: 'library',
            label: 'Choose from Library',
            onPress: () => void handleChooseFromLibrary(),
          },
        ]}
        onCancel={() => setReceiptSourcePickerVisible(false)}
      />
      <ChoiceListModal
        visible={prepPlanChoiceModal != null}
        title={prepPlanChoiceModal?.title ?? ''}
        message={prepPlanChoiceModal?.message}
        options={prepPlanChoiceModal?.options ?? []}
        onCancel={() => setPrepPlanChoiceModal(null)}
      />
      <CreateOwnVowModal
        visible={sageCreateOwnModalVisible}
        initialVowText={sageCreateOwnPrefill}
        initialCategories={sageCreateOwnInitialCategories}
        onClose={() => {
          setSageCreateOwnModalVisible(false);
          setSageCreateOwnPrefill('');
          setSageCreateOwnInitialCategories(undefined);
          sageVowSaveTargetRef.current = null;
        }}
        onSubmit={handleSageCreateOwnSubmit}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flexWrapper: {
    flex: 1,
  },
  inner: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'CormorantGaramond-Bold',
  },
  clearButton: {
    position: 'absolute',
    right: 16,
    padding: 4,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  messageRow: {
    marginVertical: 4,
  },
  bubble: {
    maxWidth: '80%',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  summaryContainer: {
    alignSelf: 'stretch',
    marginTop: 4,
  },
  summaryBox: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 4,
  },
  saveButton: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 6,
    paddingBottom: 8,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    maxHeight: 100,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
    fontFamily: 'Jost_400Regular',
  },
  micButton: {
    marginLeft: 8,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  micButtonRecording: {
    backgroundColor: 'rgba(192,57,43,0.2)',
  },
  voiceHint: {
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 4,
  },
  sendButton: {
    marginLeft: 8,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollDownButton: {
    position: 'absolute',
    right: 16,
    bottom: 80,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

