/**
 * MyProgress: MyBody and MyStrength tabs.
 * MyBody: 2x3 stat cards, starting weight comparison, Log Today modal, line chart (Weight|Muscle|Fat|Water, 30/90/365).
 * MyStrength: exercise list from Weight_Log + StrengthRecords, detail with chart and Log MyStrength PR.
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  TextInput,
  FlatList,
  useWindowDimensions,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { useTheme } from '../context/ThemeContext';
import { LineChart } from 'react-native-chart-kit';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SAGE = '#7C9A7E';
const CREAM = '#FDF8F0';

const USER_HEIGHT_KEY = '@user_height_inches';
const USER_STARTING_WEIGHT_KEY = '@user_starting_weight';
const USER_STARTING_DATE_KEY = '@user_starting_date';

type BodyMetricRow = {
  metric_id: number;
  log_date: string;
  weight: number | null;
  muscle_mass: number | null;
  bone_mass: number | null;
  body_water: number | null;
  body_fat: number | null;
  bmi: number | null;
  notes: string | null;
};

type StrengthRecordRow = {
  record_id: number;
  exercise_name: string;
  log_date: string;
  weight: number | null;
  reps: number | null;
  sets: number | null;
  one_rep_max: number | null;
};

type WeightLogRow = {
  exercise_name: string;
  weight_logged: number;
  reps_logged: number;
  workout_date: number;
};

function calc1RM(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

function formatDateYMD(dateStr: string): string {
  const d = dateStr.split('T')[0];
  if (!d) return dateStr;
  const [m, day] = d.split('-').slice(1);
  return m && day ? `${Number(m)}/${Number(day)}` : d;
}

const chartConfig = (labelColor: string) => ({
  backgroundColor: 'transparent',
  backgroundGradientFrom: 'transparent',
  backgroundGradientTo: 'transparent',
  decimalPlaces: 1,
  color: () => SAGE,
  labelColor: () => labelColor,
  style: { paddingRight: 0 },
  propsForLabels: { fontFamily: 'Jost_400Regular' },
});

export default function MyProgress() {
  const db = useSQLiteContext();
  const { theme } = useTheme();
  const { width } = useWindowDimensions();
  const chartWidth = Math.max(width - 48, 280);

  const [activeTab, setActiveTab] = useState<'body' | 'strength'>('body');
  const [latestBody, setLatestBody] = useState<BodyMetricRow | null>(null);
  const [bodyHistory, setBodyHistory] = useState<BodyMetricRow[]>([]);
  const [bodyLoading, setBodyLoading] = useState(true);
  const [bodySeries, setBodySeries] = useState<'weight' | 'muscle' | 'fat' | 'water'>('weight');
  const [bodyRange, setBodyRange] = useState<30 | 90 | 365>(30);

  const [startingWeight, setStartingWeight] = useState<string>('');
  const [startingDate, setStartingDate] = useState<string>('');

  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logWeight, setLogWeight] = useState('');
  const [logMuscle, setLogMuscle] = useState('');
  const [logBone, setLogBone] = useState('');
  const [logWater, setLogWater] = useState('');
  const [logFat, setLogFat] = useState('');
  const [logNotes, setLogNotes] = useState('');
  const [userHeightInches, setUserHeightInches] = useState<string>('');

  const [strengthExercises, setStrengthExercises] = useState<
    { exercise_name: string; bestWeight: number; bestReps: number; oneRM: number; isPR: boolean }[]
  >([]);
  const [strengthLoading, setStrengthLoading] = useState(true);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  const [exerciseDetailData, setExerciseDetailData] = useState<{ date: string; weight: number; label: string }[]>([]);
  const [exerciseHistory, setExerciseHistory] = useState<{ log_date: string; weight: number; reps: number; sets: number; one_rep_max: number }[]>([]);
  const [logPRModalVisible, setLogPRModalVisible] = useState(false);
  const [prWeight, setPRWeight] = useState('');
  const [prReps, setPRReps] = useState('');
  const [prSets, setPRSets] = useState('');

  const loadStarting = useCallback(async () => {
    const [sw, sd] = await Promise.all([
      AsyncStorage.getItem(USER_STARTING_WEIGHT_KEY),
      AsyncStorage.getItem(USER_STARTING_DATE_KEY),
    ]);
    setStartingWeight(sw ?? '');
    setStartingDate(sd ?? '');
  }, []);

  const loadBody = useCallback(async () => {
    setBodyLoading(true);
    try {
      const latest = await db.getFirstAsync<BodyMetricRow>(
        'SELECT * FROM BodyMetrics ORDER BY log_date DESC LIMIT 1;'
      );
      setLatestBody(latest ?? null);

      const cut = new Date();
      cut.setDate(cut.getDate() - bodyRange);
      const cutStr = cut.toISOString().slice(0, 10);
      const rows = await db.getAllAsync<BodyMetricRow>(
        'SELECT * FROM BodyMetrics WHERE log_date >= ? ORDER BY log_date ASC;',
        [cutStr]
      );
      setBodyHistory(rows);
    } catch (e) {
      console.error('Load body metrics:', e);
    } finally {
      setBodyLoading(false);
    }
  }, [db, bodyRange]);

  useFocusEffect(
    useCallback(() => {
      loadStarting();
      loadBody();
    }, [loadStarting, loadBody])
  );

  const loadStrength = useCallback(async () => {
    setStrengthLoading(true);
    try {
      const fromWeight = await db.getAllAsync<{ exercise_name: string }>(
        'SELECT DISTINCT exercise_name FROM Weight_Log ORDER BY exercise_name;'
      );
      const fromRecords = await db.getAllAsync<{ exercise_name: string }>(
        'SELECT DISTINCT exercise_name FROM StrengthRecords ORDER BY exercise_name;'
      );
      const nameSet = new Set<string>([
        ...fromWeight.map((r) => r.exercise_name),
        ...fromRecords.map((r) => r.exercise_name),
      ]);
      const names = Array.from(nameSet).sort().map((exercise_name) => ({ exercise_name }));

      const records = await db.getAllAsync<StrengthRecordRow>(
        'SELECT * FROM StrengthRecords ORDER BY exercise_name, one_rep_max DESC;'
      );
      type Best = { weight: number; reps: number; orm: number; fromRecord: boolean };
      const bestByExercise = new Map<string, Best>();
      for (const r of records) {
        if (r.weight != null && r.reps != null && r.one_rep_max != null) {
          const key = r.exercise_name;
          const current = bestByExercise.get(key);
          if (!current || r.one_rep_max > current.orm) {
            bestByExercise.set(key, {
              weight: r.weight,
              reps: r.reps,
              orm: r.one_rep_max,
              fromRecord: true,
            });
          }
        }
      }

      const weightLogs = await db.getAllAsync<WeightLogRow>(
        `SELECT wl.exercise_name, wl.weight_logged as weight_logged, wl.reps_logged as reps_logged, w.workout_date as workout_date
         FROM Weight_Log wl
         INNER JOIN Workout_Log w ON wl.workout_log_id = w.workout_log_id
         WHERE wl.weight_logged IS NOT NULL AND wl.reps_logged IS NOT NULL;`
      );

      for (const row of weightLogs) {
        const orm = calc1RM(row.weight_logged, row.reps_logged);
        const key = row.exercise_name;
        const existing = bestByExercise.get(key);
        if (!existing || orm > existing.orm) {
          bestByExercise.set(key, {
            weight: row.weight_logged,
            reps: row.reps_logged,
            orm,
            fromRecord: false,
          });
        }
      }

      const list = names.map((n) => {
        const best = bestByExercise.get(n.exercise_name);
        if (!best) {
          return {
            exercise_name: n.exercise_name,
            bestWeight: 0,
            bestReps: 0,
            oneRM: 0,
            isPR: false,
          };
        }
        return {
          exercise_name: n.exercise_name,
          bestWeight: best.weight,
          bestReps: best.reps,
          oneRM: best.orm,
          isPR: best.fromRecord,
        };
      });
      setStrengthExercises(list);
    } catch (e) {
      console.error('Load strength:', e);
    } finally {
      setStrengthLoading(false);
    }
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      if (activeTab === 'strength') loadStrength();
    }, [activeTab, loadStrength])
  );

  const loadExerciseDetail = useCallback(
    async (exerciseName: string) => {
      try {
        const fromWL = await db.getAllAsync<{ workout_date: number; weight_logged: number }>(
          `SELECT w.workout_date as workout_date, wl.weight_logged as weight_logged
           FROM Weight_Log wl
           INNER JOIN Workout_Log w ON wl.workout_log_id = w.workout_log_id
           WHERE wl.exercise_name = ? AND wl.weight_logged IS NOT NULL
           ORDER BY w.workout_date ASC;`,
          [exerciseName]
        );
        const fromSR = await db.getAllAsync<{ log_date: string; weight: number | null }>(
          'SELECT log_date, weight FROM StrengthRecords WHERE exercise_name = ? AND weight IS NOT NULL ORDER BY log_date ASC;',
          [exerciseName]
        );
        const points: { ts: number; weight: number; label: string }[] = [];
        fromWL.forEach((r) => {
          points.push({
            ts: r.workout_date * 1000,
            weight: r.weight_logged,
            label: new Date(r.workout_date * 1000).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            }),
          });
        });
        fromSR.forEach((r) => {
          if (r.weight == null) return;
          const ts = new Date(r.log_date).getTime();
          points.push({
            ts,
            weight: r.weight,
            label: new Date(r.log_date).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            }),
          });
        });
        points.sort((a, b) => a.ts - b.ts);
        setExerciseDetailData(
          points.map((p) => ({ date: String(p.ts), weight: p.weight, label: p.label }))
        );

        const historyRows = await db.getAllAsync<{
          log_date: string;
          weight: number | null;
          reps: number | null;
          sets: number | null;
          one_rep_max: number | null;
        }>(
          'SELECT log_date, weight, reps, sets, one_rep_max FROM StrengthRecords WHERE exercise_name = ? ORDER BY log_date DESC;',
          [exerciseName]
        );
        setExerciseHistory(
          historyRows
            .filter((r) => r.weight != null && r.reps != null)
            .map((r) => ({
              log_date: r.log_date,
              weight: r.weight!,
              reps: r.reps!,
              sets: r.sets ?? 1,
              one_rep_max: r.one_rep_max ?? calc1RM(r.weight!, r.reps!),
            }))
        );
      } catch (e) {
        console.error('Load exercise detail:', e);
      }
    },
    [db]
  );

  const openLogModal = async () => {
    setLogWeight('');
    setLogMuscle('');
    setLogBone('');
    setLogWater('');
    setLogFat('');
    setLogNotes('');
    const h = await AsyncStorage.getItem(USER_HEIGHT_KEY);
    if (h) setUserHeightInches(h);
    setLogModalVisible(true);
  };

  const saveBodyLog = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const weight = logWeight ? parseFloat(logWeight) : null;
    const muscle = logMuscle ? parseFloat(logMuscle) : null;
    const bone = logBone ? parseFloat(logBone) : null;
    const water = logWater ? parseFloat(logWater) : null;
    const fat = logFat ? parseFloat(logFat) : null;
    let bmi: number | null = null;
    if (weight != null && userHeightInches) {
      const hi = parseFloat(userHeightInches);
      if (hi > 0) bmi = (weight / (hi * hi)) * 703;
    }
    try {
      await db.runAsync(
        `INSERT INTO BodyMetrics (log_date, weight, muscle_mass, bone_mass, body_water, body_fat, bmi, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [date, weight, muscle, bone, water, fat, bmi ?? null, logNotes || null]
      );
      setLogModalVisible(false);
      loadBody();
    } catch (e) {
      console.error('Save body log:', e);
    }
  };

  const bodyChartData = (() => {
    const key = bodySeries;
    const pairs: { label: string; value: number }[] = [];
    bodyHistory.forEach((r) => {
      const v =
        key === 'weight'
          ? r.weight
          : key === 'muscle'
            ? r.muscle_mass
            : key === 'fat'
              ? r.body_fat
              : r.body_water;
      if (v != null) pairs.push({ label: formatDateYMD(r.log_date), value: v });
    });
    if (pairs.length === 0) return null;
    return {
      labels: pairs.map((p) => p.label),
      datasets: [{ data: pairs.map((p) => p.value) }],
    };
  })();

  const openPRModal = () => {
    setPRWeight('');
    setPRReps('');
    setPRSets('1');
    setLogPRModalVisible(true);
  };

  const savePR = async () => {
    if (!selectedExercise) return;
    const weight = parseFloat(prWeight);
    const reps = parseInt(prReps, 10);
    const sets = parseInt(prSets, 10) || 1;
    if (isNaN(weight) || isNaN(reps) || reps < 1) return;
    const oneRM = calc1RM(weight, reps);
    const date = new Date().toISOString().slice(0, 10);
    try {
      await db.runAsync(
        `INSERT INTO StrengthRecords (exercise_name, log_date, weight, reps, sets, one_rep_max)
         VALUES (?, ?, ?, ?, ?, ?);`,
        [selectedExercise, date, weight, reps, sets, oneRM]
      );
      setLogPRModalVisible(false);
      loadStrength();
      if (selectedExercise) loadExerciseDetail(selectedExercise);
    } catch (e) {
      console.error('Save PR:', e);
    }
  };

  const openExerciseDetail = (name: string) => {
    setSelectedExercise(name);
    loadExerciseDetail(name);
  };

  const currentWeight = latestBody?.weight ?? null;
  const startWeightNum = startingWeight ? parseFloat(startingWeight) : null;
  const change =
    currentWeight != null && startWeightNum != null
      ? currentWeight - startWeightNum
      : null;

  return (
    <View style={[styles.container, { backgroundColor: theme.background || CREAM }]}>
      <View style={[styles.tabRow, { borderBottomColor: 'rgba(0,0,0,0.1)' }]}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'body' && styles.tabActive]}
          onPress={() => setActiveTab('body')}
        >
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'body' ? SAGE : theme.textSecondary },
              activeTab === 'body' && styles.tabTextActive,
            ]}
          >
            MyBody
          </Text>
          {activeTab === 'body' && <View style={[styles.tabUnderline, { backgroundColor: SAGE }]} />}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'strength' && styles.tabActive]}
          onPress={() => setActiveTab('strength')}
        >
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'strength' ? SAGE : theme.textSecondary },
              activeTab === 'strength' && styles.tabTextActive,
            ]}
          >
            MyStrength
          </Text>
          {activeTab === 'strength' && (
            <View style={[styles.tabUnderline, { backgroundColor: SAGE }]} />
          )}
        </TouchableOpacity>
      </View>

      {activeTab === 'body' && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.sectionHeader, { color: SAGE }]}>MY BODY · LATEST STATS</Text>
          {bodyLoading ? (
            <ActivityIndicator size="small" color={SAGE} style={{ marginVertical: 24 }} />
          ) : (
            <View style={styles.cardGrid}>
              {[
                { label: 'Weight (lbs)', value: latestBody?.weight },
                { label: 'Muscle Mass (lbs)', value: latestBody?.muscle_mass },
                { label: 'Bone Mass (lbs)', value: latestBody?.bone_mass },
                { label: 'Body Water (%)', value: latestBody?.body_water },
                { label: 'Body Fat (%)', value: latestBody?.body_fat },
                { label: 'BMI', value: latestBody?.bmi != null ? latestBody.bmi.toFixed(1) : null },
              ].map((item, i) => (
                <View
                  key={i}
                  style={[
                    styles.statCard,
                    { backgroundColor: '#FFFFFF', borderLeftColor: SAGE },
                  ]}
                >
                  <Text style={[styles.statLabel, { color: theme.textSecondary }]}>{item.label}</Text>
                  <Text style={[styles.statValue, { color: theme.text }]}>
                    {item.value != null ? String(item.value) : '—'}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {(startingWeight || startingDate || currentWeight != null) && (
            <View style={[styles.startingRow, { backgroundColor: '#FFFFFF', borderColor: theme.border }]}>
              <Text style={[styles.startingText, { color: theme.text }]}>
                Started: {startWeightNum != null ? `${startWeightNum} lbs` : '—'} on {startingDate || '—'}
              </Text>
              <Text style={[styles.startingText, { color: theme.text }]}>
                Current: {currentWeight != null ? `${currentWeight} lbs` : '—'}
              </Text>
              {change != null && (
                <Text style={[styles.startingChange, { color: change >= 0 ? SAGE : '#C0392B' }]}>
                  Change: {change >= 0 ? '+' : ''}{change.toFixed(1)} lbs
                </Text>
              )}
            </View>
          )}

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: SAGE }]}
            onPress={openLogModal}
          >
            <Text style={styles.primaryButtonText}>Log Today</Text>
          </TouchableOpacity>

          <Text style={[styles.sectionHeader, { color: SAGE, marginTop: 24 }]}>MY BODY · TREND</Text>
          <View style={styles.chartTabs}>
            {(['weight', 'muscle', 'fat', 'water'] as const).map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => setBodySeries(s)}
                style={[styles.chartTab, bodySeries === s && { borderBottomColor: SAGE }]}
              >
                <Text
                  style={[
                    styles.chartTabText,
                    { color: bodySeries === s ? SAGE : theme.textSecondary },
                  ]}
                >
                  {s === 'weight' ? 'Weight' : s === 'muscle' ? 'Muscle' : s === 'fat' ? 'Fat' : 'Water'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.rangeRow}>
            {([30, 90, 365] as const).map((d) => (
              <TouchableOpacity
                key={d}
                onPress={() => setBodyRange(d)}
                style={[styles.rangeChip, bodyRange === d && { backgroundColor: SAGE }]}
              >
                <Text
                  style={[
                    styles.rangeChipText,
                    { color: bodyRange === d ? '#fff' : theme.text },
                  ]}
                >
                  {d === 30 ? '30 days' : d === 90 ? '90 days' : '1 year'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {bodyChartData && bodyChartData.datasets[0].data.length > 0 ? (
            <LineChart
              data={bodyChartData}
              width={chartWidth}
              height={220}
              chartConfig={chartConfig(theme.text)}
              bezier
              style={styles.chart}
              withInnerLines={false}
              withOuterLines={false}
              fromZero
              segments={4}
            />
          ) : (
            <Text style={[styles.emptyChart, { color: theme.textSecondary }]}>
              Log MyBody metrics to see trends.
            </Text>
          )}
        </ScrollView>
      )}

      {activeTab === 'strength' && (
        <View style={{ flex: 1 }}>
          {selectedExercise ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <TouchableOpacity
                onPress={() => setSelectedExercise(null)}
                style={styles.backRow}
              >
                <Text style={[styles.backText, { color: SAGE }]}>← Back to list</Text>
              </TouchableOpacity>
              <Text style={[styles.sectionHeader, { color: SAGE }]}>
                {selectedExercise.toUpperCase()}
              </Text>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: SAGE }]}
                onPress={openPRModal}
              >
                <Text style={styles.primaryButtonText}>Log PR</Text>
              </TouchableOpacity>
              {exerciseDetailData.length > 0 ? (
                <LineChart
                  data={{
                    labels: exerciseDetailData.map((p) => p.label),
                    datasets: [{ data: exerciseDetailData.map((p) => p.weight) }],
                  }}
                  width={chartWidth}
                  height={220}
                  chartConfig={chartConfig(theme.text)}
                  bezier
                  style={styles.chart}
                  withInnerLines={false}
                  withOuterLines={false}
                  fromZero
                />
              ) : (
                <Text style={[styles.emptyChart, { color: theme.textSecondary }]}>
                  No weight history. Log a PR or complete a workout with this exercise.
                </Text>
              )}
              <Text style={[styles.sectionHeader, { color: SAGE, marginTop: 16 }]}>MY STRENGTH · HISTORY</Text>
              {exerciseHistory.length === 0 ? (
                <Text style={[styles.emptyChart, { color: theme.textSecondary }]}>No logged sets yet.</Text>
              ) : (
                exerciseHistory.map((h, i) => (
                  <View
                    key={i}
                    style={[styles.historyRow, { backgroundColor: '#FFFFFF', borderLeftColor: SAGE }]}
                  >
                    <Text style={[styles.historyDate, { color: theme.text }]}>{h.log_date}</Text>
                    <Text style={[styles.historyDetail, { color: theme.text }]}>
                      {h.weight} × {h.reps} × {h.sets} — Est. 1RM: {h.one_rep_max.toFixed(0)}
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>
          ) : (
            <>
              {strengthLoading ? (
                <ActivityIndicator size="small" color={SAGE} style={{ marginTop: 24 }} />
              ) : (
                <FlatList
                  data={strengthExercises}
                  keyExtractor={(item) => item.exercise_name}
                  contentContainerStyle={styles.listContent}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[styles.strengthCard, { backgroundColor: '#FFFFFF', borderLeftColor: SAGE }]}
                      onPress={() => openExerciseDetail(item.exercise_name)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.strengthCardLeft}>
                        <Text style={[styles.strengthName, { color: theme.text }]} numberOfLines={1}>
                          {item.exercise_name}
                          {item.isPR ? ' ✦' : ''}
                        </Text>
                        <Text style={[styles.strengthSub, { color: theme.textSecondary }]}>
                          Best: {item.bestWeight} × {item.bestReps} · Est. 1RM: {item.oneRM.toFixed(0)}
                        </Text>
                      </View>
                      <Text style={[styles.chevron, { color: theme.textSecondary }]}>›</Text>
                    </TouchableOpacity>
                  )}
                  ListEmptyComponent={
                    <Text style={[styles.emptyChart, { color: theme.textSecondary }]}>
                      Complete workouts with logged weights to see exercises here.
                    </Text>
                  }
                />
              )}
            </>
          )}
        </View>
      )}

      <Modal visible={logModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={[styles.modalBox, { backgroundColor: '#FFFFFF' }]}
          >
            <Text style={[styles.modalTitle, { color: theme.text }]}>Log MyBody metrics</Text>
            <Text style={[styles.modalHint, { color: theme.textSecondary }]}>
              Enter what your scale shows. Not all fields required.
            </Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Weight (lbs)"
              placeholderTextColor={theme.textSecondary}
              value={logWeight}
              onChangeText={setLogWeight}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Muscle mass (lbs)"
              placeholderTextColor={theme.textSecondary}
              value={logMuscle}
              onChangeText={setLogMuscle}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Bone mass (lbs)"
              placeholderTextColor={theme.textSecondary}
              value={logBone}
              onChangeText={setLogBone}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Body water (%)"
              placeholderTextColor={theme.textSecondary}
              value={logWater}
              onChangeText={setLogWater}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Body fat (%)"
              placeholderTextColor={theme.textSecondary}
              value={logFat}
              onChangeText={setLogFat}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Notes"
              placeholderTextColor={theme.textSecondary}
              value={logNotes}
              onChangeText={setLogNotes}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, { borderColor: theme.border }]}
                onPress={() => setLogModalVisible(false)}
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: SAGE }]}
                onPress={saveBodyLog}
              >
                <Text style={styles.modalButtonTextWhite}>Save</Text>
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      <Modal visible={logPRModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: '#FFFFFF' }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              Log MyStrength PR — {selectedExercise}
            </Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Weight (lbs)"
              placeholderTextColor={theme.textSecondary}
              value={prWeight}
              onChangeText={setPRWeight}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Reps"
              placeholderTextColor={theme.textSecondary}
              value={prReps}
              onChangeText={setPRReps}
              keyboardType="number-pad"
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Sets (optional)"
              placeholderTextColor={theme.textSecondary}
              value={prSets}
              onChangeText={setPRSets}
              keyboardType="number-pad"
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, { borderColor: theme.border }]}
                onPress={() => setLogPRModalVisible(false)}
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: SAGE }]}
                onPress={savePR}
              >
                <Text style={styles.modalButtonTextWhite}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabRow: {
    marginTop: -12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    borderBottomWidth: 1,
    paddingHorizontal: 8,
  },
  tab: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginBottom: -1,
  },
  tabActive: {},
  tabText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 15,
  },
  tabTextActive: {
    fontFamily: 'Jost_600SemiBold',
  },
  tabUnderline: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 0,
    height: 2,
    borderRadius: 1,
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 40,
  },
  sectionHeader: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 12,
    letterSpacing: 1.2,
    marginBottom: 12,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  statCard: {
    width: '50%',
    paddingHorizontal: 8,
    paddingVertical: 8,
    marginBottom: 8,
    borderRadius: 8,
    borderLeftWidth: 3,
    minWidth: 0,
    boxSizing: 'border-box',
  },
  statLabel: {
    fontFamily: 'Jost_400Regular',
    fontSize: 10,
    marginBottom: 2,
  },
  statValue: {
    fontFamily: 'CormorantGaramond-SemiBold',
    fontSize: 18,
  },
  startingRow: {
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 12,
  },
  startingText: {
    fontFamily: 'Jost_400Regular',
    fontSize: 14,
    marginBottom: 4,
  },
  startingChange: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 14,
    marginTop: 4,
  },
  primaryButton: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  chartTabs: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  chartTab: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginRight: 4,
  },
  chartTabText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 13,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  rangeChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  rangeChipText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 13,
  },
  chart: {
    marginVertical: 8,
    borderRadius: 12,
  },
  emptyChart: {
    fontFamily: 'Jost_400Regular',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 24,
  },
  listContent: {
    padding: 20,
    paddingBottom: 40,
  },
  strengthCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderRadius: 10,
    borderLeftWidth: 3,
    marginBottom: 12,
  },
  strengthCardLeft: { flex: 1 },
  strengthName: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 16,
  },
  strengthSub: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    marginTop: 4,
  },
  chevron: {
    fontSize: 20,
    fontFamily: 'Jost_400Regular',
  },
  backRow: { marginBottom: 16 },
  backText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 15,
  },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderLeftWidth: 3,
    marginBottom: 8,
  },
  historyDate: {
    fontFamily: 'Jost_400Regular',
    fontSize: 14,
  },
  historyDetail: {
    fontFamily: 'Jost_500Medium',
    fontSize: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  modalBox: {
    borderRadius: 16,
    padding: 24,
    maxHeight: '80%',
  },
  modalTitle: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 18,
    marginBottom: 8,
  },
  modalHint: {
    fontFamily: 'Jost_400Regular',
    fontSize: 13,
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  modalButtonText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 15,
  },
  modalButtonTextWhite: {
    fontFamily: 'Jost_500Medium',
    fontSize: 15,
    color: '#FFFFFF',
  },
});
