/**
 * List of meal plans for a given week; tap to open detail. Swipe left to delete.
 * When empty: Build with Sage, Build it myself, Copy from previous week.
 */
import React, { useState, useCallback } from 'react';
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
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import { initMealPlansDb } from '../utils/initMealPlansDb';

const SAGE = '#7C9A7E';

type PlanRow = { meal_plan_id: number; name: string };

function prevWeekMonday(weekStartIso: string): string {
  const d = new Date(weekStartIso + 'T12:00:00');
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

export type MealPlanListProps = { weekStart: string; currentWeekStart: string };

export default function MealPlanList({ weekStart, currentWeekStart }: MealPlanListProps) {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const navigation = useNavigation<any>();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [copying, setCopying] = useState(false);
  const [activePlanIdsToday, setActivePlanIdsToday] = useState<Set<number>>(new Set());
  const [renamingPlan, setRenamingPlan] = useState<PlanRow | null>(null);
  const [renameText, setRenameText] = useState('');

  const loadPlans = useCallback(async () => {
    await initMealPlansDb(db);
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
    const today = new Date().toISOString().slice(0, 10);
    const activeRows = await db.getAllAsync<{ meal_plan_id: number }>(
      'SELECT meal_plan_id FROM DayActivePlan WHERE date = ?',
      [today]
    ).catch(() => []);
    setActivePlanIdsToday(new Set(activeRows.map((r) => r.meal_plan_id)));
  }, [db, weekStart]);

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
                  {activePlanIdsToday.has(item.meal_plan_id) && (
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
        ListFooterComponent={plans.length > 0 ? actionButtons : null}
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
});
