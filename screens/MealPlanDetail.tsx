/**
 * Meal plan detail: name, Schedule section (day chips + quick options), Set as Active.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Share,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import {
  initMealPlansDb,
  type DayOfWeek,
  WEEKDAY_DAYS,
  WEEKEND_DAYS,
  ALTERNATING_A_DAYS,
  ALTERNATING_B_DAYS,
} from '../utils/initMealPlansDb';
// Grocery/prep food categories use keyword lookup in utils/generateMealPlanGroceryAndPrep.ts
import {
  generateGroceryListFromPlan,
  generatePrepGuideFromPlan,
} from '../utils/generateMealPlanGroceryAndPrep';
import { initNutritionDb } from '../utils/nutritionDb';

const SAGE = '#7C9A7E';
const DAYS: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS: Record<DayOfWeek, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

function getMondayIso(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + mondayOffset);
  return d.toISOString().slice(0, 10);
}
function addDaysIso(iso: string, delta: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
function getWeekDates(iso: string): string[] {
  const monday = getMondayIso(iso);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDaysIso(monday, i));
}

/** Turn stored grocery_list (JSON array or raw text) into a clean, shareable plain list. */
function formatGroceryListForDisplay(raw: string | null): string {
  if (!raw || !raw.trim()) return '';
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) return trimmed;
    const byCategory: Record<string, string[]> = {};
    for (const entry of parsed) {
      const text = entry.item ?? entry.text ?? String(entry).trim();
      if (!text) continue;
      let cat = (entry.category || 'Other').trim();
      if (cat === 'Protein') cat = 'Meat & Fish';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(text);
    }
    const lines: string[] = [];
    const order = ['Produce', 'Meat & Fish', 'Dairy', 'Pantry', 'Other'];
    const seen = new Set<string>();
    for (const cat of order) {
      if (byCategory[cat]?.length) {
        lines.push(cat + ':');
        byCategory[cat].forEach((item) => lines.push('  • ' + item));
        lines.push('');
        seen.add(cat);
      }
    }
    for (const cat of Object.keys(byCategory)) {
      if (!seen.has(cat)) {
        lines.push(cat + ':');
        byCategory[cat].forEach((item) => lines.push('  • ' + item));
        lines.push('');
      }
    }
    return lines.join('\n').trim();
  } catch {
    // Plain text: strip code blocks and normalize
    let text = trimmed.replace(/```[\s\S]*?```/g, '').trim();
    const out: string[] = [];
    text.split(/\r?\n/).forEach((line) => {
      const cleaned = line.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
      if (cleaned) out.push('• ' + cleaned);
    });
    return out.join('\n');
  }
}

type RouteParams = { meal_plan_id: number; name: string };

