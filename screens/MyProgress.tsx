/**
 * MyProgress: MyBody and MyStrength tabs.
 * MyBody: 2x3 stat cards, starting weight comparison, Log Today modal, line chart (Weight|Muscle|Fat|Water, 30/90/365).
 * MyStrength: exercise list from Weight_Log + StrengthRecords, detail with chart and Log MyStrength PR.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
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
  Alert,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { useTheme } from '../context/ThemeContext';
import { useProfile } from '../context/ProfileContext';
import { LineChart } from 'react-native-chart-kit';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Swipeable, RectButton } from 'react-native-gesture-handler';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { showCelebrationNotification } from '../utils/notificationUtils';
import { formatLocalYmd, getLocalWeekMondaySundayYmd } from '../utils/localDateYmd';

const SAGE = '#7C9A7E';
const CREAM = '#FDF8F0';
const WEEKLY_SUMMARY_MODAL_BG = '#F5F0E8';
const SAGE_WORKER_URL = 'https://myvow-fit-api.allison-spink.workers.dev';
const WEEKLY_SUMMARY_SYSTEM_PROMPT =
  'You are Sage, a warm and motivating fitness coach. Give a concise, encouraging weekly summary based on the data provided. Keep it under 150 words.';
const WEEKLY_SUMMARY_API_ERROR =
  'Sage is taking a break — try again in a moment.';

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

/** One record per workout (per exercise per date). */
type WorkoutSummary = {
  date: string;
  dateLabel: string;
  heaviestWeight: number;
  totalVolume: number;
  estimated1RM: number;
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

/** Monday 00:00:00 through end of today (local), for weekly progress summaries. */
function getMondayToTodayProgressRange(): {
  weekStartYmd: string;
  todayYmd: string;
  startTs: number;
  endTs: number;
} {
  const now = new Date();
  const dow = now.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return {
    weekStartYmd: formatLocalYmd(monday),
    todayYmd: formatLocalYmd(now),
    startTs: Math.floor(monday.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000),
  };
}

type WeeklySummaryPayload = {
  periodLabel: string;
  workoutsScheduled: number;
  workoutsLogged: number;
  vowCheckInsCompleted: number;
  avgDailyCalories: number | null;
  daysWithCalorieLogs: number;
  prExercisesThisWeek: string[];
  strengthRecordsThisWeek: { exercise_name: string; weight: number; reps: number | null }[];
};

async function gatherWeeklySummaryData(db: {
  getAllAsync: (sql: string, params?: (string | number)[]) => Promise<any[]>;
}): Promise<WeeklySummaryPayload> {
  const { weekStartYmd, todayYmd, startTs, endTs } = getMondayToTodayProgressRange();
  const periodLabel = `${weekStartYmd} through ${todayYmd}`;

  let workoutsScheduled = 0;
  let workoutsLogged = 0;
  try {
    const sched = await db.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) as n FROM Workout_Log WHERE workout_date BETWEEN ? AND ?;',
      [startTs, endTs]
    );
    workoutsScheduled = sched[0]?.n ?? 0;
    const logged = await db.getAllAsync<{ n: number }>(
      `SELECT COUNT(DISTINCT wl.workout_log_id) as n
       FROM Weight_Log wl
       INNER JOIN Workout_Log w ON w.workout_log_id = wl.workout_log_id
       WHERE w.workout_date BETWEEN ? AND ?;`,
      [startTs, endTs]
    );
    workoutsLogged = logged[0]?.n ?? 0;
  } catch (e) {
    console.warn('weekly summary workouts:', e);
  }

  let vowCheckInsCompleted = 0;
  try {
    const vows = await db.getAllAsync<{ n: number }>(
      'SELECT COUNT(*) as n FROM VowCheckIns WHERE check_in_date >= ? AND check_in_date <= ?;',
      [weekStartYmd, todayYmd]
    );
    vowCheckInsCompleted = vows[0]?.n ?? 0;
  } catch {
    /* table may not exist yet */
  }

  let avgDailyCalories: number | null = null;
  let daysWithCalorieLogs = 0;
  try {
    const calRows = await db.getAllAsync<{ daily_total: number }>(
      `SELECT SUM(COALESCE(lf.calories, 0) * COALESCE(lf.quantity, 1)) as daily_total
       FROM DailyLog dl
       INNER JOIN LoggedFoods lf ON lf.log_id = dl.log_id
       WHERE dl.log_date >= ? AND dl.log_date <= ?
       GROUP BY dl.log_date
       HAVING SUM(COALESCE(lf.calories, 0) * COALESCE(lf.quantity, 1)) > 0;`,
      [weekStartYmd, todayYmd]
    );
    daysWithCalorieLogs = calRows.length;
    if (calRows.length > 0) {
      const sum = calRows.reduce((a, r) => a + (Number(r.daily_total) || 0), 0);
      avgDailyCalories = Math.round(sum / calRows.length);
    }
  } catch {
    /* nutrition tables may be missing */
  }

  const prExercisesThisWeek: string[] = [];
  try {
    const prNames = await db.getAllAsync<{ exercise_name: string }>(
      `WITH week_sets AS (
         SELECT wl.exercise_name, wl.weight_logged, w.workout_date
         FROM Weight_Log wl
         INNER JOIN Workout_Log w ON w.workout_log_id = wl.workout_log_id
         WHERE w.workout_date BETWEEN ? AND ?
           AND wl.exercise_name NOT LIKE 'Warm-up:%'
           AND wl.exercise_name NOT LIKE 'Cool-down:%'
       ),
       prior_max AS (
         SELECT wl.exercise_name, MAX(wl.weight_logged) as max_w
         FROM Weight_Log wl
         INNER JOIN Workout_Log w ON w.workout_log_id = w.workout_log_id
         WHERE w.workout_date < ?
         GROUP BY wl.exercise_name
       )
       SELECT DISTINCT ws.exercise_name
       FROM week_sets ws
       LEFT JOIN prior_max p ON p.exercise_name = ws.exercise_name
       WHERE ws.weight_logged > COALESCE(p.max_w, 0);`,
      [startTs, endTs, startTs]
    );
    prNames.forEach((r) => prExercisesThisWeek.push(r.exercise_name));
  } catch (e) {
    console.warn('weekly summary PRs:', e);
  }

  const strengthRecordsThisWeek: { exercise_name: string; weight: number; reps: number | null }[] = [];
  try {
    const sr = await db.getAllAsync<{
      exercise_name: string;
      weight: number | null;
      reps: number | null;
    }>(
      `SELECT exercise_name, weight, reps FROM StrengthRecords
       WHERE log_date >= ? AND log_date <= ? AND weight IS NOT NULL
       ORDER BY log_date ASC;`,
      [weekStartYmd, todayYmd]
    );
    for (const r of sr) {
      if (r.weight == null) continue;
      if (r.exercise_name.startsWith('Warm-up:') || r.exercise_name.startsWith('Cool-down:')) continue;
      strengthRecordsThisWeek.push({
        exercise_name: r.exercise_name,
        weight: r.weight,
        reps: r.reps,
      });
    }
  } catch {
    /* StrengthRecords may be missing */
  }

  return {
    periodLabel,
    workoutsScheduled,
    workoutsLogged,
    vowCheckInsCompleted,
    avgDailyCalories,
    daysWithCalorieLogs,
    prExercisesThisWeek,
    strengthRecordsThisWeek,
  };
}

