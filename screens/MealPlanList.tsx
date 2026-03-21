/**
 * List of meal plans for a given week; tap to open detail. Swipe left to delete.
 * When empty: message only; Build with Sage / Build it myself / Copy from previous week sit below Weekly meal prep in the footer.
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
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { initMealPlansDb } from '../utils/initMealPlansDb';
import { initNutritionDb } from '../utils/nutritionDb';
import {
  buildPrepGuideTextFromUniqueFoodNames,
  generateGroceryListFromPlan,
  generatePrepGuideFromPlan,
} from '../utils/generateMealPlanGroceryAndPrep';

const SAGE = '#7C9A7E';

type PlanRow = { meal_plan_id: number; name: string };

function prevWeekMonday(weekStartIso: string): string {
  const d = new Date(weekStartIso + 'T12:00:00');
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
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

export type MealPlanListProps = { weekStart: string; currentWeekStart: string };

export default function MealPlanList({ weekStart, currentWeekStart }: MealPlanListProps) {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const navigation = useNavigation<any>();
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
  const [grocerySectionExpanded, setGrocerySectionExpanded] = useState(false);
  const [prepSectionExpanded, setPrepSectionExpanded] = useState(false);
  const [renamingPlan, setRenamingPlan] = useState<PlanRow | null>(null);
  const [renameText, setRenameText] = useState('');

  const activePlanIdsSignature = useMemo(
    () => [...activePlanIdsInWeek].sort((a, b) => a - b).join(','),
    [activePlanIdsInWeek],
  );

  useEffect(() => {
    setGroceryChecked(new Set());
    setPrepStepChecked({});
  }, [weekStart, activePlanIdsSignature]);

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

  const loadPlans = useCallback(async () => {
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
      setMergedGrocery([]);
      setCombinedPrepGuideText('');
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

      const seenGrocery = new Set<string>();
      const items: MergedGroceryRow[] = [];
      for (const p of planRows) {
        const raw = p.grocery_list;
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) continue;
          for (const entry of parsed) {
            const text = String(entry?.item ?? entry?.text ?? '').trim();
            if (!text) continue;
            const category = normalizeGroceryCategory(entry?.category);
            const key = `${category}|${text.toLowerCase()}`;
            if (seenGrocery.has(key)) continue;
            seenGrocery.add(key);
            items.push({ key, text, category });
          }
        } catch {
          /* ignore malformed grocery JSON */
        }
      }
      items.sort((a, b) => {
        const ca = GROCERY_CATS.indexOf(a.category);
        const cb = GROCERY_CATS.indexOf(b.category);
        if (ca !== cb) return ca - cb;
        return a.text.localeCompare(b.text);
      });
      setMergedGrocery(items);

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
  }, [db, weekStart, currentWeekStart]);

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
      await loadPlans();
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

  const copyFromPreviousWeek = async () => {
    const prevWeek = prevWeekMonday(weekStart);
    setCopying(true);
    try {
      const prevPlans = await db.getAllAsync<{
        meal_plan_id: number;
        plan_name: string;
        calories_target: number | null;
        protein_target: number | null;
        carbs_target: number | null;
        fat_target: number | null;
      }>(
        'SELECT meal_plan_id, plan_name, calories_target, protein_target, carbs_target, fat_target FROM MealPlans WHERE week_start = ?',
        [prevWeek]
      );
      for (const p of prevPlans) {
        await db.runAsync(
          `INSERT INTO MealPlans (plan_name, calories_target, protein_target, carbs_target, fat_target, week_start, created_date) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [p.plan_name + ' (copy)', p.calories_target, p.protein_target, p.carbs_target, p.fat_target, weekStart, new Date().toISOString()]
        );
        const newIdRow = await db.getFirstAsync<{ id: number }>('SELECT last_insert_rowid() as id');
        const newPlanId = newIdRow?.id;
        if (!newPlanId) continue;
        const meals = await db.getAllAsync<{ meal_id: number; meal_name: string | null; meal_type: string | null; meal_order: number | null }>(
          'SELECT meal_id, meal_name, meal_type, meal_order FROM PlannedMeals WHERE meal_plan_id = ?',
          [p.meal_plan_id]
        );
        for (const m of meals) {
          await db.runAsync(
            'INSERT INTO PlannedMeals (meal_plan_id, meal_name, meal_type, meal_order) VALUES (?, ?, ?, ?)',
            [newPlanId, m.meal_name, m.meal_type, m.meal_order ?? 0]
          );
          const newMealRow = await db.getFirstAsync<{ id: number }>('SELECT last_insert_rowid() as id');
          const newMealId = newMealRow?.id;
          if (!newMealId) continue;
          const foods = await db.getAllAsync<{ food_name: string; brand: string | null; serving_size: string | null; calories: number; protein: number; carbs: number; fat: number }>(
            'SELECT food_name, brand, serving_size, calories, protein, carbs, fat FROM FoodItems WHERE meal_id = ?',
            [m.meal_id]
          );
          for (const f of foods) {
            await db.runAsync(
              'INSERT INTO FoodItems (meal_id, food_name, brand, serving_size, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [newMealId, f.food_name, f.brand, f.serving_size, f.calories, f.protein, f.carbs, f.fat]
            );
          }
        }
      }
      await loadPlans();
    } catch (e) {
      console.error('copyFromPreviousWeek error:', e);
    } finally {
      setCopying(false);
    }
  };

  const actionButtons = (
    <View style={styles.actionButtonsWrap}>
      <TouchableOpacity style={[styles.emptyBtn, { backgroundColor: SAGE }]} onPress={buildWithSage}>
        <Text style={styles.emptyBtnText}>Build with Sage</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.emptyBtn, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={buildMyself}>
        <Text style={[styles.emptyBtnText, { color: theme.text }]}>Build it myself</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.emptyBtn, { backgroundColor: theme.card, borderColor: theme.border }]}
        onPress={copyFromPreviousWeek}
        disabled={copying}
      >
        {copying ? (
          <ActivityIndicator size="small" color={theme.text} />
        ) : (
          <Text style={[styles.emptyBtnText, { color: theme.text }]}>Copy from previous week</Text>
        )}
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
            Grocery and prep are created from the foods in each <Text style={{ fontWeight: '700' }}>active</Text> plan.
            Tap after you add or change meals.
          </Text>
          <TouchableOpacity
            style={[styles.refreshWeeklyBtn, { backgroundColor: SAGE }]}
            onPress={regenerateWeeklyForActivePlans}
            disabled={regeneratingWeekly}
            activeOpacity={0.85}
          >
            {regeneratingWeekly ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <View style={styles.refreshWeeklyBtnInner}>
                <Ionicons name="refresh" size={20} color="#fff" />
                <Text style={styles.refreshWeeklyBtnText}>
                  {mergedGrocery.length === 0 && !combinedPrepGuideText.trim()
                    ? 'Generate grocery list & meal prep'
                    : 'Refresh grocery list & meal prep'}
                </Text>
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
              Merged from all meal plans active this week ({weekStart} – {sundayOfWeekIso(weekStart)}). Tap
              share to send to Notes, Messages, etc.
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
              GROCERY_CATS.map((cat) => {
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
              })
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
});
