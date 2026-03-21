import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  TextInput,
  ScrollView,
  Share,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import { useTranslation } from 'react-i18next';
import { useRoute, useFocusEffect } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle } from 'react-native-svg';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import NutritionToday from './NutritionToday';
import MealPlanList from './MealPlanList';
import { initMealPlansDb } from '../utils/initMealPlansDb';

type MacroTotals = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type MealPlanRow = {
  meal_plan_id: number;
  plan_name: string;
  calories_target: number | null;
  protein_target: number | null;
  carbs_target: number | null;
  fat_target: number | null;
  created_date?: string | null;
  prep_guide?: string | null;
  grocery_list?: string | null;
};

type GroceryItem = {
  id: string;
  text: string;
  category: 'Produce' | 'Meat & Fish' | 'Dairy' | 'Pantry' | 'Other';
  checked: boolean;
};

type FavoriteFood = {
  favorite_id: number;
  food_name: string;
  brand: string | null;
  serving_size: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

type LoggedFoodEntry = {
  logged_food_id: number;
  log_id: number;
  food_name: string;
  brand: string | null;
  meal_type: string;
  serving_size: string | null;
  quantity: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

const buildFavoriteSignature = (
  name: string,
  brand: string | null,
  servingSize: string | null,
): string =>
  `${(name || '').trim().toLowerCase()}|${(brand || '')
    .trim()
    .toLowerCase()}|${(servingSize || '').trim().toLowerCase()}`;

const MEAL_TYPES: Array<{ key: string; label: string }> = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'snack', label: 'Snack' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
];

const SAGE_GREEN = '#7C9A7E';
function formatYmdDate(d: Date): string {
  return d.toISOString().split('T')[0];
}
function addDaysIso(iso: string, delta: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return formatYmdDate(d);
}
/** Monday of the week containing iso (week starts Monday). */
function getMonday(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + mondayOffset);
  return formatYmdDate(d);
}
function formatSelectedDateLong(iso: string): string {
  const d = iso.split('T')[0];
  if (!d) return iso;
  const [y, m, day] = d.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(day));
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
/** Week range for display, e.g. "Mar 10-16" or "Mar 31 - Apr 6". */
function formatWeekRange(weekStartIso: string): string {
  const start = new Date(weekStartIso + 'T12:00:00');
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const monthStart = start.toLocaleDateString('en-US', { month: 'short' });
  if (sameMonth) return `${monthStart} ${start.getDate()}-${end.getDate()}`;
  return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
const DAY_ABBREV = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Nutrition() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const db = useSQLiteContext();
  const { t } = useTranslation();
  const route = useRoute();

  const [activeTab, setActiveTab] = useState<'today' | 'plans'>('today');
  const routeParams = (route.params || {}) as { activeTab?: 'today' | 'plans'; reload?: number };
  useEffect(() => {
    if (routeParams.activeTab === 'today') {
      setActiveTab('today');
    } else if (routeParams.activeTab === 'plans') {
      setActiveTab('plans');
    }
  }, [routeParams.activeTab]);

  /** Bumps when this screen gains focus so NutritionToday reloads plan/day mapping (e.g. after editing schedule). Does not change tab — use route `activeTab` (e.g. after Set as Active → plans). */
  const [nutritionTodayReloadTick, setNutritionTodayReloadTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setNutritionTodayReloadTick((n) => n + 1);
    }, []),
  );

  const [selectedDate, setSelectedDate] = useState<Date>(new Date());

  const todayDate = new Date();
  const isToday = selectedDate.toDateString() === todayDate.toDateString();
  const formattedSelectedDate = isToday
    ? 'This Week'
    : selectedDate.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
  const goPrevDay = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() - 1);
    setSelectedDate(d);
  };
  const goNextDay = () => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + 1);
    setSelectedDate(d);
  };
  const selectedIso = formatYmdDate(selectedDate);
  const todayIso = formatYmdDate(new Date());
  const weekStart = getMonday(selectedIso);
  const weekDays = [0, 1, 2, 3, 4, 5, 6].map((i) => addDaysIso(weekStart, i));
  const goPrevWeek = () => {
    const monday = new Date(weekStart + 'T12:00:00');
    monday.setDate(monday.getDate() - 7);
    setSelectedDate(monday);
  };
  const goNextWeek = () => {
    const nextMonday = new Date(weekStart + 'T12:00:00');
    nextMonday.setDate(nextMonday.getDate() + 7);
    const today = new Date();
    if (activeTab === 'today' && nextMonday > today) return;
    setSelectedDate(nextMonday);
  };

  const [addFoodVisible, setAddFoodVisible] = useState(false);
  const [addFoodMealType, setAddFoodMealType] = useState<string>('breakfast');
  const [searchQuery, setSearchQuery] = useState('');
  const [mealPlans, setMealPlans] = useState<MealPlanRow[]>([]);
  const [groceryItems, setGroceryItems] = useState<GroceryItem[]>([]);
  const [groceryPlanId, setGroceryPlanId] = useState<number | null>(null);
  const [loadingGrocery, setLoadingGrocery] = useState(false);

  const [foodTab, setFoodTab] = useState<'search' | 'favorites'>('search');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [scannerVisible, setScannerVisible] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const [weeklyGrocery, setWeeklyGrocery] = useState<GroceryItem[]>([]);
  const [weeklyPrep, setWeeklyPrep] = useState<{ plan_name: string; text: string }[]>([]);

  const loadWeeklyAggregates = useCallback(async () => {
    try {
      await initMealPlansDb(db);
      // Determine all active plans for this week from DayActivePlan
      const weekDates = [0, 1, 2, 3, 4, 5, 6].map((i) =>
        addDaysIso(weekStart, i),
      );
      const activeRows = await db.getAllAsync<{ meal_plan_id: number }>(
        `SELECT DISTINCT meal_plan_id FROM DayActivePlan WHERE date IN (?, ?, ?, ?, ?, ?, ?)`,
        weekDates,
      );
      const activeIds = new Set(activeRows.map((r) => r.meal_plan_id));
      const activePlans = mealPlans.filter((p) =>
        activeIds.has(p.meal_plan_id),
      );

      // Aggregate grocery items across active plans
      const items: GroceryItem[] = [];
      activePlans.forEach((p) => {
        if (!p.grocery_list) return;
        try {
          const parsed = JSON.parse(p.grocery_list);
          if (Array.isArray(parsed)) {
            parsed.forEach((entry: any, index: number) => {
              const text = (entry.item ?? entry.text ?? '').trim();
              if (!text) return;
              let category = String(entry.category || 'Other').trim();
              if (category === 'Protein') category = 'Meat & Fish';
              const cat = category as GroceryItem['category'];
              items.push({
                id: `${p.meal_plan_id}_${index}_${text}`,
                text,
                category:
                  cat === 'Produce' ||
                  cat === 'Meat & Fish' ||
                  cat === 'Dairy' ||
                  cat === 'Pantry' ||
                  cat === 'Other'
                    ? cat
                    : 'Other',
                checked: false,
              });
            });
          }
        } catch {
          // ignore malformed JSON for now
        }
      });

      // De-duplicate by category+text
      const seen = new Set<string>();
      const unique = items.filter((it) => {
        const key = `${it.category}|${it.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setWeeklyGrocery(unique);

      // Aggregate prep guides
      const prepBlocks: { plan_name: string; text: string }[] = [];
      activePlans.forEach((p) => {
        if (p.prep_guide && p.prep_guide.trim()) {
          prepBlocks.push({ plan_name: p.plan_name, text: p.prep_guide.trim() });
        }
      });
      setWeeklyPrep(prepBlocks);
    } catch (e) {
      console.error('Error loading weekly grocery/prep aggregates:', e);
      setWeeklyGrocery([]);
      setWeeklyPrep([]);
    }
  }, [db, mealPlans, weekStart]);

  const [quantityModalVisible, setQuantityModalVisible] = useState(false);
  const [selectedFood, setSelectedFood] = useState<{
    name: string;
    brand: string | null;
    servingSize: string | null;
    nutriments: any;
  } | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [quantityUnit, setQuantityUnit] = useState<
    'g' | 'oz' | 'serving' | 'cup' | 'tbsp' | 'tsp' | 'ml' | 'lb'
  >('serving');
  const [quantityMealType, setQuantityMealType] =
    useState<string>('breakfast');

  const [favorites, setFavorites] = useState<FavoriteFood[]>([]);
  const [favoriteSignatures, setFavoriteSignatures] = useState<Set<string>>(
    new Set(),
  );

  const [selectedPlan, setSelectedPlan] = useState<MealPlanRow | null>(null);
  const [selectedPlanMeals, setSelectedPlanMeals] = useState<
    {
      meal_id: number;
      meal_name: string;
      meal_type: string;
      foods: {
        food_name: string;
        brand: string | null;
        serving_size: string | null;
        calories: number;
        protein: number;
        carbs: number;
        fat: number;
      }[];
    }[]
  >([]);
  const [prepChecklistChecked, setPrepChecklistChecked] = useState<
    Set<number>
  >(new Set());

  const [loggedFoodsForDate, setLoggedFoodsForDate] = useState<
    LoggedFoodEntry[]
  >([]);
  const [targetMacrosFromPlan, setTargetMacrosFromPlan] =
    useState<MacroTotals>({
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
    });

  const loadLoggedFoodsForDate = async (date: Date) => {
    const dateStr = date.toISOString().slice(0, 10);
    try {
      const logRow = await db.getAllAsync<{ log_id: number }>(
        'SELECT log_id FROM DailyLog WHERE log_date = ?;',
        [dateStr],
      );
      if (logRow.length === 0) {
        setLoggedFoodsForDate([]);
        setTargetMacrosFromPlan({ calories: 0, protein: 0, carbs: 0, fat: 0 });
        return;
      }
      const logId = logRow[0].log_id;
      const foods = await db.getAllAsync<LoggedFoodEntry>(
        'SELECT logged_food_id, log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat FROM LoggedFoods WHERE log_id = ? ORDER BY meal_type, logged_food_id;',
        [logId],
      );
      setLoggedFoodsForDate(foods);

      const dl = await db.getFirstAsync<{ meal_plan_id: number | null }>(
        'SELECT meal_plan_id FROM DailyLog WHERE log_date = ?;',
        [dateStr],
      );
      if (dl?.meal_plan_id) {
        const plan = await db.getFirstAsync<{
          calories_target: number | null;
          protein_target: number | null;
          carbs_target: number | null;
          fat_target: number | null;
        }>(
          'SELECT calories_target, protein_target, carbs_target, fat_target FROM MealPlans WHERE meal_plan_id = ?;',
          [dl.meal_plan_id],
        );
        if (plan) {
          setTargetMacrosFromPlan({
            calories: plan.calories_target ?? 0,
            protein: plan.protein_target ?? 0,
            carbs: plan.carbs_target ?? 0,
            fat: plan.fat_target ?? 0,
          });
        } else {
          setTargetMacrosFromPlan({ calories: 0, protein: 0, carbs: 0, fat: 0 });
        }
      } else {
        setTargetMacrosFromPlan({ calories: 0, protein: 0, carbs: 0, fat: 0 });
      }
    } catch (e) {
      console.error('Error loading logged foods for date:', e);
      setLoggedFoodsForDate([]);
      setTargetMacrosFromPlan({ calories: 0, protein: 0, carbs: 0, fat: 0 });
    }
  };

  const macros: MacroTotals = loggedFoodsForDate.reduce(
    (acc, f) => ({
      calories: acc.calories + (f.calories ?? 0),
      protein: acc.protein + (f.protein ?? 0),
      carbs: acc.carbs + (f.carbs ?? 0),
      fat: acc.fat + (f.fat ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  const targetMacros: MacroTotals = targetMacrosFromPlan;

  const loadFavorites = async () => {
    try {
      const favs = await db.getAllAsync<FavoriteFood>(
        'SELECT * FROM FavoriteFoods ORDER BY favorite_id DESC;',
      );
      setFavorites(favs);
      const sigs = new Set<string>();
      favs.forEach((f) => {
        sigs.add(buildFavoriteSignature(f.food_name, f.brand, f.serving_size));
      });
      setFavoriteSignatures(sigs);
    } catch (e) {
      console.error('Error loading favorite foods:', e);
    }
  };

  useEffect(() => {
    const loadPlans = async () => {
      try {
        const rows = await db.getAllAsync<MealPlanRow>(
          'SELECT meal_plan_id, plan_name, calories_target, protein_target, carbs_target, fat_target, created_date, prep_guide, grocery_list FROM MealPlans ORDER BY created_date DESC;',
        );
        setMealPlans(rows);
      } catch (e) {
        console.error('Error loading meal plans:', e);
      }
    };
    loadPlans();
  }, [db]);

  useEffect(() => {
    if (addFoodVisible) {
      loadFavorites();
    }
  }, [addFoodVisible]);

  useEffect(() => {
    if (activeTab === 'today') {
      loadLoggedFoodsForDate(selectedDate);
    }
  }, [activeTab, selectedDate]);

  useEffect(() => {
    if (activeTab === 'plans') {
      loadWeeklyAggregates();
    }
  }, [activeTab, loadWeeklyAggregates]);

  const categorizeFood = (name: string): GroceryItem['category'] => {
    const n = name.toLowerCase();
    if (
      /apple|banana|spinach|lettuce|broccoli|carrot|berry|tomato|onion|pepper/.test(
        n,
      )
    ) {
      return 'Produce';
    }
    if (/chicken|beef|turkey|salmon|tuna|pork|egg|tofu|beans/.test(n)) {
      return 'Meat & Fish';
    }
    if (/milk|yogurt|cheese|butter|cream|cottage/.test(n)) {
      return 'Dairy';
    }
    if (/rice|pasta|oats|flour|oil|nuts|seeds|bread|tortilla/.test(n)) {
      return 'Pantry';
    }
    return 'Other';
  };

  const loadGroceryState = async (
    planId: number,
    items: GroceryItem[],
  ): Promise<GroceryItem[]> => {
    try {
      const raw = await AsyncStorage.getItem(`@grocery_list_${planId}`);
      if (!raw) return items;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return items;
      const checkedIds = new Set<string>(parsed);
      return items.map((it) => ({
        ...it,
        checked: checkedIds.has(it.id),
      }));
    } catch (e) {
      console.error('Error loading grocery list state:', e);
      return items;
    }
  };

  const saveGroceryState = async (planId: number, items: GroceryItem[]) => {
    try {
      const checkedIds = items.filter((i) => i.checked).map((i) => i.id);
      await AsyncStorage.setItem(
        `@grocery_list_${planId}`,
        JSON.stringify(checkedIds),
      );
    } catch (e) {
      console.error('Error saving grocery list state:', e);
    }
  };

  const handleGenerateGroceryList = async (planId: number) => {
    setLoadingGrocery(true);
    try {
      const rows = await db.getAllAsync<{
        food_name: string;
        brand: string | null;
        serving_size: string | null;
      }>(
        `SELECT fi.food_name, fi.brand, fi.serving_size
         FROM FoodItems fi
         JOIN PlannedMeals pm ON pm.meal_id = fi.meal_id
         WHERE pm.meal_plan_id = ?;`,
        [planId],
      );

      const baseItems: GroceryItem[] = rows.map((row, index) => {
        const parts: string[] = [];
        if (row.brand && row.brand.trim()) {
          parts.push(row.brand.trim());
        }
        parts.push(row.food_name.trim());
        if (row.serving_size && row.serving_size.trim()) {
          parts.push(`— ${row.serving_size.trim()}`);
        }
        const text = parts.join(' ');
        return {
          id: `${planId}_${index}_${row.food_name}`,
          text,
          category: categorizeFood(row.food_name),
          checked: false,
        };
      });

      const jsonList = baseItems.map((it) => ({
        category: it.category,
        item: it.text,
        checked: false,
      }));

      await db.runAsync(
        'UPDATE MealPlans SET grocery_list = ? WHERE meal_plan_id = ?;',
        [JSON.stringify(jsonList), planId],
      );

      const withState = await loadGroceryState(planId, baseItems);
      setGroceryPlanId(planId);
      setGroceryItems(withState);
    } catch (e) {
      console.error('Error generating grocery list:', e);
    } finally {
      setLoadingGrocery(false);
    }
  };

  const toggleGroceryItem = async (id: string) => {
    if (groceryPlanId == null) return;
    const updated = groceryItems.map((it) =>
      it.id === id ? { ...it, checked: !it.checked } : it,
    );
    setGroceryItems(updated);
    await saveGroceryState(groceryPlanId, updated);
  };

  const handleShareGroceryList = async () => {
    const byCat: Record<string, GroceryItem[]> = {};
    groceryItems.forEach((it) => {
      if (!byCat[it.category]) byCat[it.category] = [];
      byCat[it.category].push(it);
    });

    const categories: GroceryItem['category'][] = [
      'Produce',
      'Meat & Fish',
      'Dairy',
      'Pantry',
      'Other',
    ];

    const lines: string[] = [];
    categories.forEach((c) => {
      const items = byCat[c];
      if (!items || !items.length) return;
      lines.push(c + ':');
      items.forEach((it) => {
        const box = it.checked ? '[x]' : '[ ]';
        lines.push(`${box} ${it.text}`);
      });
      lines.push('');
    });

    const text = lines.join('\n').trim();
    if (!text) return;

    try {
      await Share.share({ message: text });
    } catch (e) {
      console.error('Error sharing grocery list:', e);
    }
  };

  const loadMealPlanDetails = async (plan: MealPlanRow) => {
    setSelectedPlan(plan);
    setPrepChecklistChecked(new Set());
    try {
      const freshPlan = await db.getFirstAsync<MealPlanRow>(
        'SELECT meal_plan_id, plan_name, calories_target, protein_target, carbs_target, fat_target, created_date, prep_guide, grocery_list FROM MealPlans WHERE meal_plan_id = ?;',
        [plan.meal_plan_id],
      );
      const planToUse = freshPlan ?? plan;
      if (freshPlan) {
        setSelectedPlan(freshPlan);
      }

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
         ORDER BY pm.meal_type, pm.meal_order, pm.meal_id, fi.food_id;`,
        [planToUse.meal_plan_id],
      );

      const mealMap = new Map<number, (typeof selectedPlanMeals)[number]>();
      mealRows.forEach((row) => {
        if (!mealMap.has(row.meal_id)) {
          mealMap.set(row.meal_id, {
            meal_id: row.meal_id,
            meal_name: row.meal_name,
            meal_type: row.meal_type,
            foods: [],
          });
        }
        if (row.food_name) {
          const meal = mealMap.get(row.meal_id)!;
          meal.foods.push({
            food_name: row.food_name,
            brand: row.brand,
            serving_size: row.serving_size,
            calories: row.calories ?? 0,
            protein: row.protein ?? 0,
            carbs: row.carbs ?? 0,
            fat: row.fat ?? 0,
          });
        }
      });

      setSelectedPlanMeals(Array.from(mealMap.values()));

      const groceryListRaw = planToUse.grocery_list;
      if (groceryListRaw) {
        try {
          const parsed = JSON.parse(groceryListRaw);
          if (Array.isArray(parsed)) {
            const baseItems: GroceryItem[] = parsed.map(
              (entry: any, index: number) => ({
                id: `${planToUse.meal_plan_id}_${index}_${
                  entry.item ?? entry.text ?? ''
                }`,
                text: entry.item ?? entry.text ?? '',
                category: (entry.category ||
                  'Other') as GroceryItem['category'],
                checked: false,
              }),
            );
            const withState = await loadGroceryState(
              planToUse.meal_plan_id,
              baseItems,
            );
            setGroceryPlanId(planToUse.meal_plan_id);
            setGroceryItems(withState);
          } else {
            setGroceryPlanId(planToUse.meal_plan_id);
            setGroceryItems([]);
          }
        } catch (e) {
          console.error('Error parsing stored grocery_list JSON:', e);
          setGroceryPlanId(planToUse.meal_plan_id);
          setGroceryItems([]);
        }
      } else {
        setGroceryPlanId(planToUse.meal_plan_id);
        setGroceryItems([]);
      }
    } catch (e) {
      console.error('Error loading meal plan details:', e);
    }
  };

  const handleSetPlanActive = () => {
    if (!selectedPlan) return;
    Alert.alert(
      'Set as Active',
      "This will replace today's logged foods. Continue?",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: async () => {
            try {
              const dateStr = new Date().toISOString().slice(0, 10);
              const logId = await ensureLogIdForDate(dateStr);

              await db.runAsync(
                'DELETE FROM LoggedFoods WHERE log_id = ?;',
                [logId],
              );
              await db.runAsync(
                'UPDATE DailyLog SET meal_plan_id = ? WHERE log_date = ?;',
                [selectedPlan.meal_plan_id, dateStr],
              );

              for (const meal of selectedPlanMeals) {
                const mealType = meal.meal_type || 'breakfast';
                for (const food of meal.foods) {
                  await db.runAsync(
                    `INSERT INTO LoggedFoods
                    (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
                    [
                      logId,
                      food.food_name,
                      food.brand ?? null,
                      mealType,
                      food.serving_size ?? null,
                      1,
                      food.calories ?? 0,
                      food.protein ?? 0,
                      food.carbs ?? 0,
                      food.fat ?? 0,
                    ],
                  );
                }
              }

              await initMealPlansDb(db);
              await db.runAsync(
                'INSERT OR IGNORE INTO DayActivePlan (date, meal_plan_id) VALUES (?, ?)',
                [dateStr, selectedPlan.meal_plan_id],
              );

              await loadLoggedFoodsForDate(new Date());
              setActiveTab('today');
              setSelectedDate(new Date());
              Alert.alert('', 'Meal plan loaded for today');
            } catch (e) {
              console.error('Error setting plan active:', e);
              Alert.alert('Error', 'Failed to load meal plan for today.');
            }
          },
        },
      ],
    );
  };

  const performSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(
        query,
      )}&json=1&page_size=20&fields=product_name,brands,nutriments,serving_size,code`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Search error ${res.status}`);
      }
      const json = await res.json();
      const products = Array.isArray(json.products) ? json.products : [];
      setSearchResults(products);
    } catch (e) {
      console.error('Open Food Facts search error:', e);
      setSearchError(
        e instanceof Error ? e.message : 'Error searching Open Food Facts.',
      );
    } finally {
      setSearchLoading(false);
    }
  };

  const extractNutrients = (nutriments: any) => {
    if (!nutriments) {
      return { calories: 0, protein: 0, carbs: 0, fat: 0 };
    }
    const get = (keys: string[]): number => {
      for (const key of keys) {
        if (typeof nutriments[key] === 'number') return nutriments[key];
        const val = nutriments[key];
        if (val != null && !Number.isNaN(Number(val))) {
          return Number(val);
        }
      }
      return 0;
    };
    const caloriesPerServing = get(['energy-kcal_serving']);
    const caloriesPer100g = get(['energy-kcal_100g']);
    const proteinPerServing = get(['proteins_serving']);
    const proteinPer100g = get(['proteins_100g']);
    const carbsPerServing = get(['carbohydrates_serving']);
    const carbsPer100g = get(['carbohydrates_100g']);
    const fatPerServing = get(['fat_serving']);
    const fatPer100g = get(['fat_100g']);
    return {
      calories: caloriesPerServing || caloriesPer100g,
      protein: proteinPerServing || proteinPer100g,
      carbs: carbsPerServing || carbsPer100g,
      fat: fatPerServing || fatPer100g,
      caloriesPerServing,
      caloriesPer100g,
      proteinPerServing,
      proteinPer100g,
      carbsPerServing,
      carbsPer100g,
      fatPerServing,
      fatPer100g,
    };
  };

  const ensureLogIdForDate = async (dateStr: string): Promise<number> => {
    await db.runAsync(
      'INSERT OR IGNORE INTO DailyLog (log_date) VALUES (?);',
      [dateStr],
    );
    const row = await db.getAllAsync<{ log_id: number }>(
      'SELECT log_id FROM DailyLog WHERE log_date = ?;',
      [dateStr],
    );
    return row[0].log_id;
  };

  const logFoodToToday = async (
    name: string,
    brand: string | null,
    servingSize: string | null,
    nutriments: {
      caloriesPerServing?: number;
      caloriesPer100g?: number;
      proteinPerServing?: number;
      proteinPer100g?: number;
      carbsPerServing?: number;
      carbsPer100g?: number;
      fatPerServing?: number;
      fatPer100g?: number;
    },
    mealType: string,
    qty: number,
    unit: string,
  ) => {
    const dateStr = selectedDate.toISOString().slice(0, 10);
    const logId = await ensureLogIdForDate(dateStr);
    const quantity = qty > 0 ? qty : 1;

    const caloriesPerServing = nutriments.caloriesPerServing ?? 0;
    const caloriesPer100g = nutriments.caloriesPer100g ?? 0;
    const proteinPerServing = nutriments.proteinPerServing ?? 0;
    const proteinPer100g = nutriments.proteinPer100g ?? 0;
    const carbsPerServing = nutriments.carbsPerServing ?? 0;
    const carbsPer100g = nutriments.carbsPer100g ?? 0;
    const fatPerServing = nutriments.fatPerServing ?? 0;
    const fatPer100g = nutriments.fatPer100g ?? 0;

    const perServingOr100g = (perServing: number, per100g: number) => {
      if (unit === 'serving') {
        return (perServing || per100g) * quantity;
      }
      const perGram = per100g / 100;
      if (!perGram) return 0;
      if (unit === 'g' || unit === 'ml') {
        return perGram * quantity;
      }
      if (unit === 'oz') {
        return perGram * quantity * 28.35;
      }
      if (unit === 'lb') {
        return perGram * quantity * 453.592;
      }
      if (unit === 'cup') {
        return perGram * quantity * 240;
      }
      if (unit === 'tbsp') {
        return perGram * quantity * 15;
      }
      if (unit === 'tsp') {
        return perGram * quantity * 5;
      }
      return (perServing || per100g) * quantity;
    };

    const calories =
      caloriesPerServing || caloriesPer100g
        ? perServingOr100g(caloriesPerServing, caloriesPer100g)
        : 0;
    const protein =
      proteinPerServing || proteinPer100g
        ? perServingOr100g(proteinPerServing, proteinPer100g)
        : 0;
    const carbs =
      carbsPerServing || carbsPer100g
        ? perServingOr100g(carbsPerServing, carbsPer100g)
        : 0;
    const fat =
      fatPerServing || fatPer100g
        ? perServingOr100g(fatPerServing, fatPer100g)
        : 0;

    await db.runAsync(
      `INSERT INTO LoggedFoods
      (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        logId,
        name,
        brand,
        mealType,
        servingSize ? `${quantity} ${unit} (${servingSize})` : `${quantity} ${unit}`,
        quantity,
        calories,
        protein,
        carbs,
        fat,
      ],
    );
    await loadLoggedFoodsForDate(selectedDate);
  };

  const handleSearchResultPress = (prod: any) => {
    const name = prod.product_name || 'Food item';
    const brand = prod.brands || null;
    const servingSize = prod.serving_size || null;
    const nutriments = extractNutrients(prod.nutriments || {});
    setSelectedFood({ name, brand, servingSize, nutriments });
    setQuantity(1);
    if (servingSize && /g\b/i.test(servingSize)) {
      setQuantityUnit('g');
    } else if (servingSize && /oz\b/i.test(servingSize)) {
      setQuantityUnit('oz');
    } else {
      setQuantityUnit('serving');
    }
    setQuantityMealType(addFoodMealType);
    setQuantityModalVisible(true);
  };

  const handleAddFavoriteFromSearch = async (prod: any) => {
    const name = prod.product_name || 'Food item';
    const brand = prod.brands || null;
    const servingSize = prod.serving_size || null;
    const nutriments = extractNutrients(prod.nutriments || {});
    try {
      await db.runAsync(
        `INSERT INTO FavoriteFoods
        (food_name, brand, serving_size, calories, protein, carbs, fat)
        VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [
          name,
          brand,
          servingSize,
          nutriments.calories,
          nutriments.protein,
          nutriments.carbs,
          nutriments.fat,
        ],
      );
      await loadFavorites();
    } catch (e) {
      console.error('Error saving favorite food:', e);
    }
  };

  const requestScannerPermissionAndOpen = async () => {
    if (cameraPermission && !cameraPermission.granted) {
      const { granted } = await requestCameraPermission();
      if (!granted) return;
    }
    setScannerVisible(true);
  };

  const handleBarcodeScanned = async ({ data }: { data: string }) => {
    setScannerVisible(false);
    try {
      const url = `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(
        data,
      )}.json`;
      const res = await fetch(url);
      const json = await res.json();
      if (!json || json.status !== 1 || !json.product) {
        console.warn('Product not found for barcode:', data);
        return;
      }
      const prod = json.product;
      const name = prod.product_name || 'Food item';
      const brand = prod.brands || null;
      const servingSize = prod.serving_size || null;
      const nutriments = extractNutrients(prod.nutriments || {});
      await logFoodToToday(
        name,
        brand,
        servingSize,
        {
          caloriesPerServing: nutriments.caloriesPerServing,
          caloriesPer100g: nutriments.caloriesPer100g,
          proteinPerServing: nutriments.proteinPerServing,
          proteinPer100g: nutriments.proteinPer100g,
          carbsPerServing: nutriments.carbsPerServing,
          carbsPer100g: nutriments.carbsPer100g,
          fatPerServing: nutriments.fatPerServing,
          fatPer100g: nutriments.fatPer100g,
        },
        'snack',
        1,
        'serving',
      );
    } catch (e) {
      console.error('Barcode lookup error:', e);
    }
  };

  const renderTabHeader = () => (
    <View style={styles.tabHeaderRow}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
        <TouchableOpacity
          onPress={goPrevWeek}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-back" size={20} color="#7C9A7E" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setActiveTab('today')} style={{ marginHorizontal: 12 }}>
          <Text
            style={[
              styles.tabButtonText,
              {
                color:
                  activeTab === 'today' ? theme.primary : theme.textSecondary,
              },
            ]}
          >
            {formatWeekRange(weekStart)}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={goNextWeek}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="chevron-forward" size={20} color="#7C9A7E" />
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={[styles.tabButton, activeTab === 'plans' && styles.tabButtonActive]}
        onPress={() => setActiveTab('plans')}
      >
        <Text
          style={[
            styles.tabButtonText,
            {
              color:
                activeTab === 'plans' ? theme.primary : theme.textSecondary,
            },
          ]}
        >
          Meal Plans
        </Text>
        {activeTab === 'plans' && (
          <View
            style={[styles.tabUnderline, { backgroundColor: theme.primary }]}
          />
        )}
      </TouchableOpacity>
    </View>
  );

  const renderTodayTab = () => {
    const todayDate = new Date();
    const isToday =
      selectedDate.toDateString() === todayDate.toDateString();
    const displayLabel = isToday
      ? 'This Week'
      : selectedDate.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });

    return (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.todayContent}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 8,
          }}
        >
          <TouchableOpacity
            onPress={() => {
              const d = new Date(selectedDate);
              d.setDate(d.getDate() - 1);
              setSelectedDate(d);
            }}
            style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-back" size={24} color={theme.primary} />
          </TouchableOpacity>
          <Text
            style={[
              styles.dateText,
              { color: theme.text, marginHorizontal: 16 },
            ]}
          >
            {displayLabel}
          </Text>
          <TouchableOpacity
            onPress={() => {
              const d = new Date(selectedDate);
              const todayOnly = new Date();
              d.setDate(d.getDate() + 1);
              if (d > todayOnly) return;
              setSelectedDate(d);
            }}
            style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-forward" size={24} color={theme.primary} />
          </TouchableOpacity>
        </View>

        <View style={styles.caloriesInlineRow}>
          <Text
            style={[
              styles.caloriesInlineLabel,
              { color: theme.textSecondary },
            ]}
          >
            CALORIES
          </Text>
          <Text
            style={[styles.caloriesInlineValue, { color: theme.text }]}
          >
            {macros.calories} / {targetMacros.calories}
          </Text>
        </View>

        <View style={styles.macroRingRow}>
          <MacroRing
            label="Protein"
            value={macros.protein}
            target={targetMacros.protein}
            color="#7C9A7E"
          />
          <MacroRing
            label="Carbs"
            value={macros.carbs}
            target={targetMacros.carbs}
            color="#C4A882"
          />
          <MacroRing
            label="Fat"
            value={macros.fat}
            target={targetMacros.fat}
            color="#A89070"
          />
        </View>

        {MEAL_TYPES.map((mt) => {
          const foodsInMeal = loggedFoodsForDate.filter(
            (f) => (f.meal_type || '').toLowerCase() === mt.key,
          );
          return (
            <View key={mt.key} style={styles.mealSection}>
              <View style={styles.mealHeaderRow}>
                <Text
                  style={[
                    styles.mealHeader,
                    { color: theme.primary, letterSpacing: 1 },
                  ]}
                >
                  {mt.label.toUpperCase()}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setAddFoodMealType(mt.key);
                    setAddFoodVisible(true);
                  }}
                  style={[styles.addFoodButton, { borderColor: theme.border }]}
                >
                  <Ionicons
                    name="add"
                    size={18}
                    color={theme.primary}
                    style={{ marginRight: 4 }}
                  />
                  <Text
                    style={[styles.addFoodText, { color: theme.primary }]}
                  >
                    Add
                  </Text>
                </TouchableOpacity>
              </View>

              {foodsInMeal.length === 0 ? (
                <Text
                  style={[
                    styles.emptyMealText,
                    { color: theme.textSecondary },
                  ]}
                >
                  No foods logged yet.
                </Text>
              ) : (
                foodsInMeal.map((f) => (
                  <View
                    key={f.logged_food_id}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      paddingVertical: 6,
                      paddingHorizontal: 0,
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 14,
                        fontFamily: 'Jost_400Regular',
                        color: theme.text,
                        flex: 1,
                      }}
                      numberOfLines={1}
                    >
                      {f.food_name}
                      {f.brand ? ` — ${f.brand}` : ''}
                    </Text>
                    <Text
                      style={{
                        fontSize: 12,
                        fontFamily: 'Jost_400Regular',
                        color: theme.textSecondary,
                        marginLeft: 8,
                      }}
                    >
                      {f.calories} cal
                    </Text>
                  </View>
                ))
              )}
            </View>
          );
        })}
      </ScrollView>
    );
  };

  const renderMealPlanDetail = () => {
    if (!selectedPlan) return null;

    const groupedMeals: Record<string, typeof selectedPlanMeals> = {
      breakfast: [],
      snack: [],
      lunch: [],
      dinner: [],
    };
    selectedPlanMeals.forEach((m) => {
      const key = (m.meal_type || '').toLowerCase();
      if (groupedMeals[key as keyof typeof groupedMeals]) {
        groupedMeals[key as keyof typeof groupedMeals].push(m);
      }
    });

    const groceryByCategory: Record<string, GroceryItem[]> = {};
    groceryItems.forEach((it) => {
      if (!groceryByCategory[it.category]) {
        groceryByCategory[it.category] = [];
      }
      groceryByCategory[it.category].push(it);
    });

    const prepLines =
      selectedPlan.prep_guide
        ?.split('\n')
        .map((l) => l.trim())
        .filter(Boolean) || [];

    return (
      <ScrollView
        style={styles.flex}
        contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 4 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.mealPlansHeaderRow}>
          <TouchableOpacity
            onPress={() => {
              setSelectedPlan(null);
              setSelectedPlanMeals([]);
              setGroceryItems([]);
              setPrepChecklistChecked(new Set());
            }}
          >
            <Text style={[styles.backText, { color: theme.primary }]}>
              {'< Back'}
            </Text>
          </TouchableOpacity>
          <Text style={[styles.mealPlansTitle, { color: theme.text }]}>
            {selectedPlan.plan_name}
          </Text>
        </View>

        <Text
          style={[
            styles.planMacros,
            { color: theme.textSecondary, marginBottom: 16 },
          ]}
        >
          {selectedPlan.calories_target ?? 0} cal •{' '}
          {selectedPlan.protein_target ?? 0}g P •{' '}
          {selectedPlan.carbs_target ?? 0}g C •{' '}
          {selectedPlan.fat_target ?? 0}g F
        </Text>

        <TouchableOpacity
          style={[
            styles.addFoodButton,
            {
              borderColor: theme.primary,
              backgroundColor: theme.primary,
              marginBottom: 24,
              paddingVertical: 12,
              paddingHorizontal: 20,
            },
          ]}
          onPress={handleSetPlanActive}
        >
          <Text
            style={{
              fontSize: 14,
              fontFamily: 'Jost_600SemiBold',
              color: theme.buttonText ?? '#FFFFFF',
            }}
          >
            Set as Active
          </Text>
        </TouchableOpacity>

        <View style={{ marginBottom: 24 }}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            Meals
          </Text>
          {(['breakfast', 'snack', 'lunch', 'dinner'] as const).map(
            (key) => {
              const meals = groupedMeals[key];
              if (!meals || !meals.length) return null;
              return (
                <View key={key} style={{ marginBottom: 12 }}>
                  <Text
                    style={[
                      styles.mealHeader,
                      {
                        color: theme.primary,
                        letterSpacing: 1,
                        marginBottom: 4,
                      },
                    ]}
                  >
                    {key.toUpperCase()}
                  </Text>
                  {meals.map((meal) => (
                    <View key={meal.meal_id} style={{ marginBottom: 6 }}>
                      <Text
                        style={{
                          fontSize: 14,
                          fontFamily: 'Jost_500Medium',
                          color: theme.text,
                          marginBottom: 2,
                        }}
                      >
                        {meal.meal_name}
                      </Text>
                      {meal.foods.map((food, idx) => (
                        <Text
                          key={`${meal.meal_id}_${idx}`}
                          style={{
                            fontSize: 12,
                            fontFamily: 'Jost_400Regular',
                            color: theme.textSecondary,
                          }}
                        >
                          • {food.food_name}
                          {food.brand ? ` (${food.brand})` : ''} —{' '}
                          {food.calories} kcal, {food.protein}g P,{' '}
                          {food.carbs}g C, {food.fat}g F
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              );
            },
          )}
        </View>

        {prepLines.length > 0 && (
          <View style={{ marginBottom: 24 }}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>
              Prep Guide
            </Text>
            {prepLines.map((line, idx) => (
              <TouchableOpacity
                key={idx}
                style={styles.groceryRow}
                onPress={() => {
                  setPrepChecklistChecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(idx)) next.delete(idx);
                    else next.add(idx);
                    return next;
                  });
                }}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: theme.border,
                      backgroundColor: prepChecklistChecked.has(idx)
                        ? theme.primary
                        : 'transparent',
                    },
                  ]}
                >
                  {prepChecklistChecked.has(idx) && (
                    <Ionicons
                      name="checkmark"
                      size={14}
                      color={theme.buttonText}
                    />
                  )}
                </View>
                <Text
                  style={[
                    styles.groceryText,
                    {
                      color: theme.text,
                      textDecorationLine: prepChecklistChecked.has(idx)
                        ? 'line-through'
                        : 'none',
                      opacity: prepChecklistChecked.has(idx) ? 0.6 : 1,
                    },
                  ]}
                >
                  {line}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ marginBottom: 24 }}>
          <View style={styles.mealPlansHeaderRow}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>
              Grocery List
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <TouchableOpacity
                style={[
                  styles.planGroceryButton,
                  { marginRight: 12 },
                ]}
                onPress={handleShareGroceryList}
                disabled={!groceryItems.length}
              >
                <Ionicons
                  name="share-outline"
                  size={18}
                  color={theme.primary}
                  style={{ marginRight: 4 }}
                />
                <Text
                  style={[
                    styles.planGroceryText,
                    { color: theme.primary },
                  ]}
                >
                  Share List
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.planGroceryButton}
                onPress={() =>
                  selectedPlan &&
                  handleGenerateGroceryList(selectedPlan.meal_plan_id)
                }
                disabled={loadingGrocery}
              >
                <Ionicons
                  name="refresh-outline"
                  size={18}
                  color={theme.primary}
                  style={{ marginRight: 4 }}
                />
                <Text
                  style={[
                    styles.planGroceryText,
                    { color: theme.primary },
                  ]}
                >
                  Regenerate
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {groceryItems.length === 0 ? (
            <Text
              style={[
                styles.emptyPlansText,
                { color: theme.textSecondary, marginTop: 8 },
              ]}
            >
              No grocery list yet. Tap Regenerate to create one.
            </Text>
          ) : (
            ['Produce', 'Meat & Fish', 'Dairy', 'Pantry', 'Other'].map(
              (catKey) => {
                const catItems = groceryByCategory[
                  catKey as keyof typeof groceryByCategory
                ];
                if (!catItems || !catItems.length) return null;
                return (
                  <View key={catKey} style={{ marginBottom: 16 }}>
                    <Text
                      style={[
                        styles.mealHeader,
                        {
                          color: theme.primary,
                          letterSpacing: 1,
                          marginBottom: 6,
                        },
                      ]}
                    >
                      {catKey.toUpperCase()}
                    </Text>
                    {catItems.map((it) => (
                      <TouchableOpacity
                        key={it.id}
                        style={styles.groceryRow}
                        onPress={() => toggleGroceryItem(it.id)}
                      >
                        <View
                          style={[
                            styles.checkbox,
                            {
                              borderColor: theme.border,
                              backgroundColor: it.checked
                                ? theme.primary
                                : 'transparent',
                            },
                          ]}
                        >
                          {it.checked && (
                            <Ionicons
                              name="checkmark"
                              size={14}
                              color={theme.buttonText}
                            />
                          )}
                        </View>
                        <Text
                          style={[
                            styles.groceryText,
                            {
                              color: theme.text,
                              textDecorationLine: it.checked
                                ? 'line-through'
                                : 'none',
                              opacity: it.checked ? 0.6 : 1,
                            },
                          ]}
                        >
                          {it.text}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                );
              },
            )
          )}
        </View>
      </ScrollView>
    );
  };

  const renderMealPlansTab = () => {
    if (selectedPlan) {
      return renderMealPlanDetail();
    }
    return (
      <View style={styles.flex}>
        <View style={styles.mealPlansHeaderRow}>
          <Text style={[styles.mealPlansTitle, { color: theme.text }]}>
            Saved Meal Plans
          </Text>
        </View>
        {mealPlans.length === 0 ? (
          <Text style={[styles.emptyPlansText, { color: theme.textSecondary }]}>
            No meal plans saved yet.
          </Text>
        ) : (
          <FlatList
            data={mealPlans}
            keyExtractor={(item) => String(item.meal_plan_id)}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => loadMealPlanDetails(item)}
                style={[
                  styles.planCard,
                  { borderColor: theme.border, backgroundColor: theme.card },
                ]}
              >
                <View style={styles.planHeaderRow}>
                  <Text style={[styles.planName, { color: theme.text }]}>
                    {item.plan_name}
                  </Text>
                </View>
                <Text
                  style={[styles.planMacros, { color: theme.textSecondary }]}
                >
                  {item.calories_target ?? 0} cal •{' '}
                  {item.protein_target ?? 0}g P •{' '}
                  {item.carbs_target ?? 0}g C • {item.fat_target ?? 0}g F
                </Text>
                {item.prep_guide ? (
                  <View style={{ marginTop: 8 }}>
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '600',
                        color: theme.primary,
                        marginBottom: 2,
                      }}
                    >
                      Prep Guide
                    </Text>
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.textSecondary,
                      }}
                      numberOfLines={3}
                    >
                      {item.prep_guide}
                    </Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          />
        )}

        <View style={[styles.mealPlansHeaderRow, { marginTop: 24 }]}>
          <Text style={[styles.mealPlansTitle, { color: theme.text }]}>
            Weekly Grocery List
          </Text>
        </View>
        {weeklyGrocery.length === 0 ? (
          <Text style={[styles.emptyPlansText, { color: theme.textSecondary }]}>
            Activate meal plans on this week to build a combined grocery list.
          </Text>
        ) : (
          <View
            style={[
              styles.planCard,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
          >
            {(['Produce', 'Meat & Fish', 'Dairy', 'Pantry', 'Other'] as const).map(
              (cat) => {
                const catItems = weeklyGrocery.filter(
                  (it) => it.category === cat,
                );
                if (!catItems.length) return null;
                return (
                  <View key={cat} style={{ marginBottom: 8 }}>
                    <Text
                      style={{
                        fontSize: 13,
                        fontWeight: '700',
                        color: theme.text,
                        marginBottom: 2,
                      }}
                    >
                      {cat}:
                    </Text>
                    {catItems.map((it) => (
                      <Text
                        key={it.id}
                        style={{
                          fontSize: 13,
                          color: theme.textSecondary,
                          marginLeft: 8,
                        }}
                      >
                        • {it.text}
                      </Text>
                    ))}
                  </View>
                );
              },
            )}
          </View>
        )}

        <View style={[styles.mealPlansHeaderRow, { marginTop: 24 }]}>
          <Text style={[styles.mealPlansTitle, { color: theme.text }]}>
            Weekly Meal Prep Guide
          </Text>
        </View>
        {weeklyPrep.length === 0 ? (
          <Text style={[styles.emptyPlansText, { color: theme.textSecondary }]}>
            Generate prep guides for active plans to see a combined weekly prep.
          </Text>
        ) : (
          <View
            style={[
              styles.planCard,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
          >
            {weeklyPrep.map((block, idx) => (
              <View key={`${block.plan_name}-${idx}`} style={{ marginBottom: 12 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: '700',
                    color: theme.text,
                    marginBottom: 4,
                  }}
                >
                  {block.plan_name}
                </Text>
                {block.text.split(/\r?\n/).map((line, i) => (
                  <Text
                    key={i}
                    style={{
                      fontSize: 12,
                      color: theme.textSecondary,
                      marginLeft: 8,
                    }}
                  >
                    {line}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderAddFoodModal = () => (
    <Modal
      visible={addFoodVisible}
      animationType="slide"
      onRequestClose={() => setAddFoodVisible(false)}
    >
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <View
          style={[
            styles.modalContainer,
            { backgroundColor: theme.background, paddingTop: Math.max(insets.top, 16) },
          ]}
        >
          <View style={styles.modalHeaderRow}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              Add Food
            </Text>
            <TouchableOpacity onPress={() => setAddFoodVisible(false)}>
              <Ionicons name="close" size={24} color={theme.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.modalTabRow}>
            <TouchableOpacity onPress={() => setFoodTab('search')}>
              <Text
                style={[
                  styles.modalTabLabel,
                  {
                    color:
                      foodTab === 'search' ? theme.primary : theme.textSecondary,
                  },
                ]}
              >
                Search
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setFoodTab('favorites');
                loadFavorites();
              }}
            >
              <Text
                style={[
                  styles.modalTabLabel,
                  {
                    color:
                      foodTab === 'favorites'
                        ? theme.primary
                        : theme.textSecondary,
                  },
                ]}
              >
                Favorites
              </Text>
            </TouchableOpacity>
          </View>

          {foodTab === 'search' && (
            <>
              <View
                style={[
                  styles.searchBox,
                  { borderColor: theme.border, backgroundColor: theme.card },
                ]}
              >
                <Ionicons
                  name="search"
                  size={18}
                  color={theme.textSecondary}
                  style={{ marginRight: 6 }}
                />
                <TextInput
                  style={[styles.searchInput, { color: theme.text }]}
                  placeholder="Search foods (Open Food Facts)"
                  placeholderTextColor={theme.textSecondary}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  onSubmitEditing={performSearch}
                  returnKeyType="search"
                />
                <TouchableOpacity onPress={requestScannerPermissionAndOpen}>
                  <Ionicons
                    name="barcode-outline"
                    size={18}
                    color={theme.textSecondary}
                  />
                </TouchableOpacity>
              </View>

              {searchLoading ? (
                <View style={{ marginTop: 16, alignItems: 'center' }}>
                  <ActivityIndicator color={theme.primary} />
                </View>
              ) : searchError ? (
                <Text
                  style={[
                    styles.modalInfoText,
                    { color: theme.textSecondary, marginTop: 16 },
                  ]}
                >
                  {searchError}
                </Text>
              ) : searchResults.length === 0 && searchQuery.trim() ? (
                <Text
                  style={[
                    styles.modalInfoText,
                    { color: theme.textSecondary, marginTop: 16 },
                  ]}
                >
                  No results found.
                </Text>
              ) : (
                <ScrollView style={{ marginTop: 12 }}>
                  {searchResults.map((prod, idx) => {
                    const nutriments = extractNutrients(prod.nutriments || {});
                    const name = prod.product_name || 'Food item';
                    const brand = prod.brands || '';
                    const servingSize = prod.serving_size || '';
                    const signature = buildFavoriteSignature(
                      name,
                      brand || null,
                      servingSize || null,
                    );
                    const isFavorite = favoriteSignatures.has(signature);
                    return (
                      <TouchableOpacity
                        key={prod.code || `${name}-${idx}`}
                        style={{
                          paddingVertical: 8,
                          borderBottomWidth: 1,
                          borderBottomColor: theme.border,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                        onPress={() => handleSearchResultPress(prod)}
                      >
                        <View style={{ flex: 1, paddingRight: 8 }}>
                          <Text
                            style={{
                              fontSize: 14,
                              fontWeight: '700',
                              color: theme.text,
                            }}
                            numberOfLines={1}
                          >
                            {name}
                          </Text>
                          {brand ? (
                            <Text
                              style={{
                                fontSize: 12,
                                color: theme.textSecondary,
                              }}
                              numberOfLines={1}
                            >
                              {brand}
                            </Text>
                          ) : null}
                          <Text
                            style={{
                              fontSize: 11,
                              color: theme.textSecondary,
                              marginTop: 2,
                            }}
                          >
                            {Math.round(nutriments.calories)} kcal / serving | P:{' '}
                            {Math.round(nutriments.protein)}g C:{' '}
                            {Math.round(nutriments.carbs)}g F:{' '}
                            {Math.round(nutriments.fat)}g
                          </Text>
                        </View>
                        <TouchableOpacity
                          onPress={async (e: any) => {
                            e?.stopPropagation?.();
                            if (isFavorite) {
                              try {
                                await db.runAsync(
                                  `DELETE FROM FavoriteFoods
                                   WHERE food_name = ? AND (brand IS ? OR brand = ?);`,
                                  [name, brand || null, brand || null],
                                );
                                await loadFavorites();
                                Alert.alert('Removed from favorites');
                              } catch (err) {
                                console.error(
                                  'Error removing favorite food:',
                                  err,
                                );
                              }
                            } else {
                              await handleAddFavoriteFromSearch(prod);
                            }
                          }}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          style={{
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            zIndex: 10,
                          }}
                        >
                          <Ionicons
                            name={isFavorite ? 'heart' : 'heart-outline'}
                            size={18}
                            color={theme.primary}
                          />
                        </TouchableOpacity>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </>
          )}

          {foodTab === 'favorites' && (
            <ScrollView style={{ marginTop: 12 }}>
              {favorites.length === 0 ? (
                <Text
                  style={[
                    styles.modalInfoText,
                    { color: theme.textSecondary, marginTop: 4 },
                  ]}
                >
                  You haven’t saved any favorite foods yet.
                </Text>
              ) : (
                favorites.map((fav) => (
                  <TouchableOpacity
                    key={fav.favorite_id}
                    style={{
                      paddingVertical: 8,
                      borderBottomWidth: 1,
                      borderBottomColor: theme.border,
                    }}
                    onPress={() => {
                      const nutriments = {
                        caloriesPerServing: fav.calories,
                        caloriesPer100g: 0,
                        proteinPerServing: fav.protein,
                        proteinPer100g: 0,
                        carbsPerServing: fav.carbs,
                        carbsPer100g: 0,
                        fatPerServing: fav.fat,
                        fatPer100g: 0,
                      };
                      setSelectedFood({
                        name: fav.food_name,
                        brand: fav.brand,
                        servingSize: fav.serving_size,
                        nutriments,
                      });
                      setQuantity(1);
                      if (fav.serving_size && /g\b/i.test(fav.serving_size)) {
                        setQuantityUnit('g');
                      } else if (
                        fav.serving_size &&
                        /oz\b/i.test(fav.serving_size)
                      ) {
                        setQuantityUnit('oz');
                      } else {
                        setQuantityUnit('serving');
                      }
                      setQuantityMealType(addFoodMealType);
                      setQuantityModalVisible(true);
                    }}
                    onLongPress={() => {
                      Alert.alert(
                        'Remove favorite?',
                        fav.food_name,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: async () => {
                              try {
                                await db.runAsync(
                                  'DELETE FROM FavoriteFoods WHERE favorite_id = ?;',
                                  [fav.favorite_id],
                                );
                                await loadFavorites();
                              } catch (e) {
                                console.error(
                                  'Error deleting favorite food:',
                                  e,
                                );
                              }
                            },
                          },
                        ],
                        { cancelable: true },
                      );
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: '700',
                        color: theme.text,
                      }}
                      numberOfLines={1}
                    >
                      {fav.food_name}
                    </Text>
                    {fav.brand ? (
                      <Text
                        style={{
                          fontSize: 12,
                          color: theme.textSecondary,
                        }}
                        numberOfLines={1}
                      >
                        {fav.brand}
                      </Text>
                    ) : null}
                    <Text
                      style={{
                        fontSize: 11,
                        color: theme.textSecondary,
                        marginTop: 2,
                      }}
                    >
                      {Math.round(fav.calories)} kcal / serving | P:{' '}
                      {Math.round(fav.protein)}g C:{' '}
                      {Math.round(fav.carbs)}g F:{' '}
                      {Math.round(fav.fat)}g
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {renderTabHeader()}
      {activeTab === 'today' ? (
        <>
          <View style={styles.weekRow}>
            <TouchableOpacity onPress={goPrevWeek} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.weekChevron}>
              <Ionicons name="chevron-back" size={24} color={theme.text} />
            </TouchableOpacity>
            <View style={styles.weekDaysWrap}>
              {weekDays.map((dayIso, idx) => {
                const isSelected = dayIso === selectedIso;
                const isTodayDate = dayIso === todayIso;
                return (
                  <TouchableOpacity
                    key={dayIso}
                    style={[styles.dayChip, isSelected && styles.dayChipActive]}
                    onPress={() => setSelectedDate(new Date(dayIso + 'T12:00:00'))}
                  >
                    <Text style={[styles.dayLabel, { color: isSelected ? '#fff' : theme.text }]}>{DAY_ABBREV[idx]}</Text>
                    {isTodayDate && <View style={styles.todayDot} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity onPress={goNextWeek} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.weekChevron}>
              <Ionicons name="chevron-forward" size={24} color={theme.text} />
            </TouchableOpacity>
          </View>
          <NutritionToday
            selectedDate={selectedIso}
            reload={routeParams.reload ?? nutritionTodayReloadTick}
          />
        </>
      ) : (
        <MealPlanList weekStart={weekStart} currentWeekStart={getMonday(todayIso)} />
      )}
      {renderAddFoodModal()}

      {/* Quantity modal */}
      <Modal
        visible={quantityModalVisible && !!selectedFood}
        animationType="slide"
        transparent
        onRequestClose={() => setQuantityModalVisible(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.4)',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <View
            style={[
              styles.planCard,
              {
                backgroundColor: theme.card,
                borderColor: theme.border,
                width: '90%',
              },
            ]}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <Text
                style={{
                  fontSize: 16,
                  fontFamily: 'Jost_500Medium',
                  color: theme.text,
                  flexShrink: 1,
                }}
                numberOfLines={2}
              >
                {selectedFood?.name}
              </Text>
              <TouchableOpacity
                onPress={() => setQuantityModalVisible(false)}
                style={{ marginLeft: 8, padding: 4 }}
              >
                <Ionicons name="close" size={20} color={theme.text} />
              </TouchableOpacity>
            </View>

            {selectedFood?.brand ? (
              <Text
                style={{
                  fontSize: 13,
                  fontFamily: 'Jost_300Light',
                  color: theme.textSecondary,
                  marginBottom: 4,
                }}
                numberOfLines={1}
              >
                {selectedFood.brand}
              </Text>
            ) : null}

            {selectedFood?.servingSize ? (
              <Text
                style={{
                  fontSize: 12,
                  fontFamily: 'Jost_400Regular',
                  color: theme.textSecondary,
                  marginBottom: 8,
                }}
              >
                Serving size: {selectedFood.servingSize}
              </Text>
            ) : null}

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginBottom: 8,
              }}
            >
              <Text
                style={{
                  fontSize: 14,
                  fontFamily: 'Jost_400Regular',
                  color: theme.text,
                  marginRight: 8,
                }}
              >
                Quantity
              </Text>
              <View
                style={{
                  flex: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <View
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor: theme.border,
                    borderRadius: 8,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    backgroundColor: theme.card,
                  }}
                >
                  <TextInput
                    style={{
                      fontSize: 16,
                      fontFamily: 'Jost_500Medium',
                      color: theme.text,
                    }}
                    keyboardType="decimal-pad"
                    value={String(quantity)}
                    onChangeText={(text) => {
                      const cleaned = text.replace(',', '.');
                      const val = parseFloat(cleaned);
                      if (Number.isNaN(val) || !cleaned.trim()) {
                        setQuantity(0);
                      } else {
                        setQuantity(Math.max(0, val));
                      }
                    }}
                  />
                </View>
                <TouchableOpacity
                  onPress={() => {
                    const units: typeof quantityUnit[] = [
                      'g',
                      'oz',
                      'serving',
                      'cup',
                      'tbsp',
                      'tsp',
                      'ml',
                      'lb',
                    ];
                    const currentIndex = units.indexOf(quantityUnit);
                    const nextUnit = units[(currentIndex + 1) % units.length];
                    setQuantityUnit(nextUnit);
                  }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: theme.primary,
                    backgroundColor: theme.card,
                    flexDirection: 'row',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontFamily: 'Jost_500Medium',
                      color: theme.primary,
                      marginRight: 4,
                    }}
                  >
                    {quantityUnit}
                  </Text>
                  <Ionicons
                    name="chevron-down"
                    size={16}
                    color={theme.primary}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {selectedFood && (
              <View style={{ marginBottom: 8 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontFamily: 'Jost_400Regular',
                    color: theme.textSecondary,
                  }}
                >
                  {(() => {
                    const n = selectedFood.nutriments;
                    const caloriesPerServing = n.caloriesPerServing ?? 0;
                    const caloriesPer100g = n.caloriesPer100g ?? 0;
                    const proteinPerServing = n.proteinPerServing ?? 0;
                    const proteinPer100g = n.proteinPer100g ?? 0;
                    const carbsPerServing = n.carbsPerServing ?? 0;
                    const carbsPer100g = n.carbsPer100g ?? 0;
                    const fatPerServing = n.fatPerServing ?? 0;
                    const fatPer100g = n.fatPer100g ?? 0;

                    const perServingOr100g = (
                      perS: number,
                      per100: number,
                    ) => {
                      if (quantityUnit === 'serving') {
                        return (perS || per100) * quantity;
                      }
                      const perGram = per100 / 100;
                      if (!perGram) return 0;
                      if (quantityUnit === 'g' || quantityUnit === 'ml') {
                        return perGram * quantity;
                      }
                      if (quantityUnit === 'oz') {
                        return perGram * quantity * 28.35;
                      }
                      if (quantityUnit === 'lb') {
                        return perGram * quantity * 453.592;
                      }
                      if (quantityUnit === 'cup') {
                        return perGram * quantity * 240;
                      }
                      if (quantityUnit === 'tbsp') {
                        return perGram * quantity * 15;
                      }
                      if (quantityUnit === 'tsp') {
                        return perGram * quantity * 5;
                      }
                      return (perS || per100) * quantity;
                    };

                    const cals =
                      caloriesPerServing || caloriesPer100g
                        ? perServingOr100g(
                            caloriesPerServing,
                            caloriesPer100g,
                          )
                        : 0;
                    const prot =
                      proteinPerServing || proteinPer100g
                        ? perServingOr100g(
                            proteinPerServing,
                            proteinPer100g,
                          )
                        : 0;
                    const carb =
                      carbsPerServing || carbsPer100g
                        ? perServingOr100g(
                            carbsPerServing,
                            carbsPer100g,
                          )
                        : 0;
                    const fat =
                      fatPerServing || fatPer100g
                        ? perServingOr100g(fatPerServing, fatPer100g)
                        : 0;

                    return `${Math.round(cals)} kcal • P ${Math.round(
                      prot,
                    )}g • C ${Math.round(carb)}g • F ${Math.round(fat)}g`;
                  })()}
                </Text>
              </View>
            )}

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              {MEAL_TYPES.map((mt) => (
                <TouchableOpacity
                  key={mt.key}
                  onPress={() => setQuantityMealType(mt.key)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor:
                      quantityMealType === mt.key
                        ? theme.primary
                        : theme.border,
                    backgroundColor:
                      quantityMealType === mt.key
                        ? theme.lightGreen
                        : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontFamily: 'Jost_500Medium',
                      color:
                        quantityMealType === mt.key
                          ? theme.darkGreen || theme.primary
                          : theme.text,
                    }}
                  >
                    {mt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                marginTop: 4,
              }}
            >
              <TouchableOpacity
                style={[
                  styles.shareButton,
                  {
                    backgroundColor: theme.card,
                    borderRadius: 999,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  },
                ]}
                onPress={async () => {
                  if (!selectedFood) return;
                  await handleAddFavoriteFromSearch({
                    product_name: selectedFood.name,
                    brands: selectedFood.brand,
                    serving_size: selectedFood.servingSize,
                    nutriments: selectedFood.nutriments,
                  });
                }}
              >
                <Ionicons
                  name="heart-outline"
                  size={18}
                  color={theme.primary}
                  style={{ marginRight: 6 }}
                />
                <Text
                  style={{
                    fontSize: 13,
                    fontFamily: 'Jost_500Medium',
                    color: theme.primary,
                  }}
                >
                  Add to Favorites
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.shareButton,
                  {
                    backgroundColor: theme.buttonBackground,
                    borderRadius: 999,
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                  },
                ]}
                onPress={async () => {
                  if (!selectedFood) return;
                  try {
                    await logFoodToToday(
                      selectedFood.name,
                      selectedFood.brand,
                      selectedFood.servingSize,
                      selectedFood.nutriments,
                      quantityMealType,
                      quantity,
                      quantityUnit,
                    );
                    setQuantityModalVisible(false);
                    setAddFoodVisible(false);
                  } catch (e) {
                    console.error(
                      'Error logging food from quantity modal:',
                      e,
                    );
                  }
                }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    fontFamily: 'Jost_500Medium',
                    color: theme.buttonText,
                  }}
                >
                  Add to Log
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Scanner modal */}
      <Modal
        visible={scannerVisible}
        animationType="slide"
        onRequestClose={() => setScannerVisible(false)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: 'black' }} edges={['top']}>
          <TouchableOpacity
            onPress={() => setScannerVisible(false)}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              zIndex: 10,
              backgroundColor: 'rgba(0,0,0,0.5)',
              borderRadius: 20,
              padding: 8,
            }}
          >
            <Ionicons name="close" size={24} color="#FFFFFF" />
          </TouchableOpacity>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{
              barcodeTypes: [
                'ean13',
                'ean8',
                'upc_a',
                'upc_e',
                'qr',
                'code128',
                'code39',
              ],
            }}
            onBarCodeScanned={handleBarcodeScanned}
          />
          <View
            style={{
              position: 'absolute',
              top: '35%',
              left: '15%',
              width: '70%',
              height: '30%',
              borderWidth: 2,
              borderColor: '#FFFFFF',
              borderRadius: 8,
            }}
          />
          <View
            style={{
              position: 'absolute',
              bottom: 32,
              alignSelf: 'center',
              backgroundColor: 'rgba(0,0,0,0.6)',
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 999,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <Ionicons name="barcode-outline" size={18} color="#FFFFFF" />
            <Text style={{ color: '#FFFFFF', marginLeft: 8, fontSize: 13 }}>
              Align barcode within the frame
            </Text>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  flex: {
    flex: 1,
  },
  tabHeaderRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  tabButtonActive: {},
  tabButtonText: {
    fontSize: 15,
    fontFamily: 'Jost_500Medium',
  },
  tabUnderline: {
    marginTop: 4,
    height: 2,
    borderRadius: 999,
    alignSelf: 'stretch',
  },
  dateText: {
    fontSize: 14,
    fontFamily: 'Jost_400Regular',
    marginBottom: 8,
  },
  todayContent: {
    paddingBottom: 24,
  },
  caloriesInlineRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  caloriesInlineLabel: {
    fontSize: 10,
    letterSpacing: 1,
    marginRight: 6,
  },
  caloriesInlineValue: {
    fontSize: 36,
    fontFamily: 'CormorantGaramond-Bold',
  },
  macroRingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  mealSection: {
    marginBottom: 14,
  },
  mealHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  mealHeader: {
    fontSize: 11,
    fontFamily: 'Jost_600SemiBold',
    letterSpacing: 1.5,
  },
  addFoodButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  addFoodText: {
    fontSize: 12,
    fontFamily: 'Jost_500Medium',
  },
  emptyMealText: {
    fontSize: 12,
    opacity: 0.7,
  },
  mealPlansHeaderRow: {
    marginBottom: 12,
  },
  mealPlansTitle: {
    fontSize: 18,
    fontFamily: 'CormorantGaramond-Bold',
  },
  emptyPlansText: {
    fontSize: 14,
    opacity: 0.7,
    fontFamily: 'Jost_400Regular',
  },
  modalContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'CormorantGaramond-Bold',
  },
  modalTabRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 16,
  },
  modalTabLabel: {
    fontSize: 14,
    fontFamily: 'Jost_500Medium',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Jost_400Regular',
  },
  modalInfoText: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Jost_300Light',
  },
  planCard: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  planHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  planName: {
    fontSize: 16,
    fontFamily: 'CormorantGaramond-Bold',
  },
  planMacros: {
    fontSize: 12,
    fontFamily: 'Jost_400Regular',
  },
  planGroceryButton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planGroceryText: {
    fontSize: 12,
    fontFamily: 'Jost_500Medium',
  },
  groceryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    marginRight: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  groceryText: {
    fontSize: 14,
    flexShrink: 1,
    fontFamily: 'Jost_400Regular',
  },
  shareButton: {
    marginTop: 8,
    marginBottom: 16,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
  },
  shareButtonText: {
    fontSize: 14,
    fontFamily: 'Jost_500Medium',
  },
  backText: {
    fontSize: 14,
    fontFamily: 'Jost_500Medium',
  },
  weekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  weekChevron: { padding: 8 },
  weekDaysWrap: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  dayChip: {
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    minWidth: 36,
    alignItems: 'center',
  },
  dayChipActive: {
    backgroundColor: SAGE_GREEN,
  },
  dayLabel: { fontSize: 12, fontWeight: '600' },
  todayDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: SAGE_GREEN,
    marginTop: 2,
  },
  selectedDateLabel: {
    fontSize: 13,
    fontWeight: '300',
    textAlign: 'center',
    marginBottom: 8,
  },
});

type MacroRingProps = {
  label: string;
  value: number;
  target: number;
  color: string;
};

const MacroRing: React.FC<MacroRingProps> = ({
  label,
  value,
  target,
  color,
}) => {
  const size = 70;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = target > 0 ? Math.min(1, value / target) : 0;
  const strokeDashoffset = circumference * (1 - ratio);

  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#E8E0D0"
          strokeWidth={strokeWidth}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View
        style={{
          position: 'absolute',
          top: size / 2 - 12,
          alignItems: 'center',
        }}
      >
        <Text style={{ fontSize: 14, fontWeight: '700' }}>{value}</Text>
        <Text style={{ fontSize: 10 }}>g</Text>
      </View>
      <Text style={{ marginTop: 4, fontSize: 12, fontWeight: '600' }}>
        {label}
      </Text>
      <Text style={{ fontSize: 10, opacity: 0.7 }}>
        {value} / {target}g target
      </Text>
    </View>
  );
};


