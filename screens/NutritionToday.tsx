/**
 * Today tab: active plan, macro rings, meal sections (Breakfast, Snack, Lunch, Dinner),
 * swipe Edit/Delete per food, quantity modal, recalc totals.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { initMealPlansDb, type DayOfWeek } from '../utils/initMealPlansDb';
import { initNutritionDb } from '../utils/nutritionDb';
import { foodItemServingToTrackerFields } from '../utils/foodItemServingToTrackerRow';
import { isPieceServingUnit, preferSizeUnitOverWholeServingText } from '../utils/getRelevantUnits';
import AddFoodModal from './AddFoodModal';

function favoriteSignature(name: string, brand: string | null): string {
  return `${name}|${brand ?? ''}`;
}

const SAGE = '#7C9A7E';
const UNIT_OPTIONS = ['g', 'oz', 'serving', 'whole', 'medium', 'large', 'small', 'cup', 'tbsp', 'tsp', 'ml', 'lb'];
const MEAL_ORDER: string[] = ['Breakfast', 'Snack', 'Lunch', 'Dinner'];

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

/** Ensure DailyLog exists for date and copy plan foods into LoggedFoods. When forceReloadFromPlan is true, always clear and re-insert from the plan (e.g. when SOURCE=schedule for the selected date). */
async function ensureDailyLogAndPrefillFoods(
  db: SQLiteDatabase,
  logDate: string,
  mealPlanId: number,
  forceReloadFromPlan: boolean = false
): Promise<void> {
  await db.runAsync(
    'INSERT OR IGNORE INTO DailyLog (log_date, meal_plan_id) VALUES (?, ?)',
    [logDate, mealPlanId]
  );
  await db.runAsync('UPDATE DailyLog SET meal_plan_id = ? WHERE log_date = ?', [mealPlanId, logDate]);
  const logRows = await db.getAllAsync<{ log_id: number; meal_plan_id: number }>('SELECT log_id, meal_plan_id FROM DailyLog WHERE log_date = ?', [logDate]);
  const logId = logRows[0]?.log_id;
  const dailyLogPlanId = logRows[0]?.meal_plan_id;
  if (logId == null) return;
  const existing = await db.getAllAsync<{ count: number }>('SELECT COUNT(*) as count FROM LoggedFoods WHERE log_id = ?', [logId]).catch(() => [{ count: 0 }]);
  const hasFoods = (existing[0]?.count ?? 0) > 0;
  if (!forceReloadFromPlan && hasFoods && dailyLogPlanId === mealPlanId) return;
  if (hasFoods || forceReloadFromPlan) {
    await db.runAsync('DELETE FROM LoggedFoods WHERE log_id = ?', [logId]);
  }
  const foods = await db.getAllAsync<{
    meal_type: string;
    food_name: string;
    brand: string | null;
    serving_size: string | null;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  }>(
    `SELECT pm.meal_type, fi.food_name, fi.brand, fi.serving_size, fi.calories, fi.protein, fi.carbs, fi.fat
     FROM PlannedMeals pm JOIN FoodItems fi ON fi.meal_id = pm.meal_id
     WHERE pm.meal_plan_id = ? ORDER BY pm.meal_order`,
    [mealPlanId]
  ).catch(() => []);
  for (const f of foods) {
    const { quantity, unitToken } = foodItemServingToTrackerFields(f.serving_size);
    await db.runAsync(
      `INSERT INTO LoggedFoods (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [logId, f.food_name, f.brand, f.meal_type, unitToken, quantity, f.calories ?? 0, f.protein ?? 0, f.carbs ?? 0, f.fat ?? 0]
    ).catch(() => {});
  }
}

function gramsPerUnit(unit: string): number {
  switch (unit) {
    case 'g': return 1;
    case 'oz': return 28.35;
    case 'serving': return 100;
    case 'whole':
    case 'medium':
    case 'large':
    case 'small':
      return 100;
    case 'cup': return 240;
    case 'tbsp': return 15;
    case 'tsp': return 5;
    case 'ml': return 1;
    case 'lb': return 453.59;
    default: return 100;
  }
}

function computedMacrosFromPer100(
  per100: { calories: number; protein: number; carbs: number; fat: number },
  quantity: number,
  unit: string
): { calories: number; protein: number; carbs: number; fat: number } {
  if (isPieceServingUnit(unit)) {
    return {
      calories: Math.round(per100.calories * quantity),
      protein: Math.round(per100.protein * quantity * 10) / 10,
      carbs: Math.round(per100.carbs * quantity * 10) / 10,
      fat: Math.round(per100.fat * quantity * 10) / 10,
    };
  }
  const grams = quantity * gramsPerUnit(unit);
  const factor = grams / 100;
  return {
    calories: Math.round(per100.calories * factor),
    protein: Math.round(per100.protein * factor * 10) / 10,
    carbs: Math.round(per100.carbs * factor * 10) / 10,
    fat: Math.round(per100.fat * factor * 10) / 10,
  };
}

function per100FromTotals(
  quantity: number,
  unit: string,
  calories: number,
  protein: number,
  carbs: number,
  fat: number
): { calories: number; protein: number; carbs: number; fat: number } {
  const grams = quantity * gramsPerUnit(unit);
  if (grams <= 0) return { calories, protein, carbs, fat };
  const factor = 100 / grams;
  return {
    calories: Math.round(calories * factor * 10) / 10,
    protein: Math.round(protein * factor * 100) / 100,
    carbs: Math.round(carbs * factor * 100) / 100,
    fat: Math.round(fat * factor * 100) / 100,
  };
}

/**
 * Edit modal only: if serving/unit text starts with a vulgar fraction (e.g. "1/4 avocado (50g)", "1/2 cup"),
 * show quantity as the decimal value of that fraction and unit as the remainder. Save path unchanged.
 */
function quantityAndUnitForEditForm(
  storedQuantity: number,
  unitOrServingSize: string,
): { quantityStr: string; unitStr: string } {
  const raw = String(unitOrServingSize ?? '').trim();
  if (!raw) {
    return { quantityStr: String(storedQuantity || 1), unitStr: preferSizeUnitOverWholeServingText('serving') };
  }
  const m = raw.match(/^\s*(\d+)\s*\/\s*(\d+)(?:\s+(.*))?$/);
  if (!m) {
    return {
      quantityStr: String(storedQuantity || 1),
      unitStr: preferSizeUnitOverWholeServingText(raw),
    };
  }
  const num = parseInt(m[1], 10);
  const den = parseInt(m[2], 10);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0 || num < 0) {
    return {
      quantityStr: String(storedQuantity || 1),
      unitStr: preferSizeUnitOverWholeServingText(raw),
    };
  }
  const frac = num / den;
  if (!Number.isFinite(frac)) {
    return {
      quantityStr: String(storedQuantity || 1),
      unitStr: preferSizeUnitOverWholeServingText(raw),
    };
  }
  const rest = (m[3] ?? '').trim();
  const qtyDecimal = frac;
  let quantityStr: string;
  if (Number.isInteger(qtyDecimal)) {
    quantityStr = String(qtyDecimal);
  } else {
    quantityStr = parseFloat(qtyDecimal.toFixed(6)).toString();
  }
  return {
    quantityStr,
    unitStr: preferSizeUnitOverWholeServingText(rest || 'serving'),
  };
}
const MEAL_TYPES = ['breakfast', 'snack', 'lunch', 'dinner'] as const;
const MEAL_LABELS: Record<(typeof MEAL_TYPES)[number], string> = {
  breakfast: 'Breakfast',
  snack: 'Snack',
  lunch: 'Lunch',
  dinner: 'Dinner',
};

function formatYmd(d: Date): string {
  return d.toISOString().split('T')[0];
}
function addDays(iso: string, delta: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return formatYmd(d);
}
function formatDateLabel(iso: string, todayIso: string): string {
  if (iso === todayIso) return 'Today';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
function getDayOfWeekForDate(iso: string): (typeof DAYS)[number] {
  return DAYS[new Date(iso + 'T12:00:00').getDay()];
}

export type LoggedFood = {
  logged_food_id: number;
  log_date: string;
  meal_type: string | null;
  food_name: string;
  brand: string | null;
  quantity: number;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

function formatQtyForList(n: number): string {
  if (!Number.isFinite(n)) return '1';
  if (Number.isInteger(n)) return String(n);
  return parseFloat(n.toFixed(4)).toString();
}

/** One line for meal list: "1 cup", "2 oz"; if unit starts with a fraction, effective amount is quantity × fraction. */
function formatFoodPortionListLine(food: LoggedFood): string {
  const q = food.quantity ?? 1;
  const raw = String(food.unit ?? 'serving').trim();
  if (!raw) {
    return `${formatQtyForList(q)} serving${q === 1 ? '' : 's'}`;
  }
  const lower = raw.toLowerCase();
  if (lower === 'serving' || lower === 'servings') {
    return `${formatQtyForList(q)} ${q === 1 ? 'serving' : 'servings'}`;
  }
  const m = raw.match(/^\s*(\d+)\s*\/\s*(\d+)(?:\s+(.*))?$/);
  if (m) {
    const num = parseInt(m[1], 10);
    const den = parseInt(m[2], 10);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num >= 0) {
      const frac = num / den;
      if (Number.isFinite(frac)) {
        const rest = (m[3] ?? '').trim() || 'serving';
        const total = q * frac;
        return `${formatQtyForList(total)} ${rest}`.trim();
      }
    }
  }
  return `${formatQtyForList(q)} ${raw}`.trim();
}

type MealMacroTotals = { calories: number; protein: number; carbs: number; fat: number };

function sumMealNutrition(foodsInMeal: LoggedFood[]): MealMacroTotals {
  return foodsInMeal.reduce(
    (acc, f) => ({
      calories: acc.calories + (Number(f.calories) || 0),
      protein: acc.protein + (Number(f.protein) || 0),
      carbs: acc.carbs + (Number(f.carbs) || 0),
      fat: acc.fat + (Number(f.fat) || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

function formatMealTotalsLine(t: MealMacroTotals): string {
  return `${Math.round(t.calories)} cal · ${Math.round(t.protein)}g P · ${Math.round(t.carbs)}g C · ${Math.round(t.fat)}g F`;
}

type PlanInfo = { meal_plan_id: number; name: string };

type NutritionTodayProps = {
  selectedDate: string; // YYYY-MM-DD
  onLoadPlan?: (planId: number) => void;
  reload?: number; // timestamp to force refetch (e.g. after Set as Active)
};

export default function NutritionToday({ selectedDate, onLoadPlan, reload }: NutritionTodayProps) {
  const isLoadingRef = useRef(false);
  const insets = useSafeAreaInsets();
  const windowHeight = Dimensions.get('window').height;
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const [scheduledPlan, setScheduledPlan] = useState<PlanInfo | null>(null);
  const [overridePlan, setOverridePlan] = useState<PlanInfo | null>(null);
  const [activePlanName, setActivePlanName] = useState<string>('Rest Day');
  const [foods, setFoods] = useState<LoggedFood[]>([]);
  const [totals, setTotals] = useState({ calories: 0, protein: 0, carbs: 0, fat: 0 });
  const [loading, setLoading] = useState(true);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingFood, setEditingFood] = useState<LoggedFood | null>(null);
  const [editForm, setEditForm] = useState({ food_name: '', brand: '', quantity: '1', unit: 'serving', meal_type: 'Breakfast', calories: '0', protein: '0', carbs: '0', fat: '0' });
  const [editPer100, setEditPer100] = useState<{ calories: number; protein: number; carbs: number; fat: number } | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMealType, setAddMealType] = useState<string>('breakfast');
  /** When non-null, AddFoodModal updates this row instead of inserting. */
  const [replaceLoggedFoodId, setReplaceLoggedFoodId] = useState<number | null>(null);
  const [unitDropdownOpen, setUnitDropdownOpen] = useState(false);
  const [planDebug, setPlanDebug] = useState<{ scheduleRows: number; dayOfWeek: string; source: string; planName: string } | null>(null);
  const [favoritedSignatures, setFavoritedSignatures] = useState<Set<string>>(new Set());
  const [foodForActions, setFoodForActions] = useState<LoggedFood | null>(null);

  const loadFavoritedSignatures = useCallback(async () => {
    try {
      await initNutritionDb(db);
      const rows = await db.getAllAsync<{ food_name: string; brand: string | null }>('SELECT food_name, brand FROM FavoriteFoods');
      setFavoritedSignatures(new Set(rows.map((r) => favoriteSignature(r.food_name, r.brand))));
    } catch (_) {}
  }, [db]);

  const toggleFavoriteForFood = useCallback(async (food: LoggedFood) => {
    const sig = favoriteSignature(food.food_name, food.brand);
    try {
      await initNutritionDb(db);
      if (favoritedSignatures.has(sig)) {
        await db.runAsync(
          "DELETE FROM FavoriteFoods WHERE food_name = ? AND (COALESCE(brand,'') = COALESCE(?,''))",
          [food.food_name, food.brand]
        );
        setFavoritedSignatures((prev) => { const n = new Set(prev); n.delete(sig); return n; });
      } else {
        await db.runAsync(
          'INSERT INTO FavoriteFoods (food_name, brand, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?)',
          [food.food_name, food.brand, food.calories ?? 0, food.protein ?? 0, food.carbs ?? 0, food.fat ?? 0]
        );
        setFavoritedSignatures((prev) => new Set([...prev, sig]));
      }
    } catch (_) {}
  }, [db, favoritedSignatures]);

  const todayIso = formatYmd(new Date());
  const isToday = selectedDate === todayIso;
  const dayOfWeek = getDayOfWeekForDate(selectedDate);

  const loadLoggedFoods = useCallback(async () => {
    const todayIsoForLoad = formatYmd(new Date());
    // When viewing today, try DailyLog + LoggedFoods (log_id) first (Set as Active flow)
    if (selectedDate === todayIsoForLoad) {
      try {
        await initMealPlansDb(db);
        const logRows = await db.getAllAsync<{ log_id: number; meal_plan_id: number | null }>(
          'SELECT log_id, meal_plan_id FROM DailyLog WHERE log_date = ?',
          [selectedDate],
        );
        let logRow = logRows[0];
        if (logRow != null && logRow.meal_plan_id != null) {
          const dapOk = await db
            .getAllAsync<{ n: number }>(
              'SELECT 1 AS n FROM DayActivePlan WHERE date = ? AND meal_plan_id = ? LIMIT 1',
              [selectedDate, logRow.meal_plan_id],
            )
            .catch(() => [] as { n: number }[]);
          if (dapOk.length === 0) {
            await initNutritionDb(db);
            await db.runAsync('UPDATE DailyLog SET meal_plan_id = NULL WHERE log_date = ?', [selectedDate]);
            await db.runAsync('DELETE FROM LoggedFoods WHERE log_id = ?', [logRow.log_id]);
            logRow = { log_id: logRow.log_id, meal_plan_id: null };
          }
        }
        if (logRow) {
          const rows = await db.getAllAsync<{
            logged_food_id: number;
            food_name: string;
            brand: string | null;
            meal_type: string | null;
            serving_size: string | null;
            quantity: number;
            calories: number;
            protein: number;
            carbs: number;
            fat: number;
          }>(
            'SELECT logged_food_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat FROM LoggedFoods WHERE log_id = ? ORDER BY meal_type, logged_food_id',
            [logRow.log_id]
          );
          const mapped: LoggedFood[] = rows.map((r) => ({
            logged_food_id: r.logged_food_id,
            log_date: selectedDate,
            meal_type: r.meal_type,
            food_name: r.food_name,
            brand: r.brand,
            quantity: r.quantity ?? 1,
            unit: r.serving_size ?? 'serving',
            calories: r.calories ?? 0,
            protein: r.protein ?? 0,
            carbs: r.carbs ?? 0,
            fat: r.fat ?? 0,
          }));
          setFoods(mapped);
          const t = mapped.reduce(
            (acc, f) => ({
              calories: acc.calories + (f.calories ?? 0),
              protein: acc.protein + (f.protein ?? 0),
              carbs: acc.carbs + (f.carbs ?? 0),
              fat: acc.fat + (f.fat ?? 0),
            }),
            { calories: 0, protein: 0, carbs: 0, fat: 0 }
          );
          setTotals(t);
          return;
        }
      } catch (_) {
        // Fall through to log_date query
      }
    }
    // Fallback: LoggedFoods has log_id; join through DailyLog by log_date
    await initMealPlansDb(db);
    const rows = await db.getAllAsync<{
      logged_food_id: number;
      log_date: string;
      meal_type: string | null;
      food_name: string;
      brand: string | null;
      quantity: number;
      serving_size: string | null;
      calories: number;
      protein: number;
      carbs: number;
      fat: number;
    }>(
      'SELECT lf.logged_food_id, dl.log_date, lf.meal_type, lf.food_name, lf.brand, lf.quantity, lf.serving_size, lf.calories, lf.protein, lf.carbs, lf.fat FROM LoggedFoods lf JOIN DailyLog dl ON lf.log_id = dl.log_id WHERE dl.log_date = ? ORDER BY lf.meal_type, lf.logged_food_id',
      [selectedDate]
    ).catch(() => []);
    const mapped: LoggedFood[] = rows.map((r) => ({
      logged_food_id: r.logged_food_id,
      log_date: r.log_date,
      meal_type: r.meal_type,
      food_name: r.food_name,
      brand: r.brand,
      quantity: r.quantity ?? 1,
      unit: r.serving_size ?? 'serving',
      calories: r.calories ?? 0,
      protein: r.protein ?? 0,
      carbs: r.carbs ?? 0,
      fat: r.fat ?? 0,
    }));
    setFoods(mapped);
    const t = mapped.reduce(
      (acc, f) => ({
        calories: acc.calories + (f.calories ?? 0),
        protein: acc.protein + (f.protein ?? 0),
        carbs: acc.carbs + (f.carbs ?? 0),
        fat: acc.fat + (f.fat ?? 0),
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );
    setTotals(t);
  }, [db, selectedDate]);

  const deleteAllFoodsForDate = useCallback(() => {
    Alert.alert(
      'Delete all meals?',
      'This will remove all logged foods for this day.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await initNutritionDb(db);
              await db.runAsync(
                `DELETE FROM LoggedFoods WHERE log_id IN (SELECT log_id FROM DailyLog WHERE log_date = ?)`,
                [selectedDate],
              );
              await loadLoggedFoods();
            } catch (e) {
              console.error('Error deleting all foods for date:', e);
            }
          },
        },
      ],
    );
  }, [db, loadLoggedFoods, selectedDate]);

  const loadState = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    try {
      const allRows = await db.getAllAsync('SELECT * FROM DayActivePlan ORDER BY date');
      console.log('[DayActivePlan ALL ROWS]', JSON.stringify(allRows));
      try {
        // One-time cleanup: remove duplicate DayActivePlan rows for same date
        await db.runAsync(`
          DELETE FROM DayActivePlan 
          WHERE id NOT IN (
            SELECT MIN(id) FROM DayActivePlan GROUP BY date, meal_plan_id
          )
        `);
      } catch {
        // ignore if table missing, SQLite quirk, etc.
      }
      if (__DEV__) setPlanDebug(null);
      await initMealPlansDb(db);

      // 1) Use DayActivePlan override for this exact date (user explicitly set plan active)
      let override: { meal_plan_id: number; plan_name: string }[] = [];
      console.log('[loadState] selectedDate:', selectedDate);
      override = await db
        .getAllAsync(
          `SELECT p.meal_plan_id, COALESCE(p.plan_name, p.name) AS plan_name
           FROM DayActivePlan d
           JOIN MealPlans p ON p.meal_plan_id = d.meal_plan_id
           WHERE d.date = ?`,
          [selectedDate],
        )
        .catch(() => []);
      if (override.length > 0) {
        const displayName = override.length > 1
          ? override.map((o) => o.plan_name).join(', ')
          : override[0].plan_name;
        if (__DEV__) {
          console.log('[PlanDebug] SOURCE=DayActivePlan plan=', displayName);
          setPlanDebug({ scheduleRows: 0, dayOfWeek: '', source: 'DayActivePlan', planName: displayName });
        }
        setOverridePlan({ meal_plan_id: override[0].meal_plan_id, name: override[0].plan_name });
        setActivePlanName(displayName);
        setScheduledPlan(null);
        if (selectedDate === todayIso) {
          // Today: persist to DailyLog + LoggedFoods, then load from DB.
          const targetPlanId = override[0].meal_plan_id;
          const logRows = await db
            .getAllAsync<{ log_id: number; meal_plan_id: number | null }>(
              'SELECT log_id, meal_plan_id FROM DailyLog WHERE log_date = ?',
              [selectedDate],
            )
            .catch(() => [] as { log_id: number; meal_plan_id: number | null }[]);
          const logRow = logRows[0];
          const currentPlanId = logRow?.meal_plan_id;
          const planMismatch =
            logRow == null ||
            currentPlanId == null ||
            Number(currentPlanId) !== Number(targetPlanId);

          if (planMismatch) {
            await db.runAsync(
              'INSERT OR IGNORE INTO DailyLog (log_date, meal_plan_id) VALUES (?, ?)',
              [selectedDate, targetPlanId],
            );
            await db.runAsync('UPDATE DailyLog SET meal_plan_id = ? WHERE log_date = ?', [
              targetPlanId,
              selectedDate,
            ]);
            const again = await db.getAllAsync<{ log_id: number }>(
              'SELECT log_id FROM DailyLog WHERE log_date = ?',
              [selectedDate],
            );
            const logId = again[0]?.log_id;
            if (logId != null) {
              await db.runAsync('DELETE FROM LoggedFoods WHERE log_id = ?', [logId]);
              const foods = await db
                .getAllAsync<{
                  meal_type: string;
                  food_name: string;
                  brand: string | null;
                  serving_size: string | null;
                  calories: number;
                  protein: number;
                  carbs: number;
                  fat: number;
                }>(
                  `SELECT pm.meal_type, fi.food_name, fi.brand, fi.serving_size, fi.calories, fi.protein, fi.carbs, fi.fat
                   FROM PlannedMeals pm
                   JOIN FoodItems fi ON fi.meal_id = pm.meal_id
                   WHERE pm.meal_plan_id = ?
                   ORDER BY pm.meal_order, fi.food_id`,
                  [targetPlanId],
                )
                .catch(() => []);
              for (const f of foods) {
                const { quantity, unitToken } = foodItemServingToTrackerFields(f.serving_size);
                await db
                  .runAsync(
                    `INSERT INTO LoggedFoods (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                      logId,
                      f.food_name,
                      f.brand,
                      f.meal_type,
                      unitToken,
                      quantity,
                      f.calories ?? 0,
                      f.protein ?? 0,
                      f.carbs ?? 0,
                      f.fat ?? 0,
                    ],
                  )
                  .catch(() => {});
              }
            }
          } else {
            for (const plan of override) {
              await ensureDailyLogAndPrefillFoods(db, selectedDate, plan.meal_plan_id, false);
            }
          }
          await loadLoggedFoods();
        } else {
          // Other days: show planned foods only — do not write LoggedFoods.
          const mealPlanId = override[0].meal_plan_id;
          const planRows = await db
            .getAllAsync<{
              meal_type: string;
              food_name: string;
              brand: string | null;
              serving_size: string | null;
              calories: number;
              protein: number;
              carbs: number;
              fat: number;
            }>(
              `SELECT pm.meal_type, fi.food_name, fi.brand, fi.serving_size, fi.calories, fi.protein, fi.carbs, fi.fat
               FROM PlannedMeals pm
               JOIN FoodItems fi ON fi.meal_id = pm.meal_id
               WHERE pm.meal_plan_id = ?
               ORDER BY pm.meal_order, fi.food_id`,
              [mealPlanId],
            )
            .catch(() => []);
          const mapped: LoggedFood[] = planRows.map((r, i) => ({
            logged_food_id: -(i + 1),
            log_date: selectedDate,
            meal_type: r.meal_type,
            food_name: r.food_name,
            brand: r.brand,
            quantity: 1,
            unit: r.serving_size ?? 'serving',
            calories: r.calories ?? 0,
            protein: r.protein ?? 0,
            carbs: r.carbs ?? 0,
            fat: r.fat ?? 0,
          }));
          setFoods(mapped);
          setTotals(
            mapped.reduce(
              (acc, f) => ({
                calories: acc.calories + (f.calories ?? 0),
                protein: acc.protein + (f.protein ?? 0),
                carbs: acc.carbs + (f.carbs ?? 0),
                fat: acc.fat + (f.fat ?? 0),
              }),
              { calories: 0, protein: 0, carbs: 0, fat: 0 },
            ),
          );
        }
        loadFavoritedSignatures();
        return;
      }
      // 2) No DayActivePlan for this date: treat as Rest Day (no active meal plan).
      if (__DEV__) {
        console.log('[PlanDebug] SOURCE=Rest Day (no DayActivePlan)');
        setPlanDebug({ scheduleRows: 0, dayOfWeek: '', source: 'Rest Day', planName: 'Rest Day' });
      }
      setScheduledPlan(null);
      setOverridePlan(null);
      setActivePlanName('Rest Day');
      await loadLoggedFoods();
      loadFavoritedSignatures();
    } catch (e) {
      console.log('loadTodaysFoods error:', e);
      if (__DEV__) setPlanDebug({ scheduleRows: -1, dayOfWeek: '', source: 'error', planName: String(e) });
      setFoods([]);
      setTotals({ calories: 0, protein: 0, carbs: 0, fat: 0 });
    } finally {
      isLoadingRef.current = false;
      setLoading(false);
    }
  }, [selectedDate, todayIso, db, loadLoggedFoods, loadFavoritedSignatures]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    if (reload != null) {
      loadState();
    }
  }, [reload, loadState]);

  // Force loading to false after 2s so empty sections can render
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 2000);
    return () => clearTimeout(t);
  }, [loading]);

  const openEdit = (food: LoggedFood) => {
    setEditingFood(food);
    const q = food.quantity || 1;
    const { quantityStr, unitStr } = quantityAndUnitForEditForm(food.quantity ?? 1, food.unit || 'serving');
    const per100 = per100FromTotals(q, unitStr, food.calories ?? 0, food.protein ?? 0, food.carbs ?? 0, food.fat ?? 0);
    setEditPer100(per100);
    setEditForm({
      food_name: food.food_name,
      brand: food.brand ?? '',
      quantity: quantityStr,
      unit: unitStr,
      meal_type: food.meal_type || 'Lunch',
      calories: String(food.calories ?? 0),
      protein: String(food.protein ?? 0),
      carbs: String(food.carbs ?? 0),
      fat: String(food.fat ?? 0),
    });
    setUnitDropdownOpen(false);
    setEditModalVisible(true);
  };

  const updateEditQuantity = (v: string) => {
    const qty = parseFloat(v) || 0;
    if (editPer100) {
      const computed = computedMacrosFromPer100(editPer100, qty, editForm.unit);
      setEditForm((f) => ({ ...f, quantity: v, calories: String(computed.calories), protein: String(computed.protein), carbs: String(computed.carbs), fat: String(computed.fat) }));
    } else setEditForm((f) => ({ ...f, quantity: v }));
  };

  const updateEditUnit = (u: string) => {
    setUnitDropdownOpen(false);
    const qty = parseFloat(editForm.quantity) || 0;
    if (editPer100) {
      const computed = computedMacrosFromPer100(editPer100, qty, u);
      setEditForm((f) => ({ ...f, unit: u, calories: String(computed.calories), protein: String(computed.protein), carbs: String(computed.carbs), fat: String(computed.fat) }));
    } else setEditForm((f) => ({ ...f, unit: u }));
  };

  const saveEdit = async () => {
    if (!editingFood) return;
    const q = parseFloat(editForm.quantity) || 0;
    const cal = parseFloat(editForm.calories) || 0;
    const pro = parseFloat(editForm.protein) || 0;
    const carb = parseFloat(editForm.carbs) || 0;
    const f = parseFloat(editForm.fat) || 0;
    const args = [editForm.food_name.trim() || editingFood.food_name, editForm.brand.trim() || null, q, editForm.unit, editForm.meal_type, cal, pro, carb, f, editingFood.logged_food_id];
    try {
      await db.runAsync(
        'UPDATE LoggedFoods SET food_name = ?, brand = ?, quantity = ?, unit = ?, meal_type = ?, calories = ?, protein = ?, carbs = ?, fat = ? WHERE logged_food_id = ?',
        args
      );
    } catch (_) {
      await db.runAsync(
        'UPDATE LoggedFoods SET food_name = ?, brand = ?, quantity = ?, serving_size = ?, meal_type = ?, calories = ?, protein = ?, carbs = ?, fat = ? WHERE logged_food_id = ?',
        args
      );
    }
    closeEditModal();
    loadLoggedFoods();
  };

  const closeEditModal = useCallback(() => {
    setEditModalVisible(false);
    setEditingFood(null);
    setUnitDropdownOpen(false);
    setEditPer100(null);
  }, []);

  const openChangeFoodFromEdit = useCallback(() => {
    if (!editingFood) return;
    const m = (editingFood.meal_type || 'lunch').toLowerCase();
    const validMeal = MEAL_TYPES.includes(m as (typeof MEAL_TYPES)[number]) ? m : 'lunch';
    setAddMealType(validMeal);
    setReplaceLoggedFoodId(editingFood.logged_food_id);
    setEditModalVisible(false);
    setEditingFood(null);
    setEditPer100(null);
    setUnitDropdownOpen(false);
    setShowAddModal(true);
  }, [editingFood]);

  const confirmDelete = (food: LoggedFood) => {
    const mealLabel = food.meal_type || 'meal';
    Alert.alert(
      'Remove food?',
      `Remove ${food.food_name} from ${mealLabel}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await db.runAsync('DELETE FROM LoggedFoods WHERE logged_food_id = ?', [food.logged_food_id]);
            loadLoggedFoods();
          },
        },
      ]
    );
  };

  const closeFoodActionsModal = useCallback(() => {
    setFoodForActions(null);
  }, []);

  const runFoodActionEdit = () => {
    if (!foodForActions) return;
    const f = foodForActions;
    setFoodForActions(null);
    openEdit(f);
  };

  const runFoodActionDelete = () => {
    if (!foodForActions) return;
    const f = foodForActions;
    setFoodForActions(null);
    confirmDelete(f);
  };

  const { foodsByMealType, mealSubtotals } = useMemo(() => {
    const normalized = (m: string | null) => (m || 'Lunch').toLowerCase();
    const breakfast: LoggedFood[] = [];
    const snack: LoggedFood[] = [];
    const lunch: LoggedFood[] = [];
    const dinner: LoggedFood[] = [];
    for (const f of foods) {
      const key = normalized(f.meal_type);
      if (key === 'breakfast') breakfast.push(f);
      else if (key === 'snack') snack.push(f);
      else if (key === 'lunch') lunch.push(f);
      else if (key === 'dinner') dinner.push(f);
    }
    const byMeal = { breakfast, snack, lunch, dinner };
    return {
      foodsByMealType: byMeal,
      mealSubtotals: {
        breakfast: sumMealNutrition(breakfast),
        snack: sumMealNutrition(snack),
        lunch: sumMealNutrition(lunch),
        dinner: sumMealNutrition(dinner),
      },
    };
  }, [foods]);

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={SAGE} />
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={styles.content}>
      {isToday && (
        <Text style={[styles.planSubtitle, { color: theme.text }]}>{activePlanName}</Text>
      )}

      <View style={[styles.macroCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.macroTitle, { color: theme.text }]}>This Week&apos;s totals</Text>
        <View style={styles.macroRow}>
          <View style={styles.macroItem}>
            <Text style={[styles.macroValue, { color: SAGE }]}>{Math.round(totals.calories)}</Text>
            <Text style={[styles.macroLabel, { color: theme.text }]}>cal</Text>
          </View>
          <View style={styles.macroItem}>
            <Text style={[styles.macroValue, { color: theme.text }]}>{Math.round(totals.protein)}g</Text>
            <Text style={[styles.macroLabel, { color: theme.text }]}>protein</Text>
          </View>
          <View style={styles.macroItem}>
            <Text style={[styles.macroValue, { color: theme.text }]}>{Math.round(totals.carbs)}g</Text>
            <Text style={[styles.macroLabel, { color: theme.text }]}>carbs</Text>
          </View>
          <View style={styles.macroItem}>
            <Text style={[styles.macroValue, { color: theme.text }]}>{Math.round(totals.fat)}g</Text>
            <Text style={[styles.macroLabel, { color: theme.text }]}>fat</Text>
          </View>
        </View>
      </View>

      {MEAL_TYPES.map((mealType) => (
        <View key={mealType} style={[styles.mealSection, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.mealSectionTitle, { color: theme.text }]}>{MEAL_LABELS[mealType].toUpperCase()}</Text>
          <Text style={[styles.mealTotalsLine, { color: theme.textSecondary ?? '#888' }]}>
            {formatMealTotalsLine(mealSubtotals[mealType])}
          </Text>
          {foodsByMealType[mealType]?.length > 0 ? (
            foodsByMealType[mealType].map((food) => (
              <FoodRow
                key={food.logged_food_id}
                food={food}
                theme={theme}
                isFavorited={favoritedSignatures.has(favoriteSignature(food.food_name, food.brand))}
                onToggleFavorite={() => toggleFavoriteForFood(food)}
                onEdit={() => openEdit(food)}
                onDelete={() => confirmDelete(food)}
                onOpenActionsMenu={() => setFoodForActions(food)}
              />
            ))
          ) : (
            <Text style={[styles.emptyMealText, { color: theme.text }]}>No foods logged yet.</Text>
          )}
          <TouchableOpacity
            style={[styles.addFoodBtn, { borderColor: theme.border }]}
            onPress={() => {
              setAddMealType(mealType);
              setShowAddModal(true);
            }}
          >
            <Ionicons name="add" size={18} color={SAGE} />
            <Text style={[styles.addFoodBtnText, { color: SAGE }]}> Add</Text>
          </TouchableOpacity>
        </View>
      ))}

      {foods.length > 0 && (
        <TouchableOpacity
          style={[styles.addFoodBtn, { marginTop: 8, borderColor: '#C0392B', alignSelf: 'flex-start' }]}
          onPress={deleteAllFoodsForDate}
        >
          <Ionicons name="trash-outline" size={18} color="#C0392B" />
          <Text style={[styles.addFoodBtnText, { color: '#C0392B' }]}> Delete all meals for this day</Text>
        </TouchableOpacity>
      )}

      <AddFoodModal
        visible={showAddModal}
        mealType={addMealType}
        selectedDate={selectedDate}
        replaceLoggedFoodId={replaceLoggedFoodId}
        onClose={() => {
          setShowAddModal(false);
          setReplaceLoggedFoodId(null);
        }}
        onFoodAdded={loadLoggedFoods}
      />
      <Modal
        visible={foodForActions != null}
        transparent
        animationType="fade"
        onRequestClose={closeFoodActionsModal}
      >
        <View style={styles.foodActionsModalOverlay}>
          <TouchableWithoutFeedback onPress={closeFoodActionsModal}>
            <View style={StyleSheet.absoluteFillObject} />
          </TouchableWithoutFeedback>
          <View style={[styles.foodActionsModalCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.foodActionsModalTitle, { color: theme.text }]} numberOfLines={2}>
              {foodForActions?.food_name}
            </Text>
            {!!foodForActions?.brand && (
              <Text style={[styles.foodActionsModalSubtitle, { color: theme.textSecondary ?? '#888' }]} numberOfLines={1}>
                {foodForActions.brand}
              </Text>
            )}
            <TouchableOpacity
              style={[styles.foodActionsModalRow, { borderColor: theme.border }]}
              onPress={runFoodActionEdit}
              activeOpacity={0.7}
            >
              <Ionicons name="create-outline" size={22} color={SAGE} style={styles.foodActionsModalIcon} />
              <Text style={[styles.foodActionsModalRowText, { color: theme.text }]}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.foodActionsModalRow, styles.foodActionsModalRowLast, { borderColor: theme.border }]}
              onPress={runFoodActionDelete}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={22} color="#C0392B" style={styles.foodActionsModalIcon} />
              <Text style={[styles.foodActionsModalRowText, { color: '#C0392B' }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={editModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeEditModal}
      >
        <View style={styles.editFoodModalRoot}>
          <TouchableWithoutFeedback onPress={closeEditModal}>
            <View style={styles.editFoodModalDim} />
          </TouchableWithoutFeedback>
          <KeyboardAvoidingView
            style={[
              styles.editFoodModalKav,
              {
                paddingTop: Math.max(insets.top, 12) + 8,
                paddingBottom: Math.max(insets.bottom, 12),
              },
            ]}
            behavior="padding"
            keyboardVerticalOffset={0}
          >
            <View
              style={[
                styles.modalBox,
                {
                  backgroundColor: theme.background,
                  maxHeight: windowHeight * 0.88,
                },
              ]}
            >
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
                contentContainerStyle={styles.editFoodModalScrollContent}
              >
                <Text style={[styles.modalTitle, { color: theme.text }]}>Edit food</Text>
                <TouchableOpacity
                  style={[styles.changeFoodBtn, { borderColor: SAGE }]}
                  onPress={openChangeFoodFromEdit}
                  activeOpacity={0.75}
                >
                  <Ionicons name="swap-horizontal-outline" size={18} color={SAGE} style={{ marginRight: 8 }} />
                  <Text style={[styles.changeFoodBtnText, { color: SAGE }]}>Change food</Text>
                </TouchableOpacity>
                <Text style={[styles.modalLabel, { color: theme.text }]}>Food name</Text>
                <TextInput style={[styles.modalInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]} value={editForm.food_name} onChangeText={(v) => setEditForm((f) => ({ ...f, food_name: v }))} placeholder="Name" placeholderTextColor="#888" />
                <Text style={[styles.modalLabel, { color: theme.text }]}>Brand</Text>
                <TextInput style={[styles.modalInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]} value={editForm.brand} onChangeText={(v) => setEditForm((f) => ({ ...f, brand: v }))} placeholder="Brand (optional)" placeholderTextColor="#888" />
                <Text style={[styles.modalLabel, { color: theme.text }]}>Quantity</Text>
                <TextInput style={[styles.modalInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]} value={editForm.quantity} onChangeText={updateEditQuantity} placeholder="1" keyboardType="decimal-pad" />
                <Text style={[styles.modalLabel, { color: theme.text }]}>Unit</Text>
                <TouchableOpacity
                  style={[styles.modalInput, styles.unitDropdownTrigger, { backgroundColor: theme.card, borderColor: theme.border }]}
                  onPress={() => setUnitDropdownOpen((o) => !o)}
                >
                  <Text style={{ color: theme.text, fontSize: 16 }}>{editForm.unit || 'serving'}</Text>
                  <Ionicons name={unitDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={theme.text} />
                </TouchableOpacity>
                {unitDropdownOpen && (
                  <View style={[styles.unitDropdownList, { backgroundColor: theme.card, borderColor: theme.border }]}>
                    <ScrollView style={styles.unitDropdownScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                      {UNIT_OPTIONS.map((u) => (
                        <TouchableOpacity
                          key={u}
                          style={[styles.unitDropdownOption, { backgroundColor: editForm.unit === u ? (theme.primary || SAGE) : 'transparent' }]}
                          onPress={() => updateEditUnit(u)}
                        >
                          <Text style={[styles.unitDropdownOptionText, { color: editForm.unit === u ? '#fff' : theme.text }]}>{u}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}
                <Text style={[styles.modalLabel, { color: theme.text }]}>Meal</Text>
                <View style={styles.mealTypeRow}>
                  {MEAL_ORDER.map((m) => (
                    <TouchableOpacity key={m} style={[styles.mealTypeChip, editForm.meal_type === m && styles.mealTypeChipActive, { borderColor: theme.border, backgroundColor: editForm.meal_type === m ? SAGE : theme.card }]} onPress={() => setEditForm((f) => ({ ...f, meal_type: m }))}>
                      <Text style={[styles.mealTypeChipText, { color: editForm.meal_type === m ? '#fff' : theme.text }]}>{m}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.macroInputRow}>
                  <View style={styles.macroCell}>
                    <Text style={[styles.macroCellLabel, { color: theme.text }]}>Calories</Text>
                    <TextInput style={[styles.macroInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]} value={editForm.calories} editable={false} />
                  </View>
                  <View style={styles.macroCell}>
                    <Text style={[styles.macroCellLabel, { color: theme.text }]}>Protein</Text>
                    <TextInput style={[styles.macroInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]} value={editForm.protein} editable={false} />
                  </View>
                  <View style={styles.macroCell}>
                    <Text style={[styles.macroCellLabel, { color: theme.text }]}>Carbs</Text>
                    <TextInput style={[styles.macroInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]} value={editForm.carbs} editable={false} />
                  </View>
                  <View style={styles.macroCell}>
                    <Text style={[styles.macroCellLabel, { color: theme.text }]}>Fat</Text>
                    <TextInput style={[styles.macroInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]} value={editForm.fat} editable={false} />
                  </View>
                </View>
                <View style={styles.modalActions}>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: theme.card }]} onPress={closeEditModal}>
                    <Text style={[styles.modalBtnText, { color: theme.text }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.modalBtn, { backgroundColor: SAGE }]} onPress={saveEdit}>
                    <Text style={styles.modalBtnText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </ScrollView>
  );
}

function FoodRow({
  food,
  theme,
  isFavorited,
  onToggleFavorite,
  onEdit,
  onDelete,
  onOpenActionsMenu,
}: {
  food: LoggedFood;
  theme: any;
  isFavorited: boolean;
  onToggleFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenActionsMenu: () => void;
}) {
  let swipeRef: Swipeable | null = null;
  const renderLeftActions = () => (
    <RectButton style={styles.editBtn} onPress={() => { swipeRef?.close(); onEdit(); }}>
      <Text style={styles.swipeBtnText}>Edit</Text>
    </RectButton>
  );
  const renderRightActions = () => (
    <RectButton style={styles.deleteBtn} onPress={() => { swipeRef?.close(); onDelete(); }}>
      <Text style={styles.swipeBtnText}>Delete</Text>
    </RectButton>
  );
  return (
    <Swipeable
      ref={(r) => { swipeRef = r; }}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      friction={2}
    >
      <View style={[styles.foodRow, styles.foodRowWithHeart, { backgroundColor: theme.background, borderColor: theme.border }]}>
        <Pressable
          style={({ pressed }) => [styles.foodRowContent, pressed && { opacity: 0.85 }]}
          onLongPress={onOpenActionsMenu}
          delayLongPress={400}
        >
          <Text style={[styles.foodRowName, { color: theme.text }]} numberOfLines={1}>{food.food_name}{food.brand ? ` · ${food.brand}` : ''}</Text>
          <Text style={[styles.foodRowPortion, { color: theme.textSecondary ?? '#888' }]} numberOfLines={2}>
            {formatFoodPortionListLine(food)}
          </Text>
          <Text style={[styles.foodRowMacros, { color: theme.text }]}>{Math.round(food.calories)} cal · {Math.round(food.protein)}P / {Math.round(food.carbs)}C / {Math.round(food.fat)}F</Text>
        </Pressable>
        <TouchableOpacity style={styles.heartBtn} onPress={onToggleFavorite} hitSlop={8}>
          <Ionicons name={isFavorited ? 'heart' : 'heart-outline'} size={22} color={isFavorited ? SAGE : (theme.textSecondary || '#999')} />
        </TouchableOpacity>
      </View>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingTop: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { marginBottom: 8 },
  dateNavRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dateNavArrow: { padding: 8 },
  dateNavArrowDisabled: { opacity: 0.3 },
  dateNavLabel: { fontSize: 18, fontWeight: '700' },
  planSubtitle: { fontSize: 14, color: SAGE, marginBottom: 8 },
  macroCard: { padding: 16, borderRadius: 12, borderWidth: 1, marginBottom: 16 },
  macroTitle: { fontSize: 16, fontWeight: '600', marginBottom: 10 },
  macroRow: { flexDirection: 'row', justifyContent: 'space-around' },
  macroItem: { alignItems: 'center' },
  macroValue: { fontSize: 20, fontWeight: '700' },
  macroLabel: { fontSize: 12, marginTop: 2 },
  foodsCard: { padding: 16, borderRadius: 12, borderWidth: 1 },
  emptyText: { fontSize: 14, opacity: 0.8 },
  mealSection: { padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 14 },
  mealSectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  mealTotalsLine: {
    fontSize: 13,
    fontFamily: 'Jost_400Regular',
    marginBottom: 10,
  },
  emptyMealText: { fontSize: 14, opacity: 0.8, marginBottom: 10 },
  addFoodBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  addFoodBtnText: { fontSize: 14, fontWeight: '600' },
  foodRow: { paddingVertical: 12, paddingHorizontal: 12, borderBottomWidth: 1, marginBottom: 0 },
  foodRowWithHeart: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  foodRowContent: { flex: 1, minWidth: 0 },
  heartBtn: { padding: 4 },
  foodRowName: { fontSize: 15 },
  foodRowPortion: { fontSize: 12, marginTop: 2 },
  foodRowMacros: { fontSize: 12, opacity: 0.8, marginTop: 2 },
  editBtn: { backgroundColor: '#E67E22', justifyContent: 'center', alignItems: 'center', width: 72 },
  deleteBtn: { backgroundColor: '#C0392B', justifyContent: 'center', alignItems: 'center', width: 72 },
  swipeBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  foodActionsModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  foodActionsModalCard: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    maxWidth: 400,
    width: '100%',
    alignSelf: 'center',
  },
  foodActionsModalTitle: { fontSize: 17, fontWeight: '700', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  foodActionsModalSubtitle: { fontSize: 14, paddingHorizontal: 16, paddingBottom: 8 },
  foodActionsModalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderTopWidth: 1,
  },
  foodActionsModalRowLast: { marginBottom: 4 },
  foodActionsModalIcon: { marginRight: 12 },
  foodActionsModalRowText: { fontSize: 16, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalBackdropTap: { flex: 1 },
  editFoodModalRoot: {
    flex: 1,
  },
  editFoodModalDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  editFoodModalKav: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingHorizontal: 16,
  },
  editFoodModalScrollContent: {
    flexGrow: 1,
    paddingBottom: 8,
  },
  modalBox: {
    borderRadius: 20,
    padding: 20,
    paddingBottom: 20,
    width: '100%',
    alignSelf: 'center',
  },
  modalTitle: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  changeFoodBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 14,
  },
  changeFoodBtnText: { fontSize: 15, fontWeight: '600' },
  modalLabel: { fontSize: 14, fontWeight: '600', marginBottom: 6, marginTop: 10 },
  modalInput: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 },
  unitDropdownTrigger: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  unitDropdownList: { borderWidth: 1, borderRadius: 10, marginTop: 4, maxHeight: 240, overflow: 'hidden' },
  unitDropdownScroll: { maxHeight: 240 },
  unitDropdownOption: { paddingVertical: 10, paddingHorizontal: 12 },
  unitDropdownOptionText: { fontSize: 16 },
  mealTypeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  mealTypeChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  mealTypeChipActive: {},
  mealTypeChipText: { fontSize: 14 },
  macroInputRow: { flexDirection: 'row', gap: 8 },
  macroCell: { flex: 1 },
  macroCellLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  macroInput: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 16 },
  modalActions: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end', marginTop: 24 },
  modalBtn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10 },
  modalBtnText: { color: '#fff', fontWeight: '600' },
});