function weeklyPayloadToUserMessage(data: WeeklySummaryPayload): string {
  const lines: string[] = [
    `Weekly progress data (${data.periodLabel}, Monday through today):`,
    `- Workouts logged vs scheduled: ${data.workoutsLogged} logged / ${data.workoutsScheduled} scheduled on the calendar`,
    `- Vow check-ins completed this period: ${data.vowCheckInsCompleted}`,
  ];
  if (data.avgDailyCalories != null && data.daysWithCalorieLogs > 0) {
    lines.push(
      `- Nutrition: average daily calories logged ≈ ${data.avgDailyCalories} kcal (across ${data.daysWithCalorieLogs} day(s) with food logs)`
    );
  } else {
    lines.push('- Nutrition: no calorie logs found for this period');
  }
  if (data.prExercisesThisWeek.length > 0) {
    lines.push(
      `- New weight PRs (from workout exercise logs vs prior max): ${data.prExercisesThisWeek.join(', ')}`
    );
  } else {
    lines.push('- New weight PRs from workout logs: none detected this period');
  }
  if (data.strengthRecordsThisWeek.length > 0) {
    const bits = data.strengthRecordsThisWeek.map(
      (r) => `${r.exercise_name} (${r.weight} lb${r.reps != null ? ` × ${r.reps}` : ''})`
    );
    lines.push(`- Strength records / PRs logged in MyStrength this period: ${bits.join('; ')}`);
  } else {
    lines.push('- Strength records logged in MyStrength this period: none');
  }
  return lines.join('\n');
}

function parseSageWorkerText(data: unknown): string {
  const d = data as { content?: { type?: string; text?: string }[] };
  const blocks = Array.isArray(d?.content) ? d.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function fetchWeeklySummaryFromSage(userMessage: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(SAGE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system: WEEKLY_SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!response.ok) {
      console.warn('Weekly summary API:', await response.text());
      return { ok: false, error: WEEKLY_SUMMARY_API_ERROR };
    }
    const json = await response.json();
    const text = parseSageWorkerText(json);
    return { ok: true, text: text || 'Here is your week in review — keep showing up for yourself.' };
  } catch (e) {
    console.warn('Weekly summary fetch:', e);
    return { ok: false, error: WEEKLY_SUMMARY_API_ERROR };
  }
}

/** If the two most recent body logs show weight loss, show a congrats notification. */
async function checkWeightLossCelebration(
  db: { getAllAsync: (sql: string) => Promise<{ weight: number | null; log_date: string }[]> }
) {
  try {
    const rows = await db.getAllAsync<{ weight: number | null; log_date: string }>(
      'SELECT weight, log_date FROM BodyMetrics ORDER BY log_date DESC LIMIT 2;'
    );
    if (rows.length < 2 || rows[0].weight == null || rows[1].weight == null) return;
    const current = rows[0].weight;
    const previous = rows[1].weight;
    if (current >= previous) return;
    const diff = previous - current;
    const lbs = diff.toFixed(1);
    await showCelebrationNotification('Congrats!', `You lost ${lbs} lbs!`);
  } catch (e) {
    console.warn('Weight loss celebration check:', e);
  }
}

