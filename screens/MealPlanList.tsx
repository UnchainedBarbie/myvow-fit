/**
 * List of meal plans for a given week; tap to open detail. Swipe left to delete.
 * When empty: message only; Build with Sage / Build My Own / Copy from previous week (brings plan templates into this week; tracker activates only via Set as Active) sit below Weekly meal prep in the footer.
 */
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  TextInput,
  Keyboard,
  TouchableWithoutFeedback,
  Share,
  Modal,
  Linking,
  ScrollView,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { initMealPlansDb } from '../utils/initMealPlansDb';
import { initNutritionDb } from '../utils/nutritionDb';
import {
  aggregateGroceryListJsonEntriesByNameAndUnit,
  buildPrepGuideTextFromUniqueFoodNames,
  buildGroceryListJsonFromPlanFoodRows,
  countWeeklyPlanDaysForGrocery,
  fetchMealPlanFoodRowsForGrocery,
  generateGroceryListFromPlan,
  generatePrepGuideFromPlan,
  multiplyPlanFoodRowsForWeek,
  parseGroceryListItemForAggregation,
} from '../utils/generateMealPlanGroceryAndPrep';
import { addDaysToLocalYmd } from '../utils/localDateYmd';

const SAGE = '#7C9A7E';
const CREAM_MODAL_BG = '#F5F0E8';

type PlanRow = { meal_plan_id: number; name: string };

type CopyWeekOption = { weekStartYmd: string; weekEndYmd: string; label: string };

