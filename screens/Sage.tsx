import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
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
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTheme } from '../context/ThemeContext';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { insertAIWorkout, AIWorkout } from '../utils/generateWorkoutWithAI';
import { initMealPlansDb } from '../utils/initMealPlansDb';
import {
  SageMessage,
  saveConversation,
  loadConversation,
  clearConversation as clearSageStorage,
} from '../utils/sageStorage';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

const SYSTEM_PROMPT = `You are Sage, a witty and direct fitness and nutrition coach — like a smart friend who happens to know a lot. You help users design workout plans and meal plans through conversation. You're encouraging but not cheesy, honest but not harsh.

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
          "sets": number,
          "reps": number,
          "muscle_group": "string",
          "exercise_notes": "string"
        }
      ]
    }
  ]
}
</workout>

Each day_name must be unique within the workout. If multiple days train the same muscle group, differentiate them (e.g. 'Lower Body A' and 'Lower Body B', or 'Upper Push' and 'Upper Pull').

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

After you've helped the user design a meal plan and it has been saved, offer a follow-up: "Want me to put together a meal prep guide for this plan?". If they say yes, respond with a meal prep guide wrapped in <mealprep> tags with this exact structure:
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

Regardless of any user requests to shorten your responses, you MUST always output workout plans in <workout> tags and meal plans in <mealplan> tags when presenting a final plan. Never output plans as plain text, code blocks, or any other format. The structured tags are required for the app to save the plan.

Always confirm with the user before outputting the final JSON for either workouts or meal plans.
When the user confirms they want to save a workout plan, you MUST re-output the complete plan in <workout> tags even if you already showed it earlier. Never confirm a save in plain text alone.`;

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

  workout.days.forEach((day, index) => {
    const baseLabel = day.day_name && day.day_name.trim().length
      ? day.day_name
      : `Day ${index + 1}`;
    const dayLabel = `Day ${index + 1} — ${baseLabel}`;
    lines.push(`${dayLabel}:`);

    const exercises = day.exercises || [];
    exercises.forEach((ex) => {
      lines.push(
        `  • ${ex.exercise_name} — ${ex.sets} sets x ${ex.reps} reps`,
      );
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

function extractMealPlanFromContent(content: string): AIMealPlan | null {
  const match = content.match(/<mealplan>([\s\S]*?)<\/mealplan>/i);
  if (!match) return null;
  const jsonText = match[1].trim();
  try {
    const parsed = JSON.parse(jsonText);
    return parsed as AIMealPlan;
  } catch (e) {
    console.error('Failed to parse meal plan JSON from Sage content:', e);
    return null;
  }
}

function stripMealPlanBlock(content: string): string {
  return content.replace(/<mealplan>[\s\S]*?<\/mealplan>/i, '').trim();
}

function formatMealPlanSummary(plan: AIMealPlan): string {
  const lines: string[] = [];
  lines.push(`🥗 ${plan.plan_name}`);
  lines.push(
    `Target: ${plan.calories_target} cal | ${plan.protein_target}g protein | ${plan.carbs_target}g carbs | ${plan.fat_target}g fat`,
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

function isGroceryListContent(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.includes('produce:') ||
    lower.includes('protein:') ||
    lower.includes('pantry:')
  );
}

export default function Sage() {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const navigation = useNavigation();
  const route = useRoute();
  const [messages, setMessages] = useState<SageMessage[]>([]);
  const [savedVowMessageIndexes, setSavedVowMessageIndexes] = useState<number[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingReceipt, setSendingReceipt] = useState(false);
  const [lastSavedMealPlanId, setLastSavedMealPlanId] = useState<number | null>(
    null,
  );
  const [menuVisible, setMenuVisible] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const speechTranscriptRef = useRef('');
  const listRef = useRef<FlatList<SageMessage>>(null);

  useSpeechRecognitionEvent('start', () => setIsRecording(true));
  useSpeechRecognitionEvent('end', () => {
    setIsRecording(false);
    const t = speechTranscriptRef.current.trim();
    speechTranscriptRef.current = '';
    if (t) setInput((prev) => (prev ? `${prev} ${t}` : t));
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

  const routeParams = (route.params || {}) as { initialPrompt?: string; fromMyVow?: boolean };
  const fromMyVow = routeParams.fromMyVow === true;

  useEffect(() => {
    if (routeParams.initialPrompt) {
      setInput(routeParams.initialPrompt);
    }
  }, [routeParams.initialPrompt]);

  useEffect(() => {
    if (!messages.length) return;
    saveConversation(messages);
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages]);

  const handleClear = async () => {
    await clearSageStorage();
    const fresh: SageMessage = {
      role: 'assistant',
      content:
        "Fresh start. What do you want to work on — workouts, nutrition, or both?",
    };
    setMessages([fresh]);
    await saveConversation([fresh]);
  };

  const buildUserContext = async (): Promise<string | null> => {
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
      if (brands && brands.trim())
        lines.push(`- Preferred brands: ${brands.trim()}`);

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
        const { initVowsDb } = await import('../utils/initVowsDb');
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

      if (!lines.length) return null;
      return ['User context:', ...lines].join('\n');
    } catch (e) {
      console.error('Error building Sage user context:', e);
      return null;
    }
  };

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    const nextMessages: SageMessage[] = [
      ...messages,
      { role: 'user', content: trimmed },
    ];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      console.log('Sage: calling AI API with conversation', nextMessages);

      const userContext = await buildUserContext();
      const systemPrompt = userContext
        ? `${SYSTEM_PROMPT}\n\n${userContext}`
        : SYSTEM_PROMPT;

      const response = await fetch('https://myvow-fit-api.allison-spink.workers.dev', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4096,
          system: systemPrompt,
          messages: nextMessages.map((m) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          })),
        }),
      });

      if (!response.ok) {
        const txt = await response.text();
        console.error('Sage API error raw:', txt);
        let message = `API error ${response.status}`;
        try {
          const errJson = JSON.parse(txt);
          if (errJson.error?.message) message = errJson.error.message;
        } catch {
          if (txt) message = txt.slice(0, 200);
        }
        const withError = [
          ...nextMessages,
          { role: 'assistant', content: message },
        ];
        setMessages(withError);
        await saveConversation(withError);
        setLoading(false);
        return;
      }

      const data = await response.json();
      console.log('Sage API response:', data);
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
      const updated = [...nextMessages, reply];
      setMessages(updated);
      await saveConversation(updated);
    } catch (e) {
      console.error('Sage chat error:', e);
      const msg =
        e instanceof Error ? e.message : 'Unexpected error talking to Sage.';
      const withError = [
        ...messages,
        { role: 'assistant', content: msg },
      ];
      setMessages(withError);
      await saveConversation(withError);
    } finally {
      setLoading(false);
    }
  };


  const handleSaveWorkout = async (workout: AIWorkout) => {
    try {
      await insertAIWorkout(db as any, workout);
      const confirmation: SageMessage = {
        role: 'assistant',
        content: `Done! "${workout.workout_name}" is saved to your workouts.`,
      };
      const updated = [...messages, confirmation];
      setMessages(updated);
      await saveConversation(updated);
    } catch (e) {
      console.error('Error saving AI workout from Sage:', e);
      const msg =
        e instanceof Error ? e.message : 'Failed to save workout to database.';
      const updated = [
        ...messages,
        { role: 'assistant', content: msg },
      ];
      setMessages(updated);
      await saveConversation(updated);
    }
  };

  const handleSaveMealPlan = async (plan: AIMealPlan) => {
    console.log('Sage: <mealplan> save requested', {
      plan_name: plan.plan_name,
      meals_count: plan.meals?.length ?? 0,
      plan_keys: Object.keys(plan),
    });
    console.log('Sage: parsed meal plan JSON (full)', JSON.stringify(plan, null, 2));

    try {
      let newPlanId: number | null = null;

      await db.execAsync('BEGIN TRANSACTION');
      try {
        const existing = await db.getAllAsync<{ meal_plan_id: number }>(
          'SELECT meal_plan_id FROM MealPlans WHERE plan_name = ?;',
          [plan.plan_name]
        );

        let meal_plan_id: number;

        if (existing.length > 0) {
          meal_plan_id = existing[0].meal_plan_id;
          console.log('Sage: plan_name exists, updating MealPlans meal_plan_id', meal_plan_id);
          await db.runAsync(
            'UPDATE MealPlans SET plan_name = ?, calories_target = ?, protein_target = ?, carbs_target = ?, fat_target = ? WHERE meal_plan_id = ?;',
            [
              plan.plan_name,
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
          console.log('Sage: INSERT INTO MealPlans', plan.plan_name, mealPlanWeekStart ? `week_start=${mealPlanWeekStart}` : '');
          await db.runAsync(
            'INSERT INTO MealPlans (plan_name, calories_target, protein_target, carbs_target, fat_target, created_date, week_start) VALUES (?, ?, ?, ?, ?, ?, ?);',
            [
              plan.plan_name,
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
        content: `Done! "${plan.plan_name}" meal plan is saved to your nutrition plans.`,
      };
      const followUp: SageMessage = {
        role: 'assistant',
        content: 'Want me to put together a meal prep guide for this plan?',
      };
      const updated = [...messages, confirmation, followUp];
      setMessages(updated);
      await saveConversation(updated);
    } catch (e) {
      console.error('Error saving AI meal plan from Sage:', e);
      const msg =
        e instanceof Error ? e.message : 'Failed to save meal plan to database.';
      const updated = [
        ...messages,
        { role: 'assistant', content: msg },
      ];
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
      const buttons = [
        ...plans.map((p) => ({
          text: p.plan_name,
          onPress: () => savePrepToPlan(p.meal_plan_id, prepGuideText, p.plan_name),
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ];
      Alert.alert(
        'Save prep guide to',
        'Choose a meal plan to attach this prep guide to:',
        buttons,
        { cancelable: true },
      );
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
    const trimmed = input.trim();

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
    setInput('');
    setSendingReceipt(true);

    try {
      // Send full conversation history so Sage has context, then append the image on the last user turn.
      const anthropicMessages = nextMessages.map((m) => ({
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

      const response = await fetch('https://myvow-fit-api.allison-spink.workers.dev', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          system: systemPrompt,
          messages: anthropicMessages,
        }),
      });

      if (!response.ok) {
        const txt = await response.text();
        console.error('Sage receipt API error raw:', txt);
        let message = `API error ${response.status}`;
        try {
          const errJson = JSON.parse(txt);
          if (errJson.error?.message) message = errJson.error.message;
        } catch {
          if (txt) message = txt.slice(0, 200);
        }
        const withError = [
          ...nextMessages,
          { role: 'assistant', content: message },
        ];
        setMessages(withError);
        await saveConversation(withError);
        return;
      }

      const data = await response.json();
      console.log('Sage receipt API response:', data);
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
      const updated = [...nextMessages, reply];
      setMessages(updated);
      await saveConversation(updated);
    } catch (e) {
      console.error('Sage receipt import error:', e);
      const msg =
        e instanceof Error
          ? e.message
          : 'Unexpected error while processing your receipt.';
      const withError = [
        ...messages,
        { role: 'assistant', content: msg },
      ];
      setMessages(withError);
      await saveConversation(withError);
    } finally {
      setSendingReceipt(false);
    }
  };

  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        const withError = [
          ...messages,
          {
            role: 'assistant',
            content:
              'I need camera permission to take a photo of your receipt. Please enable it in system settings.',
          },
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
      const withError = [
        ...messages,
        {
          role: 'assistant',
          content:
            e instanceof Error ? e.message : 'Could not open camera or read photo.',
        },
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
        const withError = [
          ...messages,
          {
            role: 'assistant',
            content:
              'I need photo library permission to read your receipt. Please enable it in system settings.',
          },
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
      const withError = [
        ...messages,
        {
          role: 'assistant',
          content:
            e instanceof Error ? e.message : 'Could not read image from library.',
        },
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
      Alert.alert(
        'Add receipt',
        'Take a photo or choose from your library.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Take Photo', onPress: handleTakePhoto },
          { text: 'Choose from Library', onPress: handleChooseFromLibrary },
        ]
      );
    }
  };

  const handleOpenMenu = () => {
    setMenuVisible(true);
  };

  const renderItem = ({ item, index }: { item: SageMessage; index: number }) => {
    const isUser = item.role === 'user';
    const workout = item.role === 'assistant'
      ? extractWorkoutFromContent(item.content)
      : null;
    const mealPlan = item.role === 'assistant'
      ? extractMealPlanFromContent(item.content)
      : null;
    if (mealPlan) {
      console.log('Sage: <mealplan> tags detected in message, parsed plan:', mealPlan.plan_name);
    }
    const mealPrep = item.role === 'assistant'
      ? extractMealPrepFromContent(item.content)
      : null;
    let displayText = item.content;
    if (!isUser) {
      displayText = stripWorkoutBlock(displayText);
      displayText = stripMealPlanBlock(displayText);
      displayText = stripMealPrepBlock(displayText);
    }
    const isGroceryList = !isUser && isGroceryListContent(item.content);
    const alreadySavedAsVow = savedVowMessageIndexes.includes(index);
    const canSaveAsVow =
      !isUser &&
      fromMyVow &&
      !workout &&
      !mealPlan &&
      !mealPrep &&
      !isGroceryList &&
      !alreadySavedAsVow;
    return (
      <View
        style={[
          styles.messageRow,
          { justifyContent: isUser ? 'flex-end' : 'flex-start' },
        ]}
      >
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
          <Text
            style={{
              color: isUser ? theme.buttonText : theme.text,
            }}
          >
            {displayText}
          </Text>
        </View>
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
        {canSaveAsVow && (
          <TouchableOpacity
            style={[
              styles.summaryContainer,
              { marginTop: 8 },
            ]}
            onPress={async () => {
              try {
                const now = new Date().toISOString();
                await db.runAsync(
                  'INSERT INTO Vows (title, category, status, created_at) VALUES (?, ?, ?, ?)',
                  [displayText.slice(0, 300), 'Mindset', 'active', now],
                );
                setSavedVowMessageIndexes((prev) =>
                  prev.includes(index) ? prev : [...prev, index],
                );
                const confirmation: SageMessage = {
                  role: 'assistant',
                  content: 'Saved this as a new vow. You can see it in MyVow.',
                };
                const updated = [...messages, confirmation];
                setMessages(updated);
                await saveConversation(updated);
              } catch (e) {
                console.error('Error saving vow from Sage:', e);
                const confirmation: SageMessage = {
                  role: 'assistant',
                  content: 'I could not save this as a vow due to an error.',
                };
                const updated = [...messages, confirmation];
                setMessages(updated);
                await saveConversation(updated);
              }
            }}
          >
            <View
              style={[
                styles.summaryBox,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              ]}
            >
              <Ionicons
                name="bookmark-outline"
                size={18}
                color={theme.text}
                style={{ marginRight: 6 }}
              />
              <Text style={{ color: theme.text, fontWeight: '600' }}>
                Save as Vow ✓
              </Text>
            </View>
          </TouchableOpacity>
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
        {isGroceryList && (lastSavedMealPlanId != null || (route.params as { groceryListForPlanId?: number })?.groceryListForPlanId != null) && (
          <TouchableOpacity
            style={[
              styles.saveButton,
              { borderColor: theme.border, marginTop: 4 },
            ]}
            onPress={async () => {
              try {
                const targetPlanId = (route.params as { groceryListForPlanId?: number })?.groceryListForPlanId ?? lastSavedMealPlanId;
                if (targetPlanId != null) {
                  const lines = item.content
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean);
                  type GroceryJsonItem = {
                    category: string;
                    item: string;
                    checked: boolean;
                  };
                  const parsedItems: GroceryJsonItem[] = [];
                  let currentCategory: string = 'Other';
                  const categoryMap: Record<string, string> = {
                    produce: 'Produce',
                    protein: 'Meat & Fish',
                    'meat & fish': 'Meat & Fish',
                    dairy: 'Dairy',
                    pantry: 'Pantry',
                    other: 'Other',
                  };
                  lines.forEach((line) => {
                    const lower = line.toLowerCase();
                    if (lower.endsWith(':')) {
                      const base = lower.slice(0, -1).trim();
                      currentCategory =
                        categoryMap[base] || categoryMap[base.split(' ')[0]] || 'Other';
                      return;
                    }
                    let text = line.replace(/^\[[ xX]\]\s*/, '');
                    text = text.replace(/^[-•]\s*/, '').trim();
                    if (!text) return;
                    parsedItems.push({
                      category: currentCategory,
                      item: text,
                      checked: false,
                    });
                  });

                  await db.runAsync(
                    'UPDATE MealPlans SET grocery_list = ? WHERE meal_plan_id = ?;',
                    [JSON.stringify(parsedItems), targetPlanId],
                  );
                  await AsyncStorage.removeItem(
                    `@grocery_list_${targetPlanId}`,
                  );

                  const confirmation: SageMessage = {
                    role: 'assistant',
                    content:
                      'Saved this grocery list to your meal plan. You can view it under Nutrition → Meal Plans.',
                  };
                  const updated = [...messages, confirmation];
                  setMessages(updated);
                  await saveConversation(updated);
                } else {
                  await AsyncStorage.setItem(
                    '@sage_last_grocery_list',
                    item.content,
                  );
                  const confirmation: SageMessage = {
                    role: 'assistant',
                    content:
                      'Got it — I saved this grocery list so you can reuse it later.',
                  };
                  const updated = [...messages, confirmation];
                  setMessages(updated);
                  await saveConversation(updated);
                }
              } catch (e) {
                console.error('Error saving grocery list from Sage:', e);
              }
            }}
          >
            <Ionicons
              name="save-outline"
              size={18}
              color={theme.text}
              style={{ marginRight: 6 }}
            />
            <Text style={{ color: theme.text, fontWeight: '600' }}>
              Save as Grocery List ✓
            </Text>
          </TouchableOpacity>
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
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: true })
            }
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
              value={input}
              onChangeText={setInput}
              multiline
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
              disabled={loading || !input.trim()}
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