type PlanFood = {
  food_name: string;
  brand: string | null;
  serving_size: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type PlanMeal = {
  meal_id: number;
  meal_name: string;
  meal_type: string;
  meal_order?: number | null;
  foods: PlanFood[];
};

/** Readable schedule line for share/copy (expanded day keys). */
function scheduleDaysToSummary(days: Set<string>): string {
  if (days.size === 0) return 'Not set';
  const labels = DAYS.filter((d) => days.has(d)).map((d) => DAY_LABELS[d]);
  if (labels.length === 7) return 'Every day';
  if (labels.length === 0) return 'Not set';
  return labels.join(', ');
}

/** Plain-text meal plan for sharing or clipboard. */
function formatMealPlanShareText(planName: string, meals: PlanMeal[], scheduleSummary: string): string {
  const lines: string[] = [`Meal plan: ${planName}`, ''];
  lines.push(`Schedule: ${scheduleSummary}`);
  lines.push('');
  if (meals.length === 0) {
    lines.push('(No meals in this plan yet.)');
    return lines.join('\n').trim();
  }
  for (const meal of meals) {
    const mealCals = meal.foods.reduce((sum, f) => sum + (f.calories ?? 0), 0);
    const mealP = meal.foods.reduce((sum, f) => sum + (f.protein ?? 0), 0);
    const mealC = meal.foods.reduce((sum, f) => sum + (f.carbs ?? 0), 0);
    const mealF = meal.foods.reduce((sum, f) => sum + (f.fat ?? 0), 0);
    lines.push(meal.meal_name);
    lines.push(
      `  Meal totals: ${Math.round(mealCals)} cal · P ${Math.round(mealP * 10) / 10}g · C ${Math.round(mealC * 10) / 10}g · F ${Math.round(mealF * 10) / 10}g`,
    );
    if (meal.foods.length === 0) {
      lines.push('  (No foods listed.)');
    } else {
      for (const food of meal.foods) {
        let line = `  • ${food.food_name}`;
        if (food.brand?.trim()) line += ` — ${food.brand.trim()}`;
        if (food.serving_size?.trim()) line += ` — ${food.serving_size.trim()}`;
        line += ` — ${Math.round(food.calories)} cal`;
        if (food.protein || food.carbs || food.fat) {
          line += ` (P ${food.protein}g / C ${food.carbs}g / F ${food.fat}g)`;
        }
        lines.push(line);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

const MEAL_TYPE_ORDER: Record<string, number> = {
  breakfast: 0,
  snack: 1,
  lunch: 2,
  dinner: 3,
  other: 4,
};

function normalizeMealType(raw: string | null | undefined): string {
  const t = (raw || 'snack').toLowerCase().trim();
  if (t === 'breakfast' || t === 'lunch' || t === 'dinner' || t === 'snack') return t;
  return 'other';
}

function mealTypeSortKey(mealType: string): number {
  return MEAL_TYPE_ORDER[normalizeMealType(mealType)] ?? MEAL_TYPE_ORDER.other;
}

function mealTypeSectionLabel(mealType: string): string {
  const t = normalizeMealType(mealType);
  if (t === 'other') return 'OTHER';
  return t.toUpperCase();
}

/** Match loadSchedule: expand alternating_* rows into mon–sun keys used by Set as Active + DayActivePlan. */
function expandMealPlanScheduleToWeekdayKeys(
  rows: { day_of_week: string }[],
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const v = r.day_of_week.toLowerCase().trim();
    if (v === 'alternating_a') {
      ALTERNATING_A_DAYS.forEach((d) => out.add(d));
    } else if (v === 'alternating_b') {
      ALTERNATING_B_DAYS.forEach((d) => out.add(d));
    } else {
      out.add(v);
    }
  }
  return out;
}

const CAL_WEEKDAY_KEYS: ('sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat')[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];

/**
 * After the user edits schedule chips, realign DayActivePlan with MealPlanSchedule for every
 * calendar week that already had this plan assigned. Otherwise Nutrition "Today" keeps showing
 * the old per-day assignment until "Set as Active" is pressed again.
 */
async function syncDayActivePlanFromScheduleForPlan(
  db: any,
  mealPlanId: number,
): Promise<void> {
  const scheduleRows = (await db
    .getAllAsync('SELECT day_of_week FROM MealPlanSchedule WHERE meal_plan_id = ?', [mealPlanId])
    .catch(() => [])) as { day_of_week: string }[];
  const scheduledDaysExpanded = expandMealPlanScheduleToWeekdayKeys(scheduleRows);

  const dateRows = (await db
    .getAllAsync('SELECT date FROM DayActivePlan WHERE meal_plan_id = ?', [mealPlanId])
    .catch(() => [])) as { date: string }[];
  if (dateRows.length === 0) return;

  const weekMondays = new Set<string>();
  for (const { date } of dateRows) {
    weekMondays.add(getMondayIso(date));
  }

  for (const monday_iso of weekMondays) {
    const weekDates = getWeekDates(monday_iso);
    const mon = weekDates[0];
    const sun = weekDates[6];
    await db.runAsync(
      'DELETE FROM DayActivePlan WHERE meal_plan_id = ? AND date >= ? AND date <= ?',
      [mealPlanId, mon, sun],
    );
    for (const iso of weekDates) {
      const d = new Date(iso + 'T12:00:00');
      const weekdayKey = CAL_WEEKDAY_KEYS[d.getDay()];
      if (scheduledDaysExpanded.size === 0 || scheduledDaysExpanded.has(weekdayKey)) {
        await db.runAsync(
          'INSERT OR REPLACE INTO DayActivePlan (date, meal_plan_id) VALUES (?, ?)',
          [iso, mealPlanId],
        );
      }
    }
  }
}

export default function MealPlanDetail() {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const navigation = useNavigation();
  const route = useRoute();
  const { meal_plan_id, name } = (route.params || {}) as RouteParams;

  const [scheduledDays, setScheduledDays] = useState<Set<string>>(new Set());
  const [prepGuide, setPrepGuide] = useState<string | null>(null);
  const [groceryList, setGroceryList] = useState<string | null>(null);
  const [prepChecked, setPrepChecked] = useState<Set<number>>(new Set());
  const [groceryChecked, setGroceryChecked] = useState<Set<number>>(new Set());
  const [groceryExpanded, setGroceryExpanded] = useState(false);
  const [prepExpanded, setPrepExpanded] = useState(false);
  const [planMeals, setPlanMeals] = useState<PlanMeal[]>([]);

  const planNutritionTotals = useMemo(() => {
    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;
    for (const meal of planMeals) {
      for (const f of meal.foods) {
        calories += Number(f.calories) || 0;
        protein += Number(f.protein) || 0;
        carbs += Number(f.carbs) || 0;
        fat += Number(f.fat) || 0;
      }
    }
    return { calories, protein, carbs, fat };
  }, [planMeals]);

  const loadMeals = useCallback(async () => {
    if (!meal_plan_id) return;
    try {
      const mealRows = await db.getAllAsync<{
        meal_id: number;
        meal_name: string;
        meal_type: string;
        meal_order: number | null;
        food_name: string | null;
        brand: string | null;
        serving_size: string | null;
        calories: number | null;
        protein: number | null;
        carbs: number | null;
        fat: number | null;
      }>(
        `SELECT pm.meal_id,
                pm.meal_name,
                pm.meal_type,
                pm.meal_order,
                fi.food_name,
                fi.brand,
                fi.serving_size,
                fi.calories,
                fi.protein,
                fi.carbs,
                fi.fat
         FROM PlannedMeals pm
         LEFT JOIN FoodItems fi ON fi.meal_id = pm.meal_id
         WHERE pm.meal_plan_id = ?
         ORDER BY pm.meal_order, pm.meal_id, fi.food_id`,
        [meal_plan_id],
      ).catch(() => []);

      const mealMap = new Map<number, PlanMeal>();
      for (const row of mealRows) {
        if (!mealMap.has(row.meal_id)) {
          mealMap.set(row.meal_id, {
            meal_id: row.meal_id,
            meal_name: row.meal_name || 'Meal',
            meal_type: row.meal_type || 'snack',
            meal_order: row.meal_order,
            foods: [],
          });
        }
        if (row.food_name) {
          mealMap.get(row.meal_id)!.foods.push({
            food_name: row.food_name,
            brand: row.brand,
            serving_size: row.serving_size,
            calories: row.calories ?? 0,
            protein: row.protein ?? 0,
            carbs: row.carbs ?? 0,
            fat: row.fat ?? 0,
          });
        }
      }

      let list = Array.from(mealMap.values());

      if (list.length === 0) {
        const items = await db
          .getAllAsync<{
            item_id: number;
            meal_type: string | null;
            food_name: string;
          }>(
            'SELECT item_id, meal_type, food_name FROM MealPlanItems WHERE meal_plan_id = ? ORDER BY sort_order, item_id',
            [meal_plan_id],
          )
          .catch(() => []);

        const byType = new Map<string, PlanMeal>();
        let syntheticId = -1;
        for (const it of items) {
          const t = normalizeMealType(it.meal_type);
          if (!byType.has(t)) {
            byType.set(t, {
              meal_id: syntheticId--,
              meal_name:
                t === 'other'
                  ? 'Items'
                  : `${t.charAt(0).toUpperCase()}${t.slice(1)}`,
              meal_type: t,
              foods: [],
            });
          }
          byType.get(t)!.foods.push({
            food_name: it.food_name,
            brand: null,
            serving_size: null,
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
          });
        }
        list = Array.from(byType.values());
      }

      list.sort((a, b) => {
        const oa = a.meal_order ?? 0;
        const ob = b.meal_order ?? 0;
        if (oa !== ob) return oa - ob;
        return mealTypeSortKey(a.meal_type) - mealTypeSortKey(b.meal_type);
      });

      setPlanMeals(list);
    } catch {
      setPlanMeals([]);
    }
  }, [db, meal_plan_id]);

  const loadPlanDetails = useCallback(async () => {
    if (!meal_plan_id) return;
    try {
      const exists = await db.getFirstAsync<{ meal_plan_id: number }>(
        'SELECT meal_plan_id FROM MealPlans WHERE meal_plan_id = ?',
        [meal_plan_id]
      );
      if (!exists) return;

      await db.runAsync(
        'UPDATE MealPlans SET grocery_list = NULL, prep_guide = NULL WHERE meal_plan_id = ?',
        [meal_plan_id]
      );
      await initNutritionDb(db as any).catch(() => {});
      await generateGroceryListFromPlan(db, meal_plan_id);
      await generatePrepGuideFromPlan(db, meal_plan_id);

      const rows = await db.getAllAsync<{ prep_guide: string | null; grocery_list: string | null }>(
        'SELECT prep_guide, grocery_list FROM MealPlans WHERE meal_plan_id = ?',
        [meal_plan_id]
      );
      if (rows[0]) {
        setPrepGuide(rows[0].prep_guide ?? null);
        setGroceryList(rows[0].grocery_list ?? null);
      }
    } catch (_) {
      setPrepGuide(null);
      setGroceryList(null);
    }
  }, [db, meal_plan_id]);

  const loadSchedule = useCallback(async () => {
    if (!meal_plan_id) return;
    await initMealPlansDb(db);
    const planId = meal_plan_id;
    const rows = await db.getAllAsync<{ day_of_week: string }>(
      'SELECT day_of_week FROM MealPlanSchedule WHERE meal_plan_id = ?',
      [planId]
    );
    const set = new Set<string>();
    for (const r of rows) {
      if (r.day_of_week === 'alternating_a') {
        ALTERNATING_A_DAYS.forEach((d) => set.add(d));
      } else if (r.day_of_week === 'alternating_b') {
        ALTERNATING_B_DAYS.forEach((d) => set.add(d));
      } else {
        set.add(r.day_of_week);
      }
    }
    setScheduledDays(set);
  }, [db, meal_plan_id]);

  const scheduleSummary = useMemo(() => scheduleDaysToSummary(scheduledDays), [scheduledDays]);

  const mealPlanShareText = useMemo(
    () => formatMealPlanShareText(name ?? 'Meal plan', planMeals, scheduleSummary),
    [name, planMeals, scheduleSummary],
  );

  const copyMealPlan = useCallback(async () => {
    try {
      // Dynamic import so startup doesn't require ExpoClipboard native code.
      // Rebuild your dev client with expo-clipboard linked for copy to work.
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(mealPlanShareText);
      Alert.alert('Copied', 'Meal plan copied to the clipboard.');
    } catch (e) {
      console.warn('copyMealPlan', e);
      Alert.alert(
        'Copy unavailable',
        'Clipboard needs native code in your build. Run a new development build, or use Share instead.',
      );
    }
  }, [mealPlanShareText]);

  const shareMealPlan = useCallback(async () => {
    try {
      await Share.share({ message: mealPlanShareText, title: name || 'Meal plan' });
    } catch (e) {
      console.warn('shareMealPlan', e);
    }
  }, [mealPlanShareText, name]);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);
  useEffect(() => {
    loadPlanDetails();
  }, [loadPlanDetails]);
  useFocusEffect(
    useCallback(() => {
      loadPlanDetails();
    }, [loadPlanDetails])
  );

  useEffect(() => {
    loadMeals();
  }, [loadMeals]);

  useFocusEffect(
    useCallback(() => {
      loadMeals();
    }, [loadMeals])
  );
  useEffect(() => {
    setGroceryChecked(new Set());
  }, [groceryList]);

  /** True if scheduledDays equals exactly the given day set (same size and same days). */
  const scheduleMatches = useCallback((optionDays: readonly DayOfWeek[]) => {
    if (scheduledDays.size !== optionDays.length) return false;
    return optionDays.every((d) => scheduledDays.has(d));
  }, [scheduledDays]);

  const toggleDay = async (day: string) => {
    const planId = meal_plan_id;
    if (!planId) return;
    const next = new Set(scheduledDays);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    setScheduledDays(next);
    await db.runAsync('DELETE FROM MealPlanSchedule WHERE meal_plan_id = ?', [planId]);
    for (const d of next) {
      await db.runAsync('INSERT INTO MealPlanSchedule (meal_plan_id, day_of_week) VALUES (?, ?)', [planId, d]);
    }
    try {
      await syncDayActivePlanFromScheduleForPlan(db, planId);
    } catch (e) {
      console.warn('syncDayActivePlanFromScheduleForPlan', e);
    }
  };

  const applyQuick = async (days: DayOfWeek[]) => {
    const planId = meal_plan_id;
    if (!planId) return;
    const next = new Set(days);
    setScheduledDays(next);
    await db.runAsync('DELETE FROM MealPlanSchedule WHERE meal_plan_id = ?', [planId]);
    for (const d of next) {
      await db.runAsync('INSERT INTO MealPlanSchedule (meal_plan_id, day_of_week) VALUES (?, ?)', [planId, d]);
    }
    try {
      await syncDayActivePlanFromScheduleForPlan(db, planId);
    } catch (e) {
      console.warn('syncDayActivePlanFromScheduleForPlan', e);
    }
  };

  const setManualOnly = async () => {
    const planId = meal_plan_id;
    if (!planId) return;
    setScheduledDays(new Set());
    await db.runAsync('DELETE FROM MealPlanSchedule WHERE meal_plan_id = ?', [planId]);
    await db.runAsync("UPDATE MealPlans SET schedule_type = 'manual' WHERE meal_plan_id = ?", [planId]);
    try {
      await syncDayActivePlanFromScheduleForPlan(db, planId);
    } catch (e) {
      console.warn('syncDayActivePlanFromScheduleForPlan', e);
    }
  };

  const setAsActive = () => {
    const today = new Date().toISOString().split('T')[0];
    const plan = { meal_plan_id, name };
    Alert.alert(
      'Set as Active',
      `Set "${name}" as active for this week? Each day (Mon–Sun) will show this plan.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Set as Active',
          onPress: async () => {
            try {
              console.log('[SetAsActive] Step 0: today =', today, 'plan_id =', plan.meal_plan_id);

              // Step 0.5: Mark this plan as active for this whole week (Mon–Sun) in DayActivePlan
              // BUT only on the weekdays it is scheduled for in MealPlanSchedule.
              // Remove only this plan's rows for the current week, then INSERT OR REPLACE the right days.
              const scheduleRows = await db.getAllAsync<{ day_of_week: string }>(
                'SELECT day_of_week FROM MealPlanSchedule WHERE meal_plan_id = ?',
                [plan.meal_plan_id],
              ).catch(() => []);
              // Must expand alternating_a / alternating_b — raw values never match weekday keys.
              const scheduledDays = expandMealPlanScheduleToWeekdayKeys(scheduleRows);
              console.log('[SetAsActive] scheduledDays:', Array.from(scheduledDays), 'scheduleRows:', scheduleRows);

              const DAYS: ('sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat')[] = [
                'sun',
                'mon',
                'tue',
                'wed',
                'thu',
                'fri',
                'sat',
              ];

              const base = new Date(today + 'T12:00:00');
              const day = base.getDay(); // 0=Sun,1=Mon
              const mondayOffset = day === 0 ? -6 : 1 - day;
              const monday = new Date(base);
              monday.setDate(base.getDate() + mondayOffset);
              const monday_iso = monday.toISOString().slice(0, 10);
              const sundayEnd = new Date(monday);
              sundayEnd.setDate(monday.getDate() + 6);
              const sunday_iso = sundayEnd.toISOString().slice(0, 10);

              await db.runAsync(
                'DELETE FROM DayActivePlan WHERE meal_plan_id = ? AND date >= ? AND date <= ?',
                [plan.meal_plan_id, monday_iso, sunday_iso],
              );

              for (let i = 0; i < 7; i++) {
                const d = new Date(monday);
                d.setDate(monday.getDate() + i);
                const iso = d.toISOString().slice(0, 10);
                const weekdayKey = DAYS[d.getDay()]; // 'sun'...'sat'
                if (scheduledDays.size === 0 || scheduledDays.has(weekdayKey)) {
                  // If no schedule rows exist, treat as manual-only: apply to all days.
                  await db.runAsync(
                    'INSERT OR REPLACE INTO DayActivePlan (date, meal_plan_id) VALUES (?, ?)',
                    [iso, plan.meal_plan_id],
                  );
                  console.log('[SetAsActive] inserted DayActivePlan for', iso, 'weekdayKey:', weekdayKey);
                }
              }

              // Step 1: INSERT OR IGNORE into DailyLog
              await db.runAsync(
                'INSERT OR IGNORE INTO DailyLog (log_date, meal_plan_id) VALUES (?, ?)',
                [today, plan.meal_plan_id]
              );
              console.log('[SetAsActive] Step 1: INSERT OR IGNORE DailyLog done');

              // Step 2: UPDATE DailyLog SET meal_plan_id
              await db.runAsync(
                'UPDATE DailyLog SET meal_plan_id = ? WHERE log_date = ?',
                [plan.meal_plan_id, today]
              );
              console.log('[SetAsActive] Step 2: UPDATE DailyLog done');

              // Step 3: GET log_id from DailyLog
              const logRows = await db.getAllAsync<{ log_id: number }>(
                'SELECT log_id FROM DailyLog WHERE log_date = ?',
                [today]
              );
              const logRow = logRows[0];
              console.log('[SetAsActive] Step 3: log_id =', logRow?.log_id);

              if (!logRow) {
                console.log('[SetAsActive] FAIL: no DailyLog row for today');
                navigation.navigate('Nutrition' as never, { activeTab: 'plans' } as never);
                Alert.alert('Error', 'Could not get or create daily log.');
                return;
              }

              // Step 4: DELETE existing LoggedFoods for that log_id
              await db.runAsync('DELETE FROM LoggedFoods WHERE log_id = ?', [logRow.log_id]);
              console.log('[SetAsActive] Step 4: DELETE LoggedFoods done');

              // Step 5: SELECT all foods via PlannedMeals JOIN FoodItems
              const foods = await db.getAllAsync<{
                meal_type: string;
                meal_order: number;
                food_name: string;
                brand: string | null;
                serving_size: string | null;
                calories: number;
                protein: number;
                carbs: number;
                fat: number;
              }>(
                `SELECT pm.meal_type, pm.meal_order, fi.food_name, fi.brand,
                 fi.serving_size, fi.calories, fi.protein, fi.carbs, fi.fat
                 FROM PlannedMeals pm
                 JOIN FoodItems fi ON fi.meal_id = pm.meal_id
                 WHERE pm.meal_plan_id = ?
                 ORDER BY pm.meal_order`,
                [plan.meal_plan_id]
              );
              console.log('[SetAsActive] Step 5: foods from plan =', foods.length);

              // Step 6: INSERT each food into LoggedFoods for today
              let count = 0;
              for (const food of foods) {
                await db.runAsync(
                  `INSERT INTO LoggedFoods (log_id, food_name, brand, meal_type,
                   serving_size, quantity, calories, protein, carbs, fat)
                   VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
                  [
                    logRow.log_id,
                    food.food_name,
                    food.brand,
                    food.meal_type,
                    food.serving_size,
                    food.calories ?? 0,
                    food.protein ?? 0,
                    food.carbs ?? 0,
                    food.fat ?? 0,
                  ]
                );
                count += 1;
              }
              console.log('[SetAsActive] Step 6: LoggedFoods inserted for today =', count);

              // Step 7: Navigate back to meal plan list
              navigation.navigate('Nutrition' as never, { activeTab: 'plans' } as never);
              Alert.alert('Success', 'Meal plan set for this week. Each day will show this plan.');
            } catch (e) {
              console.log('[SetAsActive] error:', e);
              Alert.alert('Error', e instanceof Error ? e.message : 'Failed to set plan as active.');
            }
          },
        },
      ]
    );
  };

  if (!meal_plan_id) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.text }}>Invalid plan</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.planName, { color: theme.text }]} numberOfLines={2}>
          {name}
        </Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={copyMealPlan}
            style={styles.headerIconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Copy meal plan"
          >
            <Ionicons name="copy-outline" size={22} color={SAGE} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={shareMealPlan}
            style={styles.headerIconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Share meal plan"
          >
            <Ionicons name="share-outline" size={22} color={SAGE} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Schedule</Text>
        <Text style={[styles.sectionSub, { color: theme.text }]}>
          {scheduleMatches(ALTERNATING_A_DAYS) ? 'Alternating A (odd weeks)' : scheduleMatches(ALTERNATING_B_DAYS) ? 'Alternating B (even weeks)' : 'Tap days when this plan applies.'}
        </Text>
        <View style={styles.chipRow}>
          {DAYS.map((day) => (
            <TouchableOpacity
              key={day}
              style={[styles.chip, scheduledDays.has(day) && styles.chipActive, { borderColor: theme.border, backgroundColor: scheduledDays.has(day) ? SAGE : theme.card }]}
              onPress={() => toggleDay(day)}
            >
              <Text style={[styles.chipText, { color: scheduledDays.has(day) ? '#fff' : theme.text }]}>{DAY_LABELS[day]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={[styles.quickLabel, { color: theme.text }]}>Quick options</Text>
        <View style={styles.quickRow}>
          <TouchableOpacity style={[styles.quickBtn, { borderColor: theme.border, backgroundColor: scheduleMatches(ALTERNATING_A_DAYS) ? SAGE : theme.card }]} onPress={() => applyQuick(ALTERNATING_A_DAYS)}>
            <Text style={[styles.quickBtnText, { color: scheduleMatches(ALTERNATING_A_DAYS) ? '#fff' : theme.text }]}>Alternating A</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.quickBtn, { borderColor: theme.border, backgroundColor: scheduleMatches(ALTERNATING_B_DAYS) ? SAGE : theme.card }]} onPress={() => applyQuick(ALTERNATING_B_DAYS)}>
            <Text style={[styles.quickBtnText, { color: scheduleMatches(ALTERNATING_B_DAYS) ? '#fff' : theme.text }]}>Alternating B</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.quickRow}>
          <TouchableOpacity style={[styles.quickBtn, { borderColor: theme.border, backgroundColor: scheduleMatches(WEEKDAY_DAYS) ? SAGE : theme.card }]} onPress={() => applyQuick(WEEKDAY_DAYS)}>
            <Text style={[styles.quickBtnText, { color: scheduleMatches(WEEKDAY_DAYS) ? '#fff' : theme.text }]}>Weekdays</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.quickBtn, { borderColor: theme.border, backgroundColor: scheduleMatches(WEEKEND_DAYS) ? SAGE : theme.card }]} onPress={() => applyQuick(WEEKEND_DAYS)}>
            <Text style={[styles.quickBtnText, { color: scheduleMatches(WEEKEND_DAYS) ? '#fff' : theme.text }]}>Weekends</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={[styles.quickBtn, { borderColor: theme.border, alignSelf: 'flex-start' }]} onPress={setManualOnly}>
          <Text style={[styles.quickBtnText, { color: theme.text }]}>Manual only</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={[styles.setActiveBtn, { backgroundColor: SAGE }]} onPress={setAsActive}>
        <Text style={styles.setActiveBtnText}>Set as Active</Text>
      </TouchableOpacity>

      <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>Meals</Text>
        {planMeals.length > 0 ? (
          <View
            style={[
              styles.planNutritionTotals,
              { backgroundColor: theme.background, borderColor: theme.border },
            ]}
          >
            <Text style={[styles.planNutritionTotalsTitle, { color: theme.text }]}>
              Total nutrition
            </Text>
            <Text style={[styles.planNutritionTotalsSub, { color: theme.textSecondary }]}>
              Sum of all foods in this plan (one day)
            </Text>
            <View style={styles.planNutritionGrid}>
              <View style={styles.planNutritionCell}>
                <Text style={[styles.planNutritionValue, { color: theme.text }]}>
                  {Math.round(planNutritionTotals.calories)}
                </Text>
                <Text style={[styles.planNutritionLabel, { color: theme.textSecondary }]}>
                  Calories
                </Text>
              </View>
              <View style={styles.planNutritionCell}>
                <Text style={[styles.planNutritionValue, { color: theme.text }]}>
                  {Math.round(planNutritionTotals.protein * 10) / 10}g
                </Text>
                <Text style={[styles.planNutritionLabel, { color: theme.textSecondary }]}>
                  Protein
                </Text>
              </View>
              <View style={styles.planNutritionCell}>
                <Text style={[styles.planNutritionValue, { color: theme.text }]}>
                  {Math.round(planNutritionTotals.carbs * 10) / 10}g
                </Text>
                <Text style={[styles.planNutritionLabel, { color: theme.textSecondary }]}>
                  Carbs
                </Text>
              </View>
              <View style={styles.planNutritionCell}>
                <Text style={[styles.planNutritionValue, { color: theme.text }]}>
                  {Math.round(planNutritionTotals.fat * 10) / 10}g
                </Text>
                <Text style={[styles.planNutritionLabel, { color: theme.textSecondary }]}>
                  Fat
                </Text>
              </View>
            </View>
          </View>
        ) : null}
        {planMeals.length === 0 ? (
          <Text style={[styles.planMealsEmpty, { color: theme.textSecondary }]}>
            No meals in this plan yet.
          </Text>
        ) : (
          planMeals.map((meal) => (
            <View key={meal.meal_id} style={styles.planMealGroup}>
              <View style={styles.planMealHeaderBlock}>
                <Text style={[styles.planMealHeading, { color: theme.text }]}>{meal.meal_name}</Text>
                <Text style={[styles.planMealTotals, { color: theme.textSecondary }]}>
                  {Math.round(meal.foods.reduce((sum, f) => sum + (f.calories ?? 0), 0))} cal
                  {' · '}P {Math.round(meal.foods.reduce((sum, f) => sum + (f.protein ?? 0), 0) * 10) / 10}g
                  {' · '}C {Math.round(meal.foods.reduce((sum, f) => sum + (f.carbs ?? 0), 0) * 10) / 10}g
                  {' · '}F {Math.round(meal.foods.reduce((sum, f) => sum + (f.fat ?? 0), 0) * 10) / 10}g
                </Text>
              </View>
              {meal.foods.length === 0 ? (
                <Text style={[styles.planFoodLine, { color: theme.textSecondary }]}>No foods listed.</Text>
              ) : (
                meal.foods.map((food, idx) => (
                  <Text
                    key={`${meal.meal_id}_${idx}`}
                    style={[styles.planFoodLine, { color: theme.textSecondary }]}
                  >
                    {food.food_name}
                    {food.serving_size ? ` · ${food.serving_size}` : ''}
                    {` · ${Math.round(food.calories)} cal`}
                  </Text>
                ))
              )}
            </View>
          ))
        )}
      </View>

      {/* Per-plan grocery list and prep guide UI moved to combined weekly view in Meal Plans tab */}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  backBtn: { marginRight: 12 },
  planName: { fontSize: 22, fontWeight: '700', flex: 1, flexShrink: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', marginLeft: 4 },
  headerIconBtn: { padding: 6 },
  section: { padding: 16, borderRadius: 12, borderWidth: 1, marginBottom: 20 },
  collapseHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sectionTitleCollapse: { fontSize: 18, fontWeight: '700' },
  sectionSub: { fontSize: 13, marginBottom: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  chipActive: {},
  chipText: { fontSize: 14, fontWeight: '600' },
  quickLabel: { fontSize: 14, fontWeight: '600', marginBottom: 8 },
  quickRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  quickBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1 },
  quickBtnText: { fontSize: 14 },
  setActiveBtn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginBottom: 20 },
  setActiveBtnText: { color: '#fff', fontWeight: '700' },
  planMealsEmpty: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  planNutritionTotals: {
    marginTop: 12,
    marginBottom: 4,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  planNutritionTotalsTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  planNutritionTotalsSub: { fontSize: 12, lineHeight: 16, marginBottom: 12 },
  planNutritionGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  planNutritionCell: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  planNutritionValue: { fontSize: 17, fontWeight: '700', marginBottom: 2 },
  planNutritionLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 },
  planMealGroup: { marginTop: 14 },
  planMealHeaderBlock: { marginBottom: 4 },
  planMealHeading: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  planMealTotals: { fontSize: 12, lineHeight: 18, marginBottom: 8 },
  planFoodLine: { fontSize: 14, lineHeight: 22, marginBottom: 4, paddingLeft: 2 },
  bodyText: { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  emptyHint: { fontSize: 14, marginBottom: 8 },
  groceryListBlock: { marginBottom: 4 },
  groceryLine: { fontSize: 15, lineHeight: 24 },
  groceryCategory: { fontWeight: '700' },
  sectionActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  iconBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, gap: 6 },
  iconBtnText: { fontSize: 14, fontWeight: '600' },
  askSageBtn: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, marginTop: 8 },
  askSageBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  prepLine: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  prepLineText: { flex: 1, fontSize: 15 },
  prepLineDone: { textDecorationLine: 'line-through', opacity: 0.7 },
});
