/**
 * Meal plan detail: name, Schedule section (day chips + quick options), Set as Active.
 */
import React, { useState, useEffect, useCallback } from 'react';
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
      const cat = (entry.category || 'Other').trim();
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(text);
    }
    const lines: string[] = [];
    const order = ['Produce', 'Protein', 'Dairy', 'Pantry', 'Other'];
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

/** Map categorizeFood result to grocery list category labels. */
function groceryCategoryFromFood(foodName: string): string {
  const kind = categorizeFood(foodName);
  const map: Record<string, string> = { grain: 'Pantry', protein: 'Protein', produce: 'Produce', dairy: 'Dairy', other: 'Other' };
  return map[kind] ?? 'Other';
}

/** Generate grocery list from plan's PlannedMeals + FoodItems (or MealPlanItems fallback) and save to DB. */
async function generateGroceryListFromPlan(
  db: { getAllAsync: (sql: string, params?: any[]) => Promise<any[]>; runAsync: (sql: string, params?: any[]) => Promise<void> },
  planId: number
): Promise<void> {
  let rows: { meal_type: string; food_name: string; brand?: string | null; serving_size?: string | null }[] = await db.getAllAsync(
    `SELECT pm.meal_type, fi.food_name, fi.brand, fi.serving_size
     FROM PlannedMeals pm
     JOIN FoodItems fi ON fi.meal_id = pm.meal_id
     WHERE pm.meal_plan_id = ?
     ORDER BY pm.meal_order, fi.food_id`,
    [planId]
  ).catch(() => []);
  if (rows.length === 0) {
    const fallback = await db.getAllAsync<{ meal_type: string | null; food_name: string }>(
      'SELECT meal_type, food_name FROM MealPlanItems WHERE meal_plan_id = ? ORDER BY sort_order, item_id',
      [planId]
    ).catch(() => []);
    rows = fallback.map((r) => ({ meal_type: r.meal_type || 'Other', food_name: r.food_name }));
  }
  const seen = new Set<string>();
  const byCategory: Record<string, string[]> = { Produce: [], Protein: [], Dairy: [], Pantry: [], Other: [] };
  for (const r of rows) {
    const item = r.food_name + (r.serving_size ? ` — ${r.serving_size}` : '');
    if (seen.has(item)) continue;
    seen.add(item);
    const cat = groceryCategoryFromFood(r.food_name);
    if (byCategory[cat]) byCategory[cat].push(item);
    else byCategory['Other'].push(item);
  }
  const list: { category: string; item: string; checked: boolean }[] = [];
  for (const cat of ['Produce', 'Protein', 'Dairy', 'Pantry', 'Other']) {
    for (const item of byCategory[cat]) list.push({ category: cat, item, checked: false });
  }
  await db.runAsync('UPDATE MealPlans SET grocery_list = ? WHERE meal_plan_id = ?', [JSON.stringify(list), planId]);
}

const GRAIN_WORDS = /rice|pasta|quinoa|oats?|bread|noodle|couscous|barley|bulgur|farro|potato|sweet potato/i;
const PROTEIN_WORDS = /chicken|beef|pork|fish|salmon|tuna|turkey|egg|tofu|tempeh|beans?|lentil|shrimp/i;
const PRODUCE_WORDS = /broccoli|spinach|kale|lettuce|tomato|carrot|onion|pepper|apple|banana|berry|berries|orange|avocado|celery|cucumber|zucchini|squash|green bean|pea|fruit|vegetable|salad/i;
const DAIRY_WORDS = /milk|yogurt|cheese|cottage cheese|cream/i;

function categorizeFood(name: string): 'grain' | 'protein' | 'produce' | 'dairy' | 'other' {
  const n = name.toLowerCase();
  if (GRAIN_WORDS.test(n)) return 'grain';
  if (PROTEIN_WORDS.test(n)) return 'protein';
  if (PRODUCE_WORDS.test(n)) return 'produce';
  if (DAIRY_WORDS.test(n)) return 'dairy';
  return 'other';
}