function BodyLogSwipeRow({
  row,
  theme,
  onEdit,
  onDelete,
}: {
  row: BodyMetricRow;
  theme: { background: string; text: string; textSecondary: string; border: string };
  onEdit: () => void;
  onDelete: () => void;
}) {
  const swipeRef = useRef<Swipeable | null>(null);
  const renderLeftActions = () => (
    <RectButton style={styles.swipeEditBtn} onPress={() => { swipeRef.current?.close(); onEdit(); }}>
      <Text style={styles.swipeBtnText}>Edit</Text>
    </RectButton>
  );
  const renderRightActions = () => (
    <RectButton style={styles.swipeDeleteBtn} onPress={() => { swipeRef.current?.close(); onDelete(); }}>
      <Text style={styles.swipeBtnText}>Delete</Text>
    </RectButton>
  );
  return (
    <Swipeable
      ref={(r) => { swipeRef.current = r; }}
      renderLeftActions={renderLeftActions}
      renderRightActions={renderRightActions}
      friction={2}
    >
      <View style={[styles.logRow, { borderBottomColor: theme.border, backgroundColor: theme.background }]}>
        <View style={styles.logRowMain}>
          <Text style={[styles.logRowDate, { color: theme.text }]}>
            {new Date(row.log_date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
          </Text>
          <Text style={[styles.logRowSummary, { color: theme.textSecondary }]}>
            {[
              row.weight != null && `${row.weight} lbs`,
              row.body_fat != null && `${row.body_fat}% fat`,
              row.muscle_mass != null && `${row.muscle_mass}% muscle`,
              row.bone_mass != null && `${row.bone_mass}% bone`,
            ]
              .filter(Boolean)
              .join(' · ') || '—'}
          </Text>
        </View>
      </View>
    </Swipeable>
  );
}

const chartConfig = (theme: { background: string; text: string; border: string }) => ({
  backgroundColor: theme.background,
  backgroundGradientFrom: theme.background,
  backgroundGradientTo: theme.background,
  decimalPlaces: 1,
  color: () => SAGE,
  labelColor: () => theme.text,
  style: { paddingRight: 0 },
  propsForLabels: { fontFamily: 'Jost_400Regular' },
  propsForBackgroundLines: {
    stroke: theme.border,
    strokeOpacity: 0.5,
  },
});

export default function MyProgress() {
  const db = useSQLiteContext();
  const navigation = useNavigation<any>();
  const { theme } = useTheme();
  const { profileSavedTrigger } = useProfile();
  const { width, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bodyLogModalScrollMax = Math.min(windowHeight * 0.48, 360);
  const chartWidth = Math.max(width - 48, 280);
  /** Chart width inside metric detail modal: overlay padding 24*2 + box padding 20*2 */
  const chartWidthModal = Math.max(width - 88, 260);

  const [activeTab, setActiveTab] = useState<'body' | 'strength'>('body');
  const [latestBody, setLatestBody] = useState<BodyMetricRow | null>(null);
  const [bodyHistory, setBodyHistory] = useState<BodyMetricRow[]>([]);
  const [bodyHistoryThisWeek, setBodyHistoryThisWeek] = useState<BodyMetricRow[]>([]);
  const [bodyLoading, setBodyLoading] = useState(true);
  const [bodySeries, setBodySeries] = useState<'weight' | 'muscle' | 'fat' | 'water'>('weight');
  const [bodyRange, setBodyRange] = useState<30 | 90 | 365>(30);

  const [startingWeight, setStartingWeight] = useState<string>('');
  const [startingDate, setStartingDate] = useState<string>('');

  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logEntryDate, setLogEntryDate] = useState<string>(''); // captured when user taps "Log Today"
  const [editingBodyLog, setEditingBodyLog] = useState<BodyMetricRow | null>(null);
  const [editLogDate, setEditLogDate] = useState<string>('');
  const [showEditDatePicker, setShowEditDatePicker] = useState(false);
  const [logWeight, setLogWeight] = useState('');
  const [logMuscle, setLogMuscle] = useState('');
  const [logBone, setLogBone] = useState('');
  const [logWater, setLogWater] = useState('');
  const [logFat, setLogFat] = useState('');
  const [logNotes, setLogNotes] = useState('');
  /** Log MyBody modal: lift footer only so Cancel/Save sit above keyboard (no KeyboardAvoidingView on the sheet). */
  const [bodyLogKeyboardInset, setBodyLogKeyboardInset] = useState(0);
  const [userHeightInches, setUserHeightInches] = useState<string>('');

  // Editable card values (synced from latestBody, saved on blur)
  const [cardWeight, setCardWeight] = useState('');
  const [cardMuscle, setCardMuscle] = useState('');
  const [cardBone, setCardBone] = useState('');
  const [cardWater, setCardWater] = useState('');
  const [cardFat, setCardFat] = useState('');
  const [cardBmi, setCardBmi] = useState('');

  const [strengthExercises, setStrengthExercises] = useState<
    { exercise_name: string; maxWeight: number; oneRM: number }[]
  >([]);
  const [strengthLoading, setStrengthLoading] = useState(true);
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  /** Per-workout aggregates (one point per date) for the selected exercise. */
  const [workoutSummaries, setWorkoutSummaries] = useState<WorkoutSummary[]>([]);
  /** StrengthRecords rows for selected exercise (for history list in Log PR flow). */
  const [exerciseHistory, setExerciseHistory] = useState<{ log_date: string; weight: number; reps: number; one_rep_max: number }[]>([]);
  /** Which metric tile detail is open: chart + history for that metric. */
  const [metricDetailModal, setMetricDetailModal] = useState<'heaviest' | 'volume' | 'estimated1RM' | null>(null);

  const [weeklySummaryVisible, setWeeklySummaryVisible] = useState(false);
  const [weeklySummaryLoading, setWeeklySummaryLoading] = useState(false);
  const [weeklySummaryText, setWeeklySummaryText] = useState('');
  const [weeklySummaryError, setWeeklySummaryError] = useState<string | null>(null);
  const weeklySummaryInFlight = useRef(false);

  const handleOpenWeeklySummary = useCallback(async () => {
    if (weeklySummaryInFlight.current) return;
    weeklySummaryInFlight.current = true;
    setWeeklySummaryVisible(true);
    setWeeklySummaryLoading(true);
    setWeeklySummaryText('');
    setWeeklySummaryError(null);
    try {
      const payload = await gatherWeeklySummaryData(db);
      const userMsg = weeklyPayloadToUserMessage(payload);
      const result = await fetchWeeklySummaryFromSage(userMsg);
      if (result.ok) {
        setWeeklySummaryText(result.text);
      } else {
        setWeeklySummaryError(result.error);
      }
    } catch (e) {
      console.error('Weekly summary:', e);
      setWeeklySummaryError(WEEKLY_SUMMARY_API_ERROR);
    } finally {
      setWeeklySummaryLoading(false);
      weeklySummaryInFlight.current = false;
    }
  }, [db]);

  const loadStarting = useCallback(async () => {
    const [sw, sd] = await Promise.all([
      AsyncStorage.getItem(USER_STARTING_WEIGHT_KEY),
      AsyncStorage.getItem(USER_STARTING_DATE_KEY),
    ]);
    setStartingWeight(sw ?? '');
    setStartingDate(sd ?? '');
  }, []);

  useEffect(() => {
    loadStarting();
  }, [profileSavedTrigger, loadStarting]);

  useEffect(() => {
    if (!logModalVisible) {
      setBodyLogKeyboardInset(0);
      return;
    }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => {
      setBodyLogKeyboardInset(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => setBodyLogKeyboardInset(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [logModalVisible]);

  const loadBody = useCallback(async () => {
    setBodyLoading(true);
    try {
      const latest = await db.getFirstAsync<BodyMetricRow>(
        'SELECT * FROM BodyMetrics ORDER BY log_date DESC LIMIT 1;'
      );
      setLatestBody(latest ?? null);
      const l = latest ?? null;
      setCardWeight(l?.weight != null ? String(l.weight) : '');
      setCardMuscle(l?.muscle_mass != null ? String(l.muscle_mass) : '');
      setCardBone(l?.bone_mass != null ? String(l.bone_mass) : '');
      setCardWater(l?.body_water != null ? String(l.body_water) : '');
      setCardFat(l?.body_fat != null ? String(l.body_fat) : '');
      setCardBmi(l?.bmi != null ? String(l.bmi) : '');

      const cut = new Date();
      cut.setDate(cut.getDate() - bodyRange);
      const cutStr = cut.toISOString().slice(0, 10);
      const rows = await db.getAllAsync<BodyMetricRow>(
        'SELECT * FROM BodyMetrics WHERE log_date >= ? ORDER BY log_date ASC;',
        [cutStr]
      );
      setBodyHistory(rows);

      const { weekStartYmd: weekStart, weekEndYmd: weekEnd } = getLocalWeekMondaySundayYmd();
      const weekRows = await db.getAllAsync<BodyMetricRow>(
        'SELECT * FROM BodyMetrics WHERE log_date >= ? AND log_date <= ? ORDER BY log_date DESC;',
        [weekStart, weekEnd]
      );
      setBodyHistoryThisWeek(weekRows);
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
      const names = Array.from(nameSet)
        .filter(
          (n) => !n.startsWith('Warm-up:') && !n.startsWith('Cool-down:')
        )
        .sort()
        .map((exercise_name) => ({ exercise_name }));

      const records = await db.getAllAsync<StrengthRecordRow>(
        'SELECT * FROM StrengthRecords ORDER BY exercise_name, one_rep_max DESC;'
      );
      const maxWeightByExercise = new Map<string, number>();
      const maxORMByExercise = new Map<string, number>();
      for (const r of records) {
        if (r.weight != null && r.reps != null && r.one_rep_max != null) {
          const key = r.exercise_name;
          const w = maxWeightByExercise.get(key);
          if (w == null || r.weight > w) maxWeightByExercise.set(key, r.weight);
          const o = maxORMByExercise.get(key);
          if (o == null || r.one_rep_max > o) maxORMByExercise.set(key, r.one_rep_max);
        }
      }

      const weightLogs = await db.getAllAsync<WeightLogRow>(
        `SELECT wl.exercise_name, wl.weight_logged as weight_logged, wl.reps_logged as reps_logged, w.workout_date as workout_date
         FROM Weight_Log wl
         INNER JOIN Workout_Log w ON wl.workout_log_id = w.workout_log_id
         WHERE wl.weight_logged IS NOT NULL AND wl.reps_logged IS NOT NULL;`
      );
      for (const row of weightLogs) {
        const key = row.exercise_name;
        const w = maxWeightByExercise.get(key);
        if (w == null || row.weight_logged > w) maxWeightByExercise.set(key, row.weight_logged);
        const orm = calc1RM(row.weight_logged, row.reps_logged);
        const o = maxORMByExercise.get(key);
        if (o == null || orm > o) maxORMByExercise.set(key, orm);
      }

      const list = names.map((n) => ({
        exercise_name: n.exercise_name,
        maxWeight: maxWeightByExercise.get(n.exercise_name) ?? 0,
        oneRM: Math.round(maxORMByExercise.get(n.exercise_name) ?? 0),
      }));
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
        const fromWL = await db.getAllAsync<{ workout_date: number; weight_logged: number; reps_logged: number }>(
          `SELECT w.workout_date as workout_date, wl.weight_logged as weight_logged, wl.reps_logged as reps_logged
           FROM Weight_Log wl
           INNER JOIN Workout_Log w ON wl.workout_log_id = w.workout_log_id
           WHERE wl.exercise_name = ? AND wl.weight_logged IS NOT NULL AND wl.reps_logged IS NOT NULL
           ORDER BY w.workout_date ASC;`,
          [exerciseName]
        );
        const fromSR = await db.getAllAsync<{ log_date: string; weight: number | null; reps: number | null; one_rep_max: number | null }>(
          'SELECT log_date, weight, reps, one_rep_max FROM StrengthRecords WHERE exercise_name = ? AND weight IS NOT NULL ORDER BY log_date ASC;',
          [exerciseName]
        );

        // Aggregate Weight_Log by workout_date: one summary per workout
        const byDateWL = new Map<number, { heaviest: number; volume: number; max1RM: number }>();
        for (const r of fromWL) {
          const ts = r.workout_date;
          const existing = byDateWL.get(ts);
          const weight = r.weight_logged;
          const reps = r.reps_logged;
          const vol = weight * reps;
          const oneRM = calc1RM(weight, reps);
          if (!existing) {
            byDateWL.set(ts, { heaviest: weight, volume: vol, max1RM: oneRM });
          } else {
            byDateWL.set(ts, {
              heaviest: Math.max(existing.heaviest, weight),
              volume: existing.volume + vol,
              max1RM: Math.max(existing.max1RM, oneRM),
            });
          }
        }

        const byDate = new Map<string, WorkoutSummary>();
        byDateWL.forEach((agg, ts) => {
          const dateStr = new Date(ts * 1000).toISOString().slice(0, 10);
          byDate.set(dateStr, {
            date: dateStr,
            dateLabel: new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            heaviestWeight: agg.heaviest,
            totalVolume: Math.round(agg.volume),
            estimated1RM: Math.round(agg.max1RM),
          });
        });
        // StrengthRecords: merge into same date or add new date
        fromSR.forEach((r) => {
          if (r.weight == null || r.reps == null) return;
          const dateStr = r.log_date;
          const oneRM = r.one_rep_max ?? calc1RM(r.weight, r.reps);
          const dateLabel = new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          const existing = byDate.get(dateStr);
          if (existing) {
            byDate.set(dateStr, {
              date: dateStr,
              dateLabel: existing.dateLabel,
              heaviestWeight: Math.max(existing.heaviestWeight, r.weight),
              totalVolume: existing.totalVolume + r.weight * r.reps,
              estimated1RM: Math.max(existing.estimated1RM, Math.round(oneRM)),
            });
          } else {
            byDate.set(dateStr, {
              date: dateStr,
              dateLabel,
              heaviestWeight: r.weight,
              totalVolume: r.weight * r.reps,
              estimated1RM: Math.round(oneRM),
            });
          }
        });
        const merged = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
        setWorkoutSummaries(merged);

        const historyRows = await db.getAllAsync<{
          log_date: string;
          weight: number | null;
          reps: number | null;
          one_rep_max: number | null;
        }>(
          'SELECT log_date, weight, reps, one_rep_max FROM StrengthRecords WHERE exercise_name = ? ORDER BY log_date DESC;',
          [exerciseName]
        );
        setExerciseHistory(
          historyRows
            .filter((r) => r.weight != null && r.reps != null)
            .map((r) => ({
              log_date: r.log_date,
              weight: r.weight!,
              reps: r.reps!,
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
    setLogEntryDate(new Date().toISOString().slice(0, 10));
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
    const date = logEntryDate || new Date().toISOString().slice(0, 10);
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
      await checkWeightLossCelebration(db);
    } catch (e) {
      console.error('Save body log:', e);
    }
  };

  const saveCardMetrics = async () => {
    const date = new Date().toISOString().slice(0, 10);
    const weight = cardWeight.trim() ? parseFloat(cardWeight) : null;
    const muscle = cardMuscle.trim() ? parseFloat(cardMuscle) : null;
    const bone = cardBone.trim() ? parseFloat(cardBone) : null;
    const water = cardWater.trim() ? parseFloat(cardWater) : null;
    const fat = cardFat.trim() ? parseFloat(cardFat) : null;
    const bmi = cardBmi.trim() ? parseFloat(cardBmi) : null;
    if (weight == null && muscle == null && bone == null && water == null && fat == null && bmi == null) return;
    try {
      await db.runAsync(
        `INSERT INTO BodyMetrics (log_date, weight, muscle_mass, bone_mass, body_water, body_fat, bmi, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [date, weight, muscle, bone, water, fat, bmi, latestBody?.notes ?? null]
      );
      loadBody();
      await checkWeightLossCelebration(db);
    } catch (e) {
      console.error('Save card metrics:', e);
    }
  };

  const openEditBodyLog = async (row: BodyMetricRow) => {
    setEditingBodyLog(row);
    setEditLogDate(row.log_date);
    setLogWeight(row.weight != null ? String(row.weight) : '');
    setLogMuscle(row.muscle_mass != null ? String(row.muscle_mass) : '');
    setLogBone(row.bone_mass != null ? String(row.bone_mass) : '');
    setLogWater(row.body_water != null ? String(row.body_water) : '');
    setLogFat(row.body_fat != null ? String(row.body_fat) : '');
    setLogNotes(row.notes ?? '');
    setLogEntryDate(row.log_date);
    const h = await AsyncStorage.getItem(USER_HEIGHT_KEY);
    if (h) setUserHeightInches(h);
  };

  const updateBodyLog = async () => {
    if (!editingBodyLog) return;
    const weight = logWeight.trim() ? parseFloat(logWeight) : null;
    const muscle = logMuscle.trim() ? parseFloat(logMuscle) : null;
    const bone = logBone.trim() ? parseFloat(logBone) : null;
    const water = logWater.trim() ? parseFloat(logWater) : null;
    const fat = logFat.trim() ? parseFloat(logFat) : null;
    let bmi: number | null = null;
    if (weight != null && userHeightInches) {
      const hi = parseFloat(userHeightInches);
      if (hi > 0) bmi = (weight / (hi * hi)) * 703;
    } else if (editingBodyLog.bmi != null) {
      bmi = editingBodyLog.bmi;
    }
    try {
      const dateToSave = editLogDate || editingBodyLog.log_date;
      await db.runAsync(
        `UPDATE BodyMetrics SET log_date = ?, weight = ?, muscle_mass = ?, bone_mass = ?, body_water = ?, body_fat = ?, bmi = ?, notes = ? WHERE metric_id = ?`,
        [dateToSave, weight, muscle, bone, water, fat, bmi, logNotes.trim() || null, editingBodyLog.metric_id]
      );
      setEditingBodyLog(null);
      loadBody();
    } catch (e) {
      console.error('Update body log:', e);
    }
  };

  const deleteBodyLog = (row: BodyMetricRow) => {
    Alert.alert(
      'Delete weight log?',
      `This will permanently delete the log for ${new Date(row.log_date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await db.runAsync('DELETE FROM BodyMetrics WHERE metric_id = ?', [row.metric_id]);
              setEditingBodyLog(null);
              loadBody();
            } catch (e) {
              console.error('Delete body log:', e);
            }
          },
        },
      ]
    );
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
      <View style={styles.weeklySummaryRow}>
        <TouchableOpacity
          style={[styles.weeklySummaryButton, { backgroundColor: SAGE }]}
          onPress={handleOpenWeeklySummary}
          activeOpacity={0.85}
        >
          <Ionicons name="sparkles-outline" size={18} color="#FFFFFF" style={styles.weeklySummaryIcon} />
          <Text style={styles.weeklySummaryButtonText}>Weekly Summary</Text>
        </TouchableOpacity>
      </View>

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
                { label: 'Weight (lbs)', value: cardWeight, setValue: setCardWeight },
                { label: 'Muscle Mass (%)', value: cardMuscle, setValue: setCardMuscle },
                { label: 'Bone Mass (%)', value: cardBone, setValue: setCardBone },
                { label: 'Body Water (%)', value: cardWater, setValue: setCardWater },
                { label: 'Body Fat (%)', value: cardFat, setValue: setCardFat },
                { label: 'BMI', value: cardBmi, setValue: setCardBmi },
              ].map((item, i) => (
                <View
                  key={i}
                  style={[
                    styles.statCard,
                    { backgroundColor: theme.card, borderLeftColor: SAGE },
                  ]}
                >
                  <Text style={[styles.statLabel, { color: theme.textSecondary }]}>{item.label}</Text>
                  <TextInput
                    style={[styles.statValue, styles.statInput, { color: theme.text }]}
                    value={item.value}
                    onChangeText={item.setValue}
                    onBlur={saveCardMetrics}
                    placeholder="—"
                    placeholderTextColor={theme.textSecondary}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                    underlineColorAndroid="transparent"
                  />
                </View>
              ))}
            </View>
          )}

          {(startingWeight || startingDate || currentWeight != null) && (
            <View style={[styles.startingRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
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

          <Text style={[styles.sectionHeader, { color: SAGE, marginTop: 24 }]}>MY BODY · THIS WEEK</Text>
          {bodyHistoryThisWeek.length > 0 ? (
            <View style={[styles.logList, { borderColor: theme.border }]}>
              {bodyHistoryThisWeek.map((row) => (
                <BodyLogSwipeRow
                  key={row.metric_id}
                  row={row}
                  theme={theme}
                  onEdit={() => openEditBodyLog(row)}
                  onDelete={() => deleteBodyLog(row)}
                />
              ))}
            </View>
          ) : (
            <Text style={[styles.emptyChart, { color: theme.textSecondary, marginTop: 4 }]}>No entries this week.</Text>
          )}
          <TouchableOpacity
            style={[styles.linkButton, { marginTop: 12 }]}
            onPress={() => navigation.navigate('BodyWeightLogs')}
          >
            <Text style={[styles.linkButtonText, { color: SAGE }]}>View all weight logs →</Text>
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
              chartConfig={chartConfig(theme)}
              bezier
              style={[styles.chart, { backgroundColor: theme.background }]}
              withInnerLines={true}
              withOuterLines={true}
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
              {(() => {
                const len = workoutSummaries.length;
                const heaviest = len === 0 ? null : workoutSummaries.reduce((best, w) => (w.heaviestWeight > best.heaviestWeight ? w : best), workoutSummaries[0]!);
                const latest = len === 0 ? null : workoutSummaries[len - 1]!;
                const estimatedMax = len === 0 ? null : workoutSummaries.reduce((best, w) => (w.estimated1RM > best.estimated1RM ? w : best), workoutSummaries[0]!);
                return (
                  <View style={styles.metricTilesRow}>
                    <TouchableOpacity
                      style={[styles.metricTile, { backgroundColor: theme.card, borderColor: theme.border }]}
                      onPress={() => setMetricDetailModal('heaviest')}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.metricTileTitle, { color: theme.textSecondary }]}>Heaviest Weight</Text>
                      <Text style={[styles.metricTileValue, { color: theme.text }]}>
                        {heaviest != null ? `${heaviest.heaviestWeight} lb` : '—'}
                      </Text>
                      <Text style={[styles.metricTileSub, { color: theme.textSecondary }]}>
                        {heaviest != null ? `Last: ${heaviest.dateLabel}` : 'No data'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.metricTile, { backgroundColor: theme.card, borderColor: theme.border }]}
                      onPress={() => setMetricDetailModal('volume')}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.metricTileTitle, { color: theme.textSecondary }]}>Total Volume</Text>
                      <Text style={[styles.metricTileValue, { color: theme.text }]}>
                        {latest != null ? `${latest.totalVolume.toLocaleString()} lb` : '—'}
                      </Text>
                      <Text style={[styles.metricTileSub, { color: theme.textSecondary }]}>
                        {latest != null ? `Last: ${latest.dateLabel}` : 'No data'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.metricTile, { backgroundColor: theme.card, borderColor: theme.border }]}
                      onPress={() => setMetricDetailModal('estimated1RM')}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.metricTileTitle, { color: theme.textSecondary }]}>Estimated Max</Text>
                      <Text style={[styles.metricTileValue, { color: theme.text }]}>
                        {estimatedMax != null ? `${estimatedMax.estimated1RM} lb` : '—'}
                      </Text>
                      <Text style={[styles.metricTileSub, { color: theme.textSecondary }]}>
                        {estimatedMax != null ? `Last: ${estimatedMax.dateLabel}` : 'No data'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })()}
              <Text style={[styles.sectionHeader, { color: SAGE, marginTop: 16 }]}>PR History</Text>
              {exerciseHistory.length === 0 ? (
                <Text style={[styles.emptyChart, { color: theme.textSecondary }]}>PRs are recorded from your logged workouts.</Text>
              ) : (
                <>
                  {(() => {
                    const currentPR = exerciseHistory.reduce((best, h) => (h.one_rep_max > best.one_rep_max ? h : best), exerciseHistory[0]!);
                    return (
                      <View style={[styles.historyRow, { backgroundColor: theme.card, borderLeftColor: SAGE }]}>
                        <Text style={[styles.historyDate, { color: theme.text }]}>Current PR</Text>
                        <Text style={[styles.historyDetail, { color: theme.text }]}>
                          {currentPR.weight} × {currentPR.reps} — Est. 1RM: {Math.round(currentPR.one_rep_max)}
                        </Text>
                      </View>
                    );
                  })()}
                  <TouchableOpacity
                    onPress={() => selectedExercise && navigation.navigate('WeightLogDetail', { workoutName: selectedExercise })}
                    style={styles.viewLogHistoryLink}
                  >
                    <Text style={[styles.viewLogHistoryText, { color: SAGE }]}>View log history</Text>
                  </TouchableOpacity>
                </>
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
                      style={[styles.strengthCard, { backgroundColor: theme.card, borderLeftColor: SAGE }]}
                      onPress={() => openExerciseDetail(item.exercise_name)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.strengthCardLeft}>
                        <Text style={[styles.strengthName, { color: theme.text }]} numberOfLines={1}>
                          {item.exercise_name}
                        </Text>
                        <Text style={[styles.strengthSub, { color: theme.textSecondary }]}>
                          {item.maxWeight === 0 && item.oneRM === 0
                            ? 'No data yet'
                            : `Heaviest: ${item.maxWeight} lb · Est. Max: ${item.oneRM} lb`}
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
          <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <View style={styles.modalKeyboardAvoiding}>
            <View
              style={[
                styles.modalBox,
                styles.modalBoxBodyLog,
                { backgroundColor: theme.card, paddingBottom: 0 },
              ]}
            >
              <View style={styles.modalHeaderRow}>
                <Text style={[styles.modalTitle, styles.modalTitleFlex, { color: theme.text }]}>Log MyBody metrics</Text>
                <TouchableOpacity onPress={Keyboard.dismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel="Dismiss keyboard">
                  <Text style={[styles.modalDoneText, { color: SAGE }]}>Done</Text>
                </TouchableOpacity>
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator
                style={{ maxHeight: bodyLogModalScrollMax }}
                contentContainerStyle={styles.modalScrollContent}
              >
                <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
                  <View>
                    <Text style={[styles.modalHint, { color: theme.textSecondary }]}>
                      {logEntryDate
                        ? `Logging for ${new Date(logEntryDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}. Enter what your scale shows — no date input needed.`
                        : 'Enter what your scale shows. Not all fields required.'}
                    </Text>
                  </View>
                </TouchableWithoutFeedback>
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
                  placeholder="Muscle mass (%)"
                  placeholderTextColor={theme.textSecondary}
                  value={logMuscle}
                  onChangeText={setLogMuscle}
                  keyboardType="decimal-pad"
                />
                <TextInput
                  style={[styles.input, { borderColor: theme.border, color: theme.text }]}
                  placeholder="Bone mass (%)"
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
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={Keyboard.dismiss}
                />
                <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
                  <View style={styles.modalTapBelowInputs} />
                </TouchableWithoutFeedback>
              </ScrollView>
              <View
                style={[
                  styles.modalButtons,
                  styles.modalButtonsSticky,
                  styles.modalButtonsBodyLogFooter,
                  { paddingBottom: bodyLogKeyboardInset },
                ]}
              >
                <TouchableOpacity
                  style={[styles.modalButton, { borderColor: theme.border }]}
                  onPress={() => {
                    Keyboard.dismiss();
                    setLogModalVisible(false);
                  }}
                >
                  <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, { backgroundColor: SAGE }]}
                  onPress={() => {
                    Keyboard.dismiss();
                    saveBodyLog();
                  }}
                >
                  <Text style={styles.modalButtonTextWhite}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={editingBodyLog != null} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <KeyboardAvoidingView
            behavior="padding"
            keyboardVerticalOffset={Platform.OS === 'ios' ? Math.max(insets.top, 12) : 0}
            style={styles.modalKeyboardAvoiding}
          >
            <View style={[styles.modalBox, styles.modalBoxBodyLog, { backgroundColor: theme.card }]}>
              <View style={styles.modalHeaderRow}>
                <Text style={[styles.modalTitle, styles.modalTitleFlex, { color: theme.text }]}>Edit weight log</Text>
                <TouchableOpacity onPress={Keyboard.dismiss} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel="Dismiss keyboard">
                  <Text style={[styles.modalDoneText, { color: SAGE }]}>Done</Text>
                </TouchableOpacity>
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                showsVerticalScrollIndicator
                style={{ maxHeight: bodyLogModalScrollMax }}
                contentContainerStyle={styles.modalScrollContent}
              >
                <TouchableOpacity
                  style={[styles.input, { borderColor: theme.border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }]}
                  onPress={() => {
                    Keyboard.dismiss();
                    setShowEditDatePicker(true);
                  }}
                >
                  <Text style={[styles.modalHint, { color: theme.text, marginBottom: 0 }]}>
                    {editLogDate
                      ? new Date(editLogDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                      : 'Tap to pick date'}
                  </Text>
                  <Ionicons name="calendar-outline" size={20} color={theme.textSecondary} />
                </TouchableOpacity>
                {showEditDatePicker && Platform.OS === 'android' && (
                  <DateTimePicker
                    value={editLogDate ? new Date(editLogDate + 'T12:00:00') : new Date()}
                    mode="date"
                    display="default"
                    onChange={(_, date) => {
                      if (date) setEditLogDate(date.toISOString().slice(0, 10));
                      setShowEditDatePicker(false);
                    }}
                    maximumDate={new Date()}
                  />
                )}
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
                  placeholder="Muscle mass (%)"
                  placeholderTextColor={theme.textSecondary}
                  value={logMuscle}
                  onChangeText={setLogMuscle}
                  keyboardType="decimal-pad"
                />
                <TextInput
                  style={[styles.input, { borderColor: theme.border, color: theme.text }]}
                  placeholder="Bone mass (%)"
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
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={Keyboard.dismiss}
                />
                <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
                  <View style={styles.modalTapBelowInputs} />
                </TouchableWithoutFeedback>
              </ScrollView>
              {showEditDatePicker && Platform.OS === 'ios' && (
                <Modal visible transparent animationType="slide">
                  <TouchableOpacity style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }} activeOpacity={1} onPress={() => setShowEditDatePicker(false)}>
                    <View style={[styles.modalBox, { backgroundColor: theme.card, paddingBottom: 24 }]} onStartShouldSetResponder={() => true}>
                      <TouchableOpacity onPress={() => setShowEditDatePicker(false)} style={{ alignSelf: 'flex-end', padding: 16 }}>
                        <Text style={{ color: SAGE, fontWeight: '600' }}>Done</Text>
                      </TouchableOpacity>
                      <DateTimePicker
                        value={editLogDate ? new Date(editLogDate + 'T12:00:00') : new Date()}
                        mode="date"
                        display="spinner"
                        onChange={(_, date) => {
                          if (date) setEditLogDate(date.toISOString().slice(0, 10));
                        }}
                        maximumDate={new Date()}
                      />
                    </View>
                  </TouchableOpacity>
                </Modal>
              )}
              <View style={[styles.modalButtons, styles.modalButtonsSticky]}>
                <TouchableOpacity
                  style={[styles.modalButton, { borderColor: theme.border }]}
                  onPress={() => {
                    Keyboard.dismiss();
                    setEditingBodyLog(null);
                  }}
                >
                  <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, { backgroundColor: SAGE }]}
                  onPress={() => {
                    Keyboard.dismiss();
                    updateBodyLog();
                  }}
                >
                  <Text style={styles.modalButtonTextWhite}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Metric detail: chart + history for Heaviest / Volume / Estimated Max */}
      <Modal visible={metricDetailModal != null} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.metricDetailBox, { backgroundColor: theme.background }]}>
            <View style={styles.metricDetailHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>
                {metricDetailModal === 'heaviest' ? 'Heaviest Weight' : metricDetailModal === 'volume' ? 'Total Volume' : 'Estimated Max'}
              </Text>
              <TouchableOpacity onPress={() => setMetricDetailModal(null)} hitSlop={12}>
                <Text style={[styles.modalTitle, { color: SAGE }]}>Done</Text>
              </TouchableOpacity>
            </View>
            {workoutSummaries.length > 0 && metricDetailModal != null && (
              <>
                <View style={styles.chartWrapModal}>
                  <LineChart
                    data={{
                      labels: workoutSummaries.map((w) => w.dateLabel),
                      datasets: [{
                        data: metricDetailModal === 'heaviest'
                          ? workoutSummaries.map((w) => w.heaviestWeight)
                          : metricDetailModal === 'volume'
                            ? workoutSummaries.map((w) => w.totalVolume)
                            : workoutSummaries.map((w) => w.estimated1RM),
                      }],
                    }}
                    width={chartWidthModal}
                    height={200}
                    chartConfig={chartConfig(theme)}
                    bezier
                    style={[styles.chart, { backgroundColor: theme.background }]}
                    withInnerLines={true}
                    withOuterLines={true}
                    fromZero
                  />
                </View>
                <Text style={[styles.sectionHeader, { color: SAGE, marginTop: 12, marginBottom: 8 }]}>History</Text>
                <ScrollView style={styles.metricDetailHistory} showsVerticalScrollIndicator={false}>
                  {(metricDetailModal === 'heaviest'
                    ? [...workoutSummaries].reverse()
                    : metricDetailModal === 'volume'
                      ? [...workoutSummaries].reverse()
                      : [...workoutSummaries].reverse()
                  ).map((w, i) => (
                    <View key={`${w.date}-${i}`} style={[styles.historyRow, { backgroundColor: theme.card, borderLeftColor: SAGE }]}>
                      <Text style={[styles.historyDate, { color: theme.text }]}>{w.dateLabel}</Text>
                      <Text style={[styles.historyDetail, { color: theme.text }]}>
                        {metricDetailModal === 'heaviest'
                          ? `${w.heaviestWeight} lb`
                          : metricDetailModal === 'volume'
                            ? `${w.totalVolume.toLocaleString()} lb`
                            : `${w.estimated1RM} lb`}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              </>
            )}
            {workoutSummaries.length === 0 && (
              <Text style={[styles.emptyChart, { color: theme.textSecondary }]}>No workout data yet.</Text>
            )}
          </View>
        </View>
      </Modal>

      <Modal
        visible={weeklySummaryVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setWeeklySummaryVisible(false)}
      >
        <View style={styles.weeklySummaryModalOverlay}>
          <TouchableOpacity
            style={styles.weeklySummaryModalBackdrop}
            activeOpacity={1}
            onPress={() => setWeeklySummaryVisible(false)}
          />
          <View style={[styles.weeklySummaryModalSheet, { backgroundColor: WEEKLY_SUMMARY_MODAL_BG, borderColor: SAGE }]}>
            <View style={styles.weeklySummaryModalHeader}>
              <Text style={[styles.weeklySummaryModalTitle, { color: SAGE }]}>Weekly Summary</Text>
              <TouchableOpacity
                onPress={() => setWeeklySummaryVisible(false)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityLabel="Close weekly summary"
              >
                <Ionicons name="close-circle" size={28} color={SAGE} />
              </TouchableOpacity>
            </View>
            {weeklySummaryLoading ? (
              <ActivityIndicator size="large" color={SAGE} style={styles.weeklySummarySpinner} />
            ) : weeklySummaryError ? (
              <Text style={[styles.weeklySummaryErrorText, { color: '#2C2C2C' }]}>{weeklySummaryError}</Text>
            ) : (
              <ScrollView
                style={styles.weeklySummaryScroll}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.weeklySummaryBodyText}>{weeklySummaryText}</Text>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  weeklySummaryRow: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  weeklySummaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  weeklySummaryIcon: { marginRight: 8 },
  weeklySummaryButtonText: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  weeklySummaryModalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  weeklySummaryModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  weeklySummaryModalSheet: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '78%',
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    zIndex: 1,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
  },
  weeklySummaryModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  weeklySummaryModalTitle: {
    fontFamily: 'CormorantGaramond-Bold',
    fontSize: 24,
  },
  weeklySummarySpinner: { paddingVertical: 32 },
  weeklySummaryScroll: { maxHeight: 420 },
  weeklySummaryBodyText: {
    fontFamily: 'CormorantGaramond-Regular',
    fontSize: 18,
    lineHeight: 28,
    color: '#2C2C2C',
  },
  weeklySummaryErrorText: {
    fontFamily: 'Jost_400Regular',
    fontSize: 15,
    lineHeight: 22,
    paddingVertical: 16,
  },
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
  statInput: {
    padding: 0,
    margin: 0,
    borderWidth: 0,
    minHeight: 24,
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
  logList: {
    borderWidth: 1,
    borderRadius: 10,
    marginTop: 8,
    overflow: 'hidden',
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  logRowMain: { flex: 1 },
  logRowDate: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 14,
  },
  logRowSummary: {
    fontFamily: 'Jost_400Regular',
    fontSize: 12,
    marginTop: 2,
  },
  logRowActions: { flexDirection: 'row', gap: 8 },
  logRowBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  logRowBtnText: { fontFamily: 'Jost_500Medium', fontSize: 13 },
  logRowBtnDanger: { borderColor: '#C0392B' },
  logRowBtnTextDanger: { fontFamily: 'Jost_500Medium', fontSize: 13, color: '#C0392B' },
  swipeEditBtn: { backgroundColor: '#E67E22', justifyContent: 'center', alignItems: 'center', width: 72 },
  swipeDeleteBtn: { backgroundColor: '#C0392B', justifyContent: 'center', alignItems: 'center', width: 72 },
  swipeBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  linkButton: { paddingVertical: 8, paddingHorizontal: 4, alignSelf: 'flex-start' },
  linkButtonText: { fontFamily: 'Jost_500Medium', fontSize: 15 },
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
  metricTilesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 16,
  },
  metricTile: {
    flex: 1,
    minWidth: '30%',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  metricTileTitle: {
    fontFamily: 'Jost_500Medium',
    fontSize: 12,
    marginBottom: 4,
  },
  metricTileValue: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 18,
  },
  metricTileSub: {
    fontFamily: 'Jost_400Regular',
    fontSize: 11,
    marginTop: 4,
  },
  metricDetailBox: {
    maxHeight: '85%',
    padding: 20,
    borderRadius: 16,
    overflow: 'hidden',
  },
  chartWrapModal: {
    overflow: 'hidden',
    marginVertical: 8,
    borderRadius: 12,
  },
  metricDetailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  metricDetailHistory: {
    maxHeight: 240,
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
  viewLogHistoryLink: {
    paddingVertical: 10,
    paddingHorizontal: 4,
    marginTop: 4,
  },
  viewLogHistoryText: {
    fontFamily: 'Jost_500Medium',
    fontSize: 15,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  modalKeyboardAvoiding: {
    width: '100%',
    maxWidth: '100%',
    zIndex: 1,
  },
  modalBox: {
    borderRadius: 16,
    padding: 24,
    maxHeight: '80%',
  },
  /** MyBody log / edit: column layout; Edit modal may still use KeyboardAvoidingView */
  modalBoxBodyLog: {
    maxHeight: '88%',
    width: '100%',
    paddingBottom: 16,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  modalTitleFlex: {
    flex: 1,
    marginBottom: 0,
  },
  modalDoneText: {
    fontFamily: 'Jost_600SemiBold',
    fontSize: 16,
  },
  modalScrollContent: {
    flexGrow: 0,
    paddingBottom: 4,
  },
  modalTapBelowInputs: {
    minHeight: 72,
  },
  modalButtonsSticky: {
    marginTop: 8,
    paddingHorizontal: 0,
  },
  /** Log MyBody: no extra gap above keyboard — only keyboard height as bottom padding on the row */
  modalButtonsBodyLogFooter: {
    marginTop: 4,
    marginBottom: 0,
    paddingTop: 0,
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
    paddingHorizontal: 16,
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