function formatWeekRangeLabel(monYmd: string, sunYmd: string): string {
  const mon = new Date(monYmd + 'T12:00:00');
  const sun = new Date(sunYmd + 'T12:00:00');
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${mon.toLocaleDateString(undefined, opts)} - ${sun.toLocaleDateString(undefined, opts)}`;
}

/** weekStartIso is Monday; returns Sunday of that week (YYYY-MM-DD). */
function sundayOfWeekIso(weekStartIso: string): string {
  const d = new Date(weekStartIso + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

const GROCERY_CATS = ['Produce', 'Meat & Fish', 'Dairy', 'Pantry', 'Other'] as const;
type GroceryCategory = (typeof GROCERY_CATS)[number];

type MergedGroceryRow = { key: string; text: string; category: GroceryCategory };

function normalizeGroceryCategory(raw: string | undefined): GroceryCategory {
  const c = (raw || 'Other').trim();
  if (c === 'Produce' || c === 'Meat & Fish' || c === 'Dairy' || c === 'Pantry' || c === 'Other') return c;
  if (c === 'Protein') return 'Meat & Fish'; // legacy grocery JSON
  return 'Other';
}

/** Split prep guide text into numbered steps (e.g. "1. Title\\n   body"). */
function parsePrepGuideSteps(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const parts = t.split(/\n(?=\d+\.\s)/);
  return parts.map((p) => p.trim()).filter((p) => /^\d+\./.test(p));
}

function buildWeeklyGroceryShareText(
  weekStart: string,
  byCategory: Record<GroceryCategory, MergedGroceryRow[]>,
): string {
  const sun = sundayOfWeekIso(weekStart);
  const lines: string[] = [`Weekly grocery list (${weekStart} – ${sun})`, ''];
  for (const cat of GROCERY_CATS) {
    const rows = byCategory[cat];
    if (rows.length === 0) continue;
    lines.push(`${cat}:`);
    for (const r of rows) {
      lines.push(`  • ${r.text}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function buildWeeklyPrepShareText(guideText: string): string {
  const t = guideText.trim();
  if (!t) return '';
  return `Weekly meal prep\n\n${t}`;
}

/**
 * Parse grocery_list JSON into merged rows for the weekly list UI.
 * @param dedupeByItemText When true (default), merge lines with the same food name (case-insensitive) and unit, summing quantities.
 *   When false, keep one UI row per JSON entry (keys include index for stability).
 */
function groceryJsonToMergedRows(parsed: unknown, dedupeByItemText = true): MergedGroceryRow[] {
  if (!Array.isArray(parsed)) return [];
  const raw: { category: string; item: string }[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    const item = String(
      (entry as { item?: string; text?: string })?.item ??
        (entry as { text?: string })?.text ??
        '',
    ).trim();
    if (!item) continue;
    const category = normalizeGroceryCategory((entry as { category?: string })?.category);
    raw.push({ category, item });
  }
  const entries = dedupeByItemText
    ? aggregateGroceryListJsonEntriesByNameAndUnit(raw)
    : raw.map((r) => ({ category: r.category, item: r.item, checked: false }));

  const items: MergedGroceryRow[] = entries.map((e, i) => {
    const text = e.item.trim();
    const category = normalizeGroceryCategory(e.category);
    const p = parseGroceryListItemForAggregation(text);
    const key = dedupeByItemText
      ? `${category}|${p.nameKey}|${p.unitNorm}`
      : `${category}|${p.nameKey}|${p.unitNorm}|${i}`;
    return { key, text, category };
  });
  items.sort((a, b) => {
    const ca = GROCERY_CATS.indexOf(a.category);
    const cb = GROCERY_CATS.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return a.text.localeCompare(b.text);
  });
  return items;
}

export type MealPlanListProps = { weekStart: string; currentWeekStart: string };

export default function MealPlanList({ weekStart, currentWeekStart }: MealPlanListProps) {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [copying, setCopying] = useState(false);
  /** Plans with at least one DayActivePlan row on any day Mon–Sun of the displayed week. */
  const [activePlanIdsInWeek, setActivePlanIdsInWeek] = useState<Set<number>>(new Set());
  const [mergedGrocery, setMergedGrocery] = useState<MergedGroceryRow[]>([]);
  /** Single combined prep guide for all active plans (built from union of foods). */
  const [combinedPrepGuideText, setCombinedPrepGuideText] = useState('');
  const [groceryChecked, setGroceryChecked] = useState<Set<string>>(new Set());
  const [prepStepChecked, setPrepStepChecked] = useState<Record<string, boolean>>({});
  const [regeneratingWeekly, setRegeneratingWeekly] = useState(false);
  /** When not `database`, merged grocery UI comes from family generation (not DB merge). */
  const [groceryUiSource, setGroceryUiSource] = useState<'database' | 'family'>('database');
  const [groceryModalVisible, setGroceryModalVisible] = useState(false);
  const [groceryModalMode, setGroceryModalMode] = useState<'mealPlan' | 'family'>('mealPlan');
  const [familySize, setFamilySize] = useState(1);
  const [grocerySectionExpanded, setGrocerySectionExpanded] = useState(false);
  const [prepSectionExpanded, setPrepSectionExpanded] = useState(false);
  const [renamingPlan, setRenamingPlan] = useState<PlanRow | null>(null);
  const [renameText, setRenameText] = useState('');
  const [copyScheduleModalVisible, setCopyScheduleModalVisible] = useState(false);
  const [copyWeekOptions, setCopyWeekOptions] = useState<CopyWeekOption[]>([]);
  const [loadingCopyWeekOptions, setLoadingCopyWeekOptions] = useState(false);

  const activePlanIdsSignature = useMemo(
    () => [...activePlanIdsInWeek].sort((a, b) => a - b).join(','),
    [activePlanIdsInWeek],
  );

  useEffect(() => {
    setGroceryChecked(new Set());
    setPrepStepChecked({});
  }, [weekStart, activePlanIdsSignature]);

  useEffect(() => {
    setGroceryUiSource('database');
  }, [weekStart]);

  const groceryByCategory = useMemo(() => {
    const map: Record<GroceryCategory, MergedGroceryRow[]> = {
      Produce: [],
      'Meat & Fish': [],
      Dairy: [],
      Pantry: [],
      Other: [],
    };
    for (const row of mergedGrocery) {
      map[row.category].push(row);
    }
    return map;
  }, [mergedGrocery]);

  const toggleGroceryItem = useCallback((key: string) => {
    setGroceryChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const togglePrepStep = useCallback((stepIdx: number) => {
    const k = `weekly_prep_${stepIdx}`;
    setPrepStepChecked((prev) => ({ ...prev, [k]: !prev[k] }));
  }, []);

  /** Parsed numbered steps for the single combined weekly prep guide (+ summary line if present). */
  const combinedPrepSteps = useMemo(() => {
    const t = combinedPrepGuideText.trim();
    if (!t) return [];
    const steps = parsePrepGuideSteps(combinedPrepGuideText);
    const includeMatch = t.match(/Your plan includes:[^\n]*/);
    const summaryLine = includeMatch?.[0]?.trim();
    const base = steps.length > 0 ? steps : [t];
    if (summaryLine && !base.some((s) => s.includes('Your plan includes'))) {
      return [...base, summaryLine];
    }
    return base;
  }, [combinedPrepGuideText]);

  const shareWeeklyGrocery = useCallback(async () => {
    if (mergedGrocery.length === 0) {
      Alert.alert('Nothing to share', 'Generate a grocery list first using the button above.');
      return;
    }
    const message = buildWeeklyGroceryShareText(weekStart, groceryByCategory);
    try {
      await Share.share({ message, title: 'Weekly grocery list' });
    } catch (e) {
      console.warn('shareWeeklyGrocery', e);
    }
  }, [weekStart, groceryByCategory, mergedGrocery.length]);

  const openInstacartForGrocery = useCallback(async () => {
    if (mergedGrocery.length === 0) {
      Alert.alert('No items', 'Generate a grocery list first using the button above.');
      return;
    }
    const withText = mergedGrocery.map((r) => ({ ...r, text: r.text.trim() })).filter((r) => r.text.length > 0);
    if (withText.length === 0) {
      Alert.alert('No items', 'Nothing to search on Instacart.');
      return;
    }
    const meat = withText.find((r) => r.category === 'Meat & Fish');
    const produce = withText.find((r) => r.category === 'Produce');
    const query = (meat ?? produce ?? withText[0]).text;
    const url = `https://www.instacart.com/store/search?query=${encodeURIComponent(query)}`;
    try {
      await Linking.openURL(url);
    } catch (e) {
      console.warn('openInstacartForGrocery', e);
      Alert.alert('Unable to open', 'Could not open Instacart. Try again in a moment.');
    }
  }, [mergedGrocery]);

  const shareWeeklyPrep = useCallback(async () => {
    if (!combinedPrepGuideText.trim()) {
      Alert.alert('Nothing to share', 'Generate meal prep guides first using the button above.');
      return;
    }
    const message = buildWeeklyPrepShareText(combinedPrepGuideText);
    try {
      await Share.share({ message, title: 'Weekly meal prep' });
    } catch (e) {
      console.warn('shareWeeklyPrep', e);
    }
  }, [combinedPrepGuideText]);

  const loadPlans = useCallback(async (opts?: { groceryForceDb?: boolean }) => {
    const mergeGroceryFromDb = opts?.groceryForceDb === true || groceryUiSource === 'database';
    await initMealPlansDb(db);
    await initNutritionDb(db as any).catch(() => {});
    try {
      await db.runAsync('ALTER TABLE MealPlans ADD COLUMN week_start TEXT').catch(() => {});
    } catch (_) {}
    // Load meal plans for this week; for current week only, also include plans with no week set (week_start IS NULL) so they are not lost
    const isCurrentWeek = weekStart === currentWeekStart;
    const rows = await db.getAllAsync<{
      meal_plan_id: number;
      plan_name: string;
    }>(
      isCurrentWeek
        ? `SELECT meal_plan_id, plan_name FROM MealPlans WHERE week_start = ? OR week_start IS NULL ORDER BY created_date DESC`
        : `SELECT meal_plan_id, plan_name FROM MealPlans WHERE week_start = ? ORDER BY created_date DESC`,
      [weekStart]
    );
    setPlans(rows.map((r) => ({ meal_plan_id: r.meal_plan_id, name: r.plan_name ?? 'Plan' })));
    const monday_iso = weekStart;
    const sunday_iso = sundayOfWeekIso(weekStart);
    const activeRows = await db.getAllAsync<{ meal_plan_id: number }>(
      'SELECT DISTINCT meal_plan_id FROM DayActivePlan WHERE date >= ? AND date <= ?',
      [monday_iso, sunday_iso]
    ).catch(() => []);
    const uniqueActive = [...new Set(activeRows.map((r) => r.meal_plan_id))];
    setActivePlanIdsInWeek(new Set(uniqueActive));

    if (uniqueActive.length === 0) {
      setCombinedPrepGuideText('');
      if (mergeGroceryFromDb) {
        setMergedGrocery([]);
      }
    } else {
      const ph = uniqueActive.map(() => '?').join(',');
      const planRows = (await db
        .getAllAsync(
          `SELECT meal_plan_id, plan_name, grocery_list FROM MealPlans WHERE meal_plan_id IN (${ph})`,
          uniqueActive,
        )
        .catch(() => [])) as {
        meal_plan_id: number;
        plan_name: string | null;
        grocery_list: string | null;
      }[];

      if (mergeGroceryFromDb) {
        const allEntries: { category: string; item: string }[] = [];
        for (const p of planRows) {
          const raw = p.grocery_list;
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) continue;
            for (const entry of parsed) {
              const item = String(
                (entry as { item?: string; text?: string })?.item ??
                  (entry as { text?: string })?.text ??
                  '',
              ).trim();
              if (!item) continue;
              allEntries.push({
                category: normalizeGroceryCategory((entry as { category?: string })?.category),
                item,
              });
            }
          } catch {
            /* ignore malformed grocery JSON */
          }
        }
        const aggregated = aggregateGroceryListJsonEntriesByNameAndUnit(allEntries);
        setMergedGrocery(groceryJsonToMergedRows(aggregated, false));
      }

      const fromPlanned = (await db
        .getAllAsync<{ food_name: string }>(
          `SELECT fi.food_name FROM PlannedMeals pm
           INNER JOIN FoodItems fi ON fi.meal_id = pm.meal_id
           WHERE pm.meal_plan_id IN (${ph})`,
          uniqueActive,
        )
        .catch(() => [])) as { food_name: string }[];
      const fromLegacy = (await db
        .getAllAsync<{ food_name: string }>(
          `SELECT food_name FROM MealPlanItems WHERE meal_plan_id IN (${ph})`,
          uniqueActive,
        )
        .catch(() => [])) as { food_name: string }[];
      const allFoodNames = [
        ...fromPlanned.map((r) => r.food_name),
        ...fromLegacy.map((r) => r.food_name),
      ];
      setCombinedPrepGuideText(buildPrepGuideTextFromUniqueFoodNames(allFoodNames));
    }
  }, [db, weekStart, currentWeekStart, groceryUiSource]);

  const applyGroceryJsonToUi = useCallback(
    (list: { category: string; item: string; checked?: boolean }[], dedupeByItemText = true) => {
      setMergedGrocery(groceryJsonToMergedRows(list, dedupeByItemText));
    },
    [],
  );

  /** Build grocery_list + prep_guide from each active plan's meals (PlannedMeals / MealPlanItems). */
  const regenerateWeeklyForActivePlans = useCallback(async () => {
    const ids = [...activePlanIdsInWeek];
    if (ids.length === 0) {
      Alert.alert('No active plans', 'Set one or more meal plans as active for this week first.');
      return;
    }
    setRegeneratingWeekly(true);
    try {
      await initNutritionDb(db as any).catch(() => {});
      for (const id of ids) {
        await generateGroceryListFromPlan(db, id);
        await generatePrepGuideFromPlan(db, id);
      }
      setGroceryUiSource('database');
      await loadPlans({ groceryForceDb: true });
    } catch (e) {
      console.error('regenerateWeeklyForActivePlans', e);
      Alert.alert(
        'Could not generate',
        'Make sure each active plan has meals and foods (or legacy meal items), then try again.',
      );
    } finally {
      setRegeneratingWeekly(false);
    }
  }, [activePlanIdsInWeek, db, loadPlans]);

  const confirmGroceryModal = useCallback(async () => {
    if (groceryModalMode === 'mealPlan') {
      setGroceryModalVisible(false);
      await regenerateWeeklyForActivePlans();
      setGrocerySectionExpanded(true);
      return;
    }

    const ids = [...activePlanIdsInWeek];
    if (ids.length === 0) {
      Alert.alert('No active plans', 'Set an active meal plan for this week to scale a family grocery list.');
      return;
    }
    setRegeneratingWeekly(true);
    try {
      await initNutritionDb(db as any).catch(() => {});
      const allRows: { food_name: string; serving_size?: string | null }[] = [];
      for (const id of ids) {
        const rows = await fetchMealPlanFoodRowsForGrocery(db, id);
        const weekDays = await countWeeklyPlanDaysForGrocery(db, id);
        allRows.push(...multiplyPlanFoodRowsForWeek(rows, weekDays));
      }
      if (allRows.length === 0) {
        Alert.alert('No foods in plans', 'Add foods to your active meal plans first.');
        return;
      }
      const json = buildGroceryListJsonFromPlanFoodRows(allRows, { familySize });
      setGroceryUiSource('family');
      applyGroceryJsonToUi(json);
      setGroceryModalVisible(false);
      setGrocerySectionExpanded(true);
    } catch (e) {
      console.error('confirmGroceryModal family', e);
      Alert.alert('Could not build list', 'Try again in a moment.');
    } finally {
      setRegeneratingWeekly(false);
    }
  }, [
    applyGroceryJsonToUi,
    db,
    familySize,
    groceryModalMode,
    regenerateWeeklyForActivePlans,
    activePlanIdsInWeek,
  ]);

  useFocusEffect(
    useCallback(() => {
      loadPlans();
    }, [loadPlans])
  );

  const deletePlan = async (item: PlanRow) => {
    const id = item.meal_plan_id;
    setPlans((prev) => prev.filter((p) => p.meal_plan_id !== id));
    const noop = () => {};
    try {
      // Clear DailyLog reference so FK doesn't block (nutritionDb)
      await db.runAsync('UPDATE DailyLog SET meal_plan_id = NULL WHERE meal_plan_id = ?', [id]).catch(noop);
      await db.runAsync('DELETE FROM FoodItems WHERE meal_id IN (SELECT meal_id FROM PlannedMeals WHERE meal_plan_id = ?)', [id]).catch(noop);
      await db.runAsync('DELETE FROM PlannedMeals WHERE meal_plan_id = ?', [id]).catch(noop);
      // initMealPlansDb schema
      await db.runAsync('DELETE FROM DayActivePlan WHERE meal_plan_id = ?', [id]).catch(noop);
      await db.runAsync('DELETE FROM MealPlanSchedule WHERE meal_plan_id = ?', [id]).catch(noop);
      await db.runAsync('DELETE FROM MealPlanItems WHERE meal_plan_id = ?', [id]).catch(noop);
      await db.runAsync('DELETE FROM FoodLogEntry WHERE meal_plan_id = ?', [id]).catch(noop);
      await db.runAsync('DELETE FROM MealPlans WHERE meal_plan_id = ?', [id]);
    } catch (e) {
      console.error('deletePlan error:', e);
      await loadPlans();
      return;
    }
    await loadPlans();
  };

  const confirmDelete = (item: PlanRow) => {
    Alert.alert(
      'Delete Meal Plan?',
      `This will permanently delete ${item.name} and all its meals, foods, and grocery list. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deletePlan(item) },
      ]
    );
  };

  const renderRightActions = (item: PlanRow, close: () => void) => {
    return (
      <RectButton
        style={styles.deleteButton}
        onPress={() => {
          close();
          confirmDelete(item);
        }}
      >
        <Text style={styles.deleteButtonText}>Delete</Text>
      </RectButton>
    );
  };

  const buildWithSage = () => {
    navigation.navigate('Sage' as never, { mealPlanWeekStart: weekStart } as never);
  };

  const buildMyself = async () => {
    try {
      await db.runAsync(
        `INSERT INTO MealPlans (plan_name, week_start, created_date) VALUES (?, ?, ?)`,
        ['My plan', weekStart, new Date().toISOString()]
      );
      const r = await db.getFirstAsync<{ meal_plan_id: number }>('SELECT last_insert_rowid() as meal_plan_id');
      const id = r?.meal_plan_id;
      if (id) {
        await loadPlans();
        navigation.navigate('MealPlanDetail', { meal_plan_id: id, name: 'My plan' });
      } else {
        await loadPlans();
      }
    } catch (e) {
      console.error('buildMyself error:', e);
      await loadPlans();
    }
  };

  const openCopyScheduleModal = useCallback(async () => {
    setLoadingCopyWeekOptions(true);
    setCopyScheduleModalVisible(true);
    try {
      await initMealPlansDb(db);
      // Anchor to the week shown on the Plans tab (not "today"), so e.g. viewing Apr 6–12
      // offers Mar 30–Apr 5 as the prior week even when today is still in March.
      const anchorMonday = weekStart;
      const options: CopyWeekOption[] = [];
      for (let i = 1; i <= 4; i++) {
        const mon = addDaysToLocalYmd(anchorMonday, -7 * i);
        const sun = addDaysToLocalYmd(mon, 6);
        const countRow = await db.getFirstAsync<{ n: number }>(
          'SELECT COUNT(*) as n FROM DayActivePlan WHERE date >= ? AND date <= ?',
          [mon, sun],
        );
        const n = Number(countRow?.n ?? 0);
        if (n > 0) {
          options.push({
            weekStartYmd: mon,
            weekEndYmd: sun,
            label: formatWeekRangeLabel(mon, sun),
          });
        }
      }
      setCopyWeekOptions(options);
    } catch (e) {
      console.error('openCopyScheduleModal error:', e);
      setCopyWeekOptions([]);
    } finally {
      setLoadingCopyWeekOptions(false);
    }
  }, [db, weekStart]);

  const copyDayActivePlanFromWeekToCurrent = useCallback(
    async (sourceMon: string, sourceSun: string) => {
      const targetMon = weekStart;
      setCopying(true);
      try {
        const srcRows = await db.getAllAsync<{ date: string; meal_plan_id: number }>(
          'SELECT date, meal_plan_id FROM DayActivePlan WHERE date >= ? AND date <= ? ORDER BY date, meal_plan_id',
          [sourceMon, sourceSun],
        );
        // Use source week's DayActivePlan only to learn which plan templates to attach to this week.
        // Do not write DayActivePlan for the current week — that would load the nutrition tracker before the user taps Set as Active.
        const copiedPlanIds = [...new Set(srcRows.map((r) => r.meal_plan_id))];
        await db.withTransactionAsync(async () => {
          for (const planId of copiedPlanIds) {
            // Drop active-day rows for the week we copied from; otherwise they still look
            // "active in the future" on the detail screen while week_start points at the new week.
            await db.runAsync(
              'DELETE FROM DayActivePlan WHERE meal_plan_id = ? AND date >= ? AND date <= ?',
              [planId, sourceMon, sourceSun],
            );
            await db.runAsync('UPDATE MealPlans SET week_start = ? WHERE meal_plan_id = ?', [
              targetMon,
              planId,
            ]);
          }
        });
        setCopyScheduleModalVisible(false);
        await loadPlans({ groceryForceDb: true });
      } catch (e) {
        console.error('copyDayActivePlanFromWeekToCurrent error:', e);
        Alert.alert('Could not copy', 'Something went wrong updating your schedule. Try again.');
      } finally {
        setCopying(false);
      }
    },
    [db, loadPlans, weekStart],
  );

  const actionButtons = (
    <View style={styles.actionButtonsWrap}>
      <TouchableOpacity style={[styles.emptyBtn, { backgroundColor: SAGE }]} onPress={buildWithSage}>
        <Text style={styles.emptyBtnText}>Build with Sage</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.emptyBtn, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={buildMyself}>
        <Text style={[styles.emptyBtnText, { color: theme.text }]}>Build My Own</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.emptyBtn, { backgroundColor: theme.card, borderColor: theme.border }]}
        onPress={() => void openCopyScheduleModal()}
        disabled={copying}
      >
        <Text style={[styles.emptyBtnText, { color: theme.text }]}>Copy from previous week</Text>
      </TouchableOpacity>
    </View>
  );

  const emptyComponent = (
    <View style={styles.emptyWrap}>
      <Text style={[styles.empty, { color: theme.text }]}>No meal plans for this week.</Text>
    </View>
  );

  const listFooter = (
    <View style={styles.footerWrap}>
      {activePlanIdsInWeek.size > 0 ? (
        <View style={[styles.weeklyActionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.weeklyActionHint, { color: theme.textSecondary }]}>
            Grocery and prep come from your <Text style={{ fontWeight: '700' }}>active</Text> plans, or use the family
            option in the generator. Tap after you add or change meals.
          </Text>
          <TouchableOpacity
            style={[styles.refreshWeeklyBtn, { backgroundColor: SAGE }]}
            onPress={() => {
              setGroceryModalMode('mealPlan');
              setFamilySize(1);
              setGroceryModalVisible(true);
            }}
            disabled={regeneratingWeekly}
            activeOpacity={0.85}
          >
            {regeneratingWeekly ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <View style={styles.refreshWeeklyBtnInner}>
                <Ionicons name="cart-outline" size={20} color="#fff" />
                <Text style={styles.refreshWeeklyBtnText}>Generate grocery list</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.collapseHeaderRow}>
          <TouchableOpacity
            style={styles.collapseHeaderTap}
            onPress={() => setGrocerySectionExpanded((v) => !v)}
            activeOpacity={0.65}
          >
            <Ionicons
              name={grocerySectionExpanded ? 'chevron-down' : 'chevron-forward'}
              size={22}
              color={theme.text}
            />
            <Text style={[styles.collapseHeaderTitle, { color: theme.text }]}>Weekly grocery list</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={shareWeeklyGrocery}
            style={styles.shareIconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Share grocery list"
          >
            <Ionicons
              name="share-outline"
              size={22}
              color={mergedGrocery.length === 0 ? theme.textSecondary : SAGE}
            />
          </TouchableOpacity>
        </View>
        {grocerySectionExpanded ? (
          <>
            <Text style={[styles.sectionSub, { color: theme.textSecondary }]}>
              {groceryUiSource === 'family'
                ? `Scaled for ${familySize} people from active plans' template foods (not saved to each plan).`
                : `Merged from stored lists for plans active this week (${weekStart} – ${sundayOfWeekIso(weekStart)}).`}{' '}
              Tap share to send to Notes, Messages, etc.
            </Text>
            {activePlanIdsInWeek.size === 0 ? (
              <Text style={[styles.sectionHint, { color: theme.textSecondary }]}>
                Set one or more plans as active for this week to see items here.
              </Text>
            ) : mergedGrocery.length === 0 ? (
              <Text style={[styles.sectionHint, { color: theme.textSecondary }]}>
                {
                  "Nothing here yet. Use the button above to generate a combined list from your active plans' meals."
                }
              </Text>
            ) : (
              <>
                {GROCERY_CATS.map((cat) => {
                  const rows = groceryByCategory[cat];
                  if (rows.length === 0) return null;
                  return (
                    <View key={cat} style={styles.categoryBlock}>
                      <Text style={[styles.categoryTitle, { color: theme.text }]}>{cat}</Text>
                      {rows.map((row) => {
                        const checked = groceryChecked.has(row.key);
                        return (
                          <TouchableOpacity
                            key={row.key}
                            style={[styles.checkRow, { borderColor: theme.border }]}
                            onPress={() => toggleGroceryItem(row.key)}
                            activeOpacity={0.7}
                          >
                            <Ionicons
                              name={checked ? 'checkbox' : 'square-outline'}
                              size={22}
                              color={checked ? SAGE : theme.text}
                            />
                            <Text
                              style={[
                                styles.checkRowText,
                                { color: theme.text },
                                checked && styles.checkRowTextDone,
                              ]}
                            >
                              {row.text}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  );
                })}
                <TouchableOpacity
                  style={[styles.refreshWeeklyBtn, styles.instacartBtn, { backgroundColor: SAGE }]}
                  onPress={openInstacartForGrocery}
                  activeOpacity={0.85}
                >
                  <Text style={styles.refreshWeeklyBtnText}>Shop on Instacart</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        ) : null}
      </View>

      <View style={[styles.sectionCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.collapseHeaderRow}>
          <TouchableOpacity
            style={styles.collapseHeaderTap}
            onPress={() => setPrepSectionExpanded((v) => !v)}
            activeOpacity={0.65}
          >
            <Ionicons
              name={prepSectionExpanded ? 'chevron-down' : 'chevron-forward'}
              size={22}
              color={theme.text}
            />
            <Text style={[styles.collapseHeaderTitle, { color: theme.text }]}>Weekly meal prep</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={shareWeeklyPrep}
            style={styles.shareIconBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Share meal prep"
          >
            <Ionicons
              name="share-outline"
              size={22}
              color={!combinedPrepGuideText.trim() ? theme.textSecondary : SAGE}
            />
          </TouchableOpacity>
        </View>
        {prepSectionExpanded ? (
          <>
            <Text style={[styles.sectionSub, { color: theme.textSecondary }]}>
              One combined prep guide from all foods in your active plans (deduplicated). Tap share to send to Notes,
              Messages, etc.
            </Text>
            {activePlanIdsInWeek.size === 0 ? (
              <Text style={[styles.sectionHint, { color: theme.textSecondary }]}>
                Set plans as active for this week to see prep steps here.
              </Text>
            ) : combinedPrepSteps.length === 0 ? (
              <Text style={[styles.sectionHint, { color: theme.textSecondary }]}>
                Nothing here yet. Use the button above to generate prep steps from your active plans' meals.
              </Text>
            ) : (
              combinedPrepSteps.map((step, idx) => {
                const k = `weekly_prep_${idx}`;
                const checked = !!prepStepChecked[k];
                return (
                  <TouchableOpacity
                    key={k}
                    style={[styles.checkRow, { borderColor: theme.border }]}
                    onPress={() => togglePrepStep(idx)}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={checked ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={checked ? SAGE : theme.text}
                    />
                    <Text
                      style={[
                        styles.checkRowText,
                        styles.prepStepText,
                        { color: theme.text },
                        checked && styles.checkRowTextDone,
                      ]}
                    >
                      {step}
                    </Text>
                  </TouchableOpacity>
                );
              })
            )}
          </>
        ) : null}
      </View>

      {actionButtons}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]}>Meal plans</Text>
      </View>
      <FlatList
        data={plans}
        keyExtractor={(item) => String(item.meal_plan_id)}
        renderItem={({ item }) => {
          let swipeableRef: Swipeable | null = null;
          return (
            <Swipeable
              ref={(r) => { swipeableRef = r; }}
              renderRightActions={() => renderRightActions(item, () => swipeableRef?.close())}
              friction={2}
            >
              <TouchableOpacity
                style={[styles.row, { backgroundColor: theme.card, borderColor: theme.border }]}
                onPress={() => navigation.navigate('MealPlanDetail', { meal_plan_id: item.meal_plan_id, name: item.name })}
                onLongPress={() => {
                  setRenamingPlan(item);
                  setRenameText(item.name);
                }}
              >
                <View style={styles.rowLeft}>
                  <Text style={[styles.rowText, { color: theme.text }]}>{item.name}</Text>
                  {activePlanIdsInWeek.has(item.meal_plan_id) && (
                    <View style={[styles.activeBadge, { backgroundColor: SAGE }]}>
                      <Text style={styles.activeBadgeText}>Active</Text>
                    </View>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={20} color={theme.text} />
              </TouchableOpacity>
            </Swipeable>
          );
        }}
        ListEmptyComponent={emptyComponent}
        ListFooterComponent={listFooter}
      />
      <Modal
        visible={groceryModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => !regeneratingWeekly && setGroceryModalVisible(false)}
      >
        <View style={styles.groceryModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => !regeneratingWeekly && setGroceryModalVisible(false)}
          />
          <View
            style={[
              styles.groceryModalSheet,
              {
                paddingBottom: Math.max(insets.bottom, 20) + 8,
                backgroundColor: CREAM_MODAL_BG,
                borderColor: SAGE,
              },
            ]}
          >
            <View style={styles.groceryModalHeaderRow}>
              <Text style={styles.groceryModalTitle}>Generate grocery list</Text>
              <TouchableOpacity
                onPress={() => !regeneratingWeekly && setGroceryModalVisible(false)}
                hitSlop={12}
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={26} color="#333" />
              </TouchableOpacity>
            </View>
            <Text style={styles.groceryModalHint}>
              Choose a source. Meal plan updates your saved lists and meal prep; family view is for shopping only.
            </Text>

            {(
              [
                { mode: 'mealPlan' as const, title: 'My Meal Plan', sub: 'From active meal plan templates (saved to each plan + prep guide).' },
                { mode: 'family' as const, title: 'Family Size', sub: 'Scale template servings for multiple people (shopping list only).' },
              ] as const
            ).map((opt) => {
              const selected = groceryModalMode === opt.mode;
              return (
                <TouchableOpacity
                  key={opt.mode}
                  style={[
                    styles.groceryModalOption,
                    {
                      borderColor: selected ? SAGE : 'rgba(124, 154, 126, 0.35)',
                      backgroundColor: selected ? SAGE : 'rgba(255, 252, 247, 0.95)',
                    },
                  ]}
                  onPress={() => setGroceryModalMode(opt.mode)}
                  activeOpacity={0.85}
                >
                  <Text
                    style={[
                      styles.groceryModalOptionTitle,
                      { color: selected ? '#fff' : '#2c2c2c' },
                    ]}
                  >
                    {opt.title}
                  </Text>
                  <Text
                    style={[
                      styles.groceryModalOptionSub,
                      { color: selected ? 'rgba(255,255,255,0.92)' : '#555' },
                    ]}
                  >
                    {opt.sub}
                  </Text>
                </TouchableOpacity>
              );
            })}

            {groceryModalMode === 'family' ? (
              <View style={styles.groceryModalStepperRow}>
                <Text style={styles.groceryModalStepperLabel}>People</Text>
                <View style={styles.groceryModalStepper}>
                  <TouchableOpacity
                    style={[styles.groceryModalStepperBtn, { borderColor: SAGE }]}
                    onPress={() => setFamilySize((n) => Math.max(1, n - 1))}
                    disabled={familySize <= 1}
                  >
                    <Ionicons name="remove" size={22} color={familySize <= 1 ? '#ccc' : SAGE} />
                  </TouchableOpacity>
                  <Text style={styles.groceryModalStepperValue}>{familySize}</Text>
                  <TouchableOpacity
                    style={[styles.groceryModalStepperBtn, { borderColor: SAGE }]}
                    onPress={() => setFamilySize((n) => Math.min(8, n + 1))}
                    disabled={familySize >= 8}
                  >
                    <Ionicons name="add" size={22} color={familySize >= 8 ? '#ccc' : SAGE} />
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.groceryModalPrimaryBtn, { backgroundColor: SAGE, opacity: regeneratingWeekly ? 0.7 : 1 }]}
              onPress={confirmGroceryModal}
              disabled={regeneratingWeekly}
            >
              {regeneratingWeekly ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.groceryModalPrimaryBtnText}>Generate</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={copyScheduleModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => !copying && setCopyScheduleModalVisible(false)}
      >
        <View style={styles.groceryModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => !copying && setCopyScheduleModalVisible(false)}
          />
          <View
            style={[
              styles.groceryModalSheet,
              {
                paddingBottom: Math.max(insets.bottom, 20) + 8,
                backgroundColor: CREAM_MODAL_BG,
                borderColor: SAGE,
                maxHeight: '75%',
              },
            ]}
          >
            <View style={styles.groceryModalHeaderRow}>
              <Text style={styles.groceryModalTitle}>Copy schedule to this week</Text>
              <TouchableOpacity
                onPress={() => !copying && setCopyScheduleModalVisible(false)}
                hitSlop={12}
                accessibilityLabel="Close"
              >
                <Ionicons name="close" size={26} color="#333" />
              </TouchableOpacity>
            </View>
            <Text style={styles.groceryModalHint}>
              Choose a past week that had meal plans set as active. Those plans will show for this week here
              so you can open each one and tap Set as Active — the nutrition tracker stays empty until you do.
            </Text>
            {loadingCopyWeekOptions ? (
              <ActivityIndicator size="large" color={SAGE} style={{ marginVertical: 28 }} />
            ) : copying ? (
              <ActivityIndicator size="large" color={SAGE} style={{ marginVertical: 28 }} />
            ) : copyWeekOptions.length === 0 ? (
              <Text style={[styles.copyScheduleEmptyText, { color: '#555' }]}>
                No meal plan activity in the last four weeks.
              </Text>
            ) : (
              <ScrollView
                style={styles.copyScheduleScroll}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {copyWeekOptions.map((opt) => (
                  <TouchableOpacity
                    key={opt.weekStartYmd}
                    style={[styles.copyScheduleRow, { borderColor: 'rgba(124, 154, 126, 0.45)' }]}
                    onPress={() => void copyDayActivePlanFromWeekToCurrent(opt.weekStartYmd, opt.weekEndYmd)}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.copyScheduleRowText}>{opt.label}</Text>
                    <Ionicons name="chevron-forward" size={20} color="#333" />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity
              style={[styles.copyScheduleCancelBtn, { borderColor: theme.border }]}
              onPress={() => !copying && setCopyScheduleModalVisible(false)}
              disabled={copying}
            >
              <Text style={[styles.copyScheduleCancelText, { color: theme.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {renamingPlan && (
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View style={styles.renameOverlay}>
            <View style={[styles.renameBox, { backgroundColor: theme.card }]}>
            <Text style={[styles.renameTitle, { color: theme.text }]}>Rename meal plan</Text>
            <TextInput
              style={[styles.renameInput, { color: theme.text, borderColor: theme.border }]}
              value={renameText}
              onChangeText={setRenameText}
              placeholder="Meal plan name"
              placeholderTextColor={theme.border}
              autoFocus
            />
            <View style={styles.renameButtonsRow}>
              <TouchableOpacity
                style={[styles.renameButton, { borderColor: theme.border }]}
                onPress={() => {
                  setRenamingPlan(null);
                  setRenameText('');
                }}
              >
                <Text style={{ color: theme.text }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.renameButton, { borderColor: SAGE }]}
                onPress={async () => {
                  const trimmed = renameText.trim();
                  if (!trimmed) {
                    Alert.alert('Name required', 'Please enter a meal plan name.');
                    return;
                  }
                  try {
                    await db.runAsync(
                      'UPDATE MealPlans SET plan_name = ? WHERE meal_plan_id = ?',
                      [trimmed, renamingPlan.meal_plan_id]
                    );
                    setPlans((prev) =>
                      prev.map((p) =>
                        p.meal_plan_id === renamingPlan.meal_plan_id ? { ...p, name: trimmed } : p
                      )
                    );
                  } catch (e) {
                    console.error('rename meal plan error:', e);
                    Alert.alert('Error', 'Could not rename meal plan.');
                  } finally {
                    setRenamingPlan(null);
                    setRenameText('');
                  }
                }}
              >
                <Text style={{ color: SAGE, fontWeight: '600' }}>Save</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              style={[styles.renameDeleteButton]}
              onPress={() => {
                const target = renamingPlan;
                setRenamingPlan(null);
                setRenameText('');
                if (target) {
                  confirmDelete(target);
                }
              }}
            >
              <Text style={styles.renameDeleteText}>Delete meal plan</Text>
            </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 12, borderWidth: 1, marginBottom: 10 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  rowText: { fontSize: 16, flex: 1 },
  activeBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  activeBadgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  deleteButton: { backgroundColor: '#C0392B', justifyContent: 'center', alignItems: 'center', width: 80, marginBottom: 10, borderRadius: 12 },
  deleteButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  empty: { textAlign: 'center', marginTop: 24, opacity: 0.8 },
  emptyWrap: { paddingHorizontal: 8, paddingTop: 24, alignItems: 'center', gap: 12 },
  actionButtonsWrap: { paddingHorizontal: 8, paddingTop: 24, paddingBottom: 16, alignItems: 'center', gap: 12 },
  emptyBtn: { paddingVertical: 14, paddingHorizontal: 24, borderRadius: 12, borderWidth: 1, minWidth: 200, alignItems: 'center' },
  emptyBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  renameOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-start',
    paddingTop: 80,
    alignItems: 'center',
  },
  renameBox: {
    width: '85%',
    borderRadius: 12,
    padding: 16,
  },
  renameTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  renameInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  renameButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    columnGap: 12,
  },
  renameButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  renameDeleteButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  renameDeleteText: {
    color: '#C0392B',
    fontWeight: '600',
  },
  footerWrap: { paddingHorizontal: 0, paddingBottom: 32 },
  weeklyActionCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginTop: 16,
  },
  weeklyActionHint: { fontSize: 14, lineHeight: 20, marginBottom: 12 },
  refreshWeeklyBtn: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  refreshWeeklyBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  refreshWeeklyBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  instacartBtn: { marginTop: 16, alignSelf: 'stretch' },
  sectionCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginTop: 16,
  },
  collapseHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  collapseHeaderTap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 28,
  },
  collapseHeaderTitle: { fontSize: 18, fontWeight: '700', flex: 1 },
  shareIconBtn: { padding: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 6 },
  sectionSub: { fontSize: 13, marginBottom: 12, opacity: 0.85 },
  sectionHint: { fontSize: 14, fontStyle: 'italic', marginTop: 4 },
  categoryBlock: { marginBottom: 12 },
  categoryTitle: { fontSize: 15, fontWeight: '700', marginBottom: 8, marginTop: 4 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  checkRowText: { flex: 1, fontSize: 15, lineHeight: 22 },
  checkRowTextDone: { textDecorationLine: 'line-through', opacity: 0.55 },
  prepStepText: { fontSize: 14 },
  groceryModalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  groceryModalSheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 18,
    maxHeight: '88%',
  },
  groceryModalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  groceryModalTitle: {
    fontFamily: 'CormorantGaramond-Bold',
    fontSize: 26,
    color: '#2a2a2a',
    flex: 1,
    paddingRight: 8,
  },
  groceryModalHint: {
    fontFamily: 'Jost_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: '#444',
    marginBottom: 16,
  },
  groceryModalOption: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  groceryModalOptionTitle: {
    fontFamily: 'Jost_400Regular',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  groceryModalOptionSub: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    lineHeight: 18,
  },
  groceryModalStepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  groceryModalStepperLabel: {
    fontFamily: 'Jost_400Regular',
    fontSize: 16,
    color: '#333',
  },
  groceryModalStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  groceryModalStepperBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 252, 247, 0.95)',
  },
  groceryModalStepperValue: {
    fontFamily: 'Jost_400Regular',
    fontSize: 20,
    fontWeight: '600',
    minWidth: 28,
    textAlign: 'center',
    color: '#222',
  },
  groceryModalPrimaryBtn: {
    marginTop: 8,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  groceryModalPrimaryBtnText: {
    fontFamily: 'Jost_400Regular',
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
  },
  copyScheduleScroll: { maxHeight: 280, marginBottom: 8 },
  copyScheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    backgroundColor: 'rgba(255, 252, 247, 0.95)',
  },
  copyScheduleRowText: {
    fontFamily: 'Jost_400Regular',
    fontSize: 16,
    fontWeight: '600',
    color: '#2c2c2c',
    flex: 1,
    paddingRight: 8,
  },
  copyScheduleEmptyText: {
    fontFamily: 'Jost_400Regular',
    fontSize: 15,
    lineHeight: 22,
    marginVertical: 20,
    textAlign: 'center',
  },
  copyScheduleCancelBtn: {
    marginTop: 4,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    backgroundColor: 'rgba(255, 252, 247, 0.95)',
  },
  copyScheduleCancelText: { fontFamily: 'Jost_400Regular', fontSize: 16, fontWeight: '600' },
});