/** Generate step-by-step meal prep guide from plan's meals and foods (or MealPlanItems fallback) and save to DB. */
async function generatePrepGuideFromPlan(
  db: { getAllAsync: (sql: string, params?: any[]) => Promise<any[]>; runAsync: (sql: string, params?: any[]) => Promise<void> },
  planId: number
): Promise<void> {
  let rows: { meal_type: string; food_name: string }[] = await db.getAllAsync(
    `SELECT pm.meal_type, fi.food_name
     FROM PlannedMeals pm
     JOIN FoodItems fi ON fi.meal_id = pm.meal_id
     WHERE pm.meal_plan_id = ?
     ORDER BY pm.meal_order, fi.food_id`,
    [planId]
  ).catch(() => []);
  if (rows.length === 0) {
    rows = await db.getAllAsync<{ meal_type: string | null; food_name: string }>(
      'SELECT meal_type, food_name FROM MealPlanItems WHERE meal_plan_id = ? ORDER BY sort_order, item_id',
      [planId]
    ).catch(() => []);
    rows = rows.map((r) => ({ meal_type: r.meal_type || 'Meal', food_name: r.food_name }));
  }
  const uniqueFoods = [...new Set(rows.map((r) => r.food_name.trim()))].filter(Boolean);
  const byCategory: Record<string, string[]> = { grain: [], protein: [], produce: [], dairy: [], other: [] };
  for (const name of uniqueFoods) {
    const cat = categorizeFood(name);
    byCategory[cat].push(name);
  }
  const steps: string[][] = [];
  if (byCategory.grain.length > 0) {
    steps.push([
      'Cook grains & starches',
      `Cook in bulk for the week: ${byCategory.grain.join(', ')}. Let cool, then store in the fridge in airtight containers.`,
    ]);
  }
  if (byCategory.protein.length > 0) {
    steps.push([
      'Cook & portion proteins',
      `Prep and cook: ${byCategory.protein.join(', ')}. Portion into containers for each meal so you can grab and go.`,
    ]);
  }
  if (byCategory.produce.length > 0) {
    steps.push([
      'Wash and chop produce',
      `Wash, dry, and chop: ${byCategory.produce.join(', ')}. Store in containers or bags. Pre-portion for snacks if needed.`,
    ]);
  }
  if (byCategory.dairy.length > 0) {
    steps.push([
      'Portion dairy',
      `Portion out ${byCategory.dairy.join(', ')} into single-serving containers or add to meal containers as needed.`,
    ]);
  }
  steps.push([
    'Portion snacks and breakfast items',
    'Portion out any grab-and-go snacks. Prep overnight oats, egg muffins, or other breakfast items so mornings are easy.',
  ]);
  steps.push([
    'Assemble and store',
    "Label containers by day or meal (e.g. Mon Lunch, Tue Dinner). Keep in the fridge; freeze any portions you won't use within 3–4 days.",
  ]);
  const lines: string[] = ['Meal prep for the week — follow these steps in order.', ''];
  steps.forEach(([title, body], i) => {
    lines.push(`${i + 1}. ${title}`);
    lines.push(`   ${body}`);
    lines.push('');
  });
  if (uniqueFoods.length > 0) {
    lines.push('Your plan includes: ' + uniqueFoods.slice(0, 12).join(', ') + (uniqueFoods.length > 12 ? '...' : '.'));
  }
  const text = lines.join('\n').trim();
  await db.runAsync('UPDATE MealPlans SET prep_guide = ? WHERE meal_plan_id = ?', [text || null, planId]);
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

  const loadPlanDetails = useCallback(async () => {
    if (!meal_plan_id) return;
    try {
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
  };

  const setManualOnly = async () => {
    const planId = meal_plan_id;
    if (!planId) return;
    setScheduledDays(new Set());
    await db.runAsync('DELETE FROM MealPlanSchedule WHERE meal_plan_id = ?', [planId]);
    await db.runAsync("UPDATE MealPlans SET schedule_type = 'manual' WHERE meal_plan_id = ?", [planId]);
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

              // Step 7: Add this plan to DayActivePlan for today (multiple plans can be active)
              await initMealPlansDb(db);
              await db.runAsync('INSERT OR IGNORE INTO DayActivePlan (date, meal_plan_id) VALUES (?, ?)', [today, plan.meal_plan_id]);
              console.log('[SetAsActive] Step 7: DayActivePlan added for today; other active plans unchanged');

              // Step 8: Navigate back to meal plan list
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
        <Text style={[styles.planName, { color: theme.text }]}>{name}</Text>
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
        <TouchableOpacity style={styles.collapseHeader} onPress={() => setGroceryExpanded((e) => !e)} activeOpacity={0.7}>
          <Text style={[styles.sectionTitleCollapse, { color: theme.text }]}>Grocery list</Text>
          <Ionicons name={groceryExpanded ? 'chevron-up' : 'chevron-down'} size={22} color={theme.text} />
        </TouchableOpacity>
        {groceryExpanded && (
          <>
            {(() => {
              const cleanList = formatGroceryListForDisplay(groceryList);
              const groceryLines = cleanList ? cleanList.split(/\n/).filter(Boolean) : [];
              return groceryLines.length > 0 ? (
                <View style={styles.groceryListBlock}>
                  {groceryLines.map((line, idx) => {
                    const isHeader = line.endsWith(':');
                    if (isHeader) {
                      return (
                        <Text key={idx} style={[styles.groceryLine, { color: theme.text }, styles.groceryCategory, idx > 0 && { marginTop: 12 }]}>
                          {line}
                        </Text>
                      );
                    }
                    return (
                      <TouchableOpacity
                        key={idx}
                        style={styles.prepLine}
                        onPress={() => setGroceryChecked((prev) => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; })}
                        activeOpacity={0.7}
                      >
                        <Ionicons name={groceryChecked.has(idx) ? 'checkbox' : 'ellipse-outline'} size={22} color={theme.text} style={{ marginRight: 10 }} />
                        <Text style={[styles.prepLineText, { color: theme.text }, groceryChecked.has(idx) && styles.prepLineDone]}>
                          {line}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : (
                <Text style={[styles.emptyHint, { color: theme.textSecondary }]}>No grocery list yet. Tap Generate to create one from this plan's meals.</Text>
              );
            })()}
            <View style={styles.sectionActions}>
              {formatGroceryListForDisplay(groceryList) ? (
                <TouchableOpacity style={[styles.iconBtn, { backgroundColor: theme.background, borderColor: theme.border }]} onPress={async () => {
                  const cleanList = formatGroceryListForDisplay(groceryList);
                  if (cleanList) {
                    try { await Share.share({ message: cleanList, title: `${name} – Grocery list` }); } catch (_) {}
                  }
                }}>
                  <Ionicons name="share-outline" size={20} color={theme.text} />
                  <Text style={[styles.iconBtnText, { color: theme.text }]}>Share list</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.iconBtn, { backgroundColor: theme.background, borderColor: theme.border }]}
                onPress={async () => {
                  if (!meal_plan_id) return;
                  try {
                    await generateGroceryListFromPlan(db, meal_plan_id);
                    await loadPlanDetails();
                  } catch (e) {
                    Alert.alert('Error', e instanceof Error ? e.message : 'Could not generate grocery list.');
                  }
                }}
              >
                <Ionicons name={formatGroceryListForDisplay(groceryList) ? 'refresh-outline' : 'add-circle-outline'} size={20} color={theme.text} />
                <Text style={[styles.iconBtnText, { color: theme.text }]}>{formatGroceryListForDisplay(groceryList) ? 'Regenerate' : 'Generate'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <TouchableOpacity style={styles.collapseHeader} onPress={() => setPrepExpanded((e) => !e)} activeOpacity={0.7}>
          <Text style={[styles.sectionTitleCollapse, { color: theme.text }]}>Prep guide</Text>
          <Ionicons name={prepExpanded ? 'chevron-up' : 'chevron-down'} size={22} color={theme.text} />
        </TouchableOpacity>
        {prepExpanded && (
          <>
            {prepGuide && prepGuide.trim() ? (
              <View>
                {(prepGuide.trim().split(/\r?\n/).filter(Boolean).map((line, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={styles.prepLine}
                    onPress={() => setPrepChecked((prev) => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; })}
                    activeOpacity={0.7}
                  >
                    <Ionicons name={prepChecked.has(idx) ? 'checkbox' : 'ellipse-outline'} size={22} color={theme.text} style={{ marginRight: 10 }} />
                    <Text style={[styles.prepLineText, { color: theme.text }, prepChecked.has(idx) && styles.prepLineDone]}>{line}</Text>
                  </TouchableOpacity>
                )))}
              </View>
            ) : (
              <Text style={[styles.emptyHint, { color: theme.textSecondary }]}>No prep guide yet. Tap Generate to create one.</Text>
            )}
            <View style={styles.sectionActions}>
              {prepGuide && prepGuide.trim() ? (
                <TouchableOpacity
                  style={[styles.iconBtn, { backgroundColor: theme.background, borderColor: theme.border }]}
                  onPress={async () => {
                    try { await Share.share({ message: prepGuide.trim(), title: `${name} – Prep guide` }); } catch (_) {}
                  }}
                >
                  <Ionicons name="share-outline" size={20} color={theme.text} />
                  <Text style={[styles.iconBtnText, { color: theme.text }]}>Share</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.iconBtn, { backgroundColor: theme.background, borderColor: theme.border }]}
                onPress={async () => {
                  if (!meal_plan_id) return;
                  try {
                    await generatePrepGuideFromPlan(db, meal_plan_id);
                    await loadPlanDetails();
                  } catch (e) {
                    Alert.alert('Error', e instanceof Error ? e.message : 'Could not generate prep guide.');
                  }
                }}
              >
                <Ionicons name={prepGuide && prepGuide.trim() ? 'refresh-outline' : 'add-circle-outline'} size={20} color={theme.text} />
                <Text style={[styles.iconBtnText, { color: theme.text }]}>{prepGuide && prepGuide.trim() ? 'Regenerate' : 'Generate'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  backBtn: { marginRight: 12 },
  planName: { fontSize: 22, fontWeight: '700', flex: 1 },
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
  setActiveBtn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginBottom: 28 },
  setActiveBtnText: { color: '#fff', fontWeight: '700' },
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
