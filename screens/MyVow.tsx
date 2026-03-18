/**
 * MyVow Fit: Daily commitment dashboard.
 * Vows are promises to yourself. Tone: supportive, calm, motivating.
 * - Top: Title, Sage card, "Generate with Sage" / "Create my own vow"
 * - This Week's Vows: modern cards (Workout, Nutrition, Movement)
 * - Progress: circular rings (Workout, Nutrition, Activity, Hydration) always visible
 * - History: past vows and streaks
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
  Alert,
  Share,
  ActivityIndicator,
  Dimensions,
  Keyboard,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { initVowsDb, type VowRow, type VowCheckInRow } from '../utils/initVowsDb';

const SAGE = '#7C9A7E';
const SAGE_LIGHT = 'rgba(124, 154, 126, 0.15)';
const CREAM = '#FDF8F0';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const RING_SIZE = (SCREEN_WIDTH - 32 - 24) / 4 - 8; // 4 rings with gap

// Suggested vows by category: Mindset first, then Movement, Nutrition, Recovery
const SUGGESTED_VOW_CATEGORIES = ['Mindset', 'Movement', 'Nutrition', 'Recovery'] as const;
type SuggestedCategory = (typeof SUGGESTED_VOW_CATEGORIES)[number];

const SUGGESTED_VOWS: Record<SuggestedCategory, string[]> = {
  Movement: [
    'Move my body 3 times this week',
    'Take a 20 minute walk when I feel stressed',
    'Stretch for 10 minutes twice this week',
  ],
  Nutrition: [
    'Eat protein with every meal',
    'Drink water before coffee',
    'Cook one nourishing meal this week',
  ],
  Recovery: [
    'Sleep 7+ hours three nights this week',
    'Take one full rest day',
    'Spend 10 minutes outside',
  ],
  Mindset: [
    'Love myself even when I miss a workout',
    'Speak to my body with kindness',
    'Celebrate effort, not perfection',
    'Rest when my body asks for it',
  ],
};

function todayYmd() {
  return new Date().toISOString().split('T')[0];
}

// Selectable suggested vow card: vow text, category label, Add Vow button
function SuggestedVowCard({
  text,
  category,
  theme,
  onAddVow,
}: {
  text: string;
  category: SuggestedCategory;
  theme: any;
  onAddVow: () => void;
}) {
  return (
    <View style={[styles.suggestedVowCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={styles.suggestedVowCardBody}>
        <Text style={[styles.suggestedVowCardCategory, { color: SAGE }]}>
          {category === 'Mindset' ? 'Mindset / Self-Compassion' : category}
        </Text>
        <Text style={[styles.suggestedVowCardText, { color: theme.text }]}>{text}</Text>
      </View>
      <TouchableOpacity
        style={[styles.suggestedVowCardButton, { backgroundColor: SAGE }]}
        onPress={onAddVow}
        activeOpacity={0.85}
      >
        <Text style={styles.suggestedVowCardButtonText}>Add Vow</Text>
      </TouchableOpacity>
    </View>
  );
}

// Circular progress ring (0–100). Always visible. Uses SVG for a proper arc.
function ProgressRingSvg({ progress, label, color, theme }: { progress: number; label: string; color: string; theme: any }) {
  const p = Math.min(100, Math.max(0, progress));
  const stroke = 5;
  const size = RING_SIZE;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference - (p / 100) * circumference;
  return (
    <View style={[styles.ringWrapper, { width: size + 2 }]}>
      <View style={{ width: size, height: size, position: 'relative' }}>
        <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
          <Circle cx={cx} cy={cx} r={r} stroke={SAGE_LIGHT} strokeWidth={stroke} fill="transparent" />
          <Circle
            cx={cx}
            cy={cx}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            fill="transparent"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
          />
        </Svg>
        <View style={[StyleSheet.absoluteFill, styles.ringCenter]}>
          <Text style={[styles.ringPercent, { color: theme.text }]}>{p}%</Text>
        </View>
      </View>
      <Text style={[styles.ringLabel, { color: theme.text }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export default function MyVow() {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const navigation = useNavigation<any>();

  const [activeVows, setActiveVows] = useState<VowRow[]>([]);
  const [completedVows, setCompletedVows] = useState<VowRow[]>([]);
  const [brokenVows, setBrokenVows] = useState<VowRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [suggestedModalVisible, setSuggestedModalVisible] = useState(false);
  const [writeModalVisible, setWriteModalVisible] = useState(false);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [selectedVow, setSelectedVow] = useState<VowRow | null>(null);
  const [checkIns, setCheckIns] = useState<VowCheckInRow[]>([]);

  const [writeText, setWriteText] = useState('');
  const [writeCategory, setWriteCategory] = useState<string>('Movement');
  const [writeFrequency, setWriteFrequency] = useState<string>('3');

  const [historyCollapsed, setHistoryCollapsed] = useState(true);
  const [weeklyReport, setWeeklyReport] = useState<
    { vow_id: number; title: string; frequency: number; actual: number; met: boolean }[]
  >([]);

  const loadWeeklyReport = useCallback(
    async (allVows: VowRow[]) => {
      // Current week Monday–Sunday
      const today = new Date();
      const day = today.getDay(); // 0 = Sun, 1 = Mon
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(today);
      monday.setDate(today.getDate() + mondayOffset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const weekStart = monday.toISOString().slice(0, 10);
      const weekEnd = sunday.toISOString().slice(0, 10);

      const rows = await db.getAllAsync<{ vow_id: number; count: number }>(
        'SELECT vow_id, COUNT(*) as count FROM VowCheckIns WHERE check_in_date BETWEEN ? AND ? GROUP BY vow_id',
        [weekStart, weekEnd]
      );
      const map = new Map<number, number>();
      rows.forEach((r) => map.set(r.vow_id, r.count));

      const report = allVows
        .filter((v) => (v.frequency_per_week ?? 0) > 0)
        .map((v) => {
          const freq = v.frequency_per_week ?? 0;
          const actual = map.get(v.vow_id) ?? 0;
          return {
            vow_id: v.vow_id,
            title: v.title,
            frequency: freq,
            actual,
            met: actual >= freq,
          };
        });
      setWeeklyReport(report);
    },
    [db],
  );

  const loadVows = useCallback(async () => {
    await initVowsDb(db);
    const all = await db.getAllAsync<VowRow>(
      'SELECT vow_id, title, category, frequency_per_week, status, created_at, completed_at, broken_at FROM Vows ORDER BY created_at DESC'
    );
    setActiveVows(all.filter((v) => v.status === 'active'));
    setCompletedVows(all.filter((v) => v.status === 'completed'));
    setBrokenVows(all.filter((v) => v.status === 'broken'));
    await loadWeeklyReport(all);
    setLoading(false);
  }, [db, loadWeeklyReport]);

  useFocusEffect(
    useCallback(() => {
      loadVows();
    }, [loadVows])
  );

  const loadCheckIns = useCallback(
    async (vowId: number) => {
      const rows = await db.getAllAsync<VowCheckInRow>(
        'SELECT check_in_id, vow_id, check_in_date, kept, note, created_at FROM VowCheckIns WHERE vow_id = ? ORDER BY check_in_date DESC',
        [vowId]
      );
      setCheckIns(rows);
    },
    [db]
  );

  const openDetail = (vow: VowRow) => {
    setSelectedVow(vow);
    setDetailModalVisible(true);
    loadCheckIns(vow.vow_id);
  };

  const addVow = async (title: string, category: string, frequencyPerWeek: number = 3) => {
    const now = new Date().toISOString();
    await db.runAsync(
      'INSERT INTO Vows (title, category, frequency_per_week, status, created_at) VALUES (?, ?, ?, ?, ?)',
      [title.trim(), category, frequencyPerWeek, 'active', now]
    );
    await loadVows();
  };

  const markCompleted = async (vow: VowRow) => {
    const now = new Date().toISOString();
    await db.runAsync('UPDATE Vows SET status = ?, completed_at = ? WHERE vow_id = ?', ['completed', now, vow.vow_id]);
    await loadVows();
  };

  const markPaused = async (vow: VowRow) => {
    const now = new Date().toISOString();
    await db.runAsync('UPDATE Vows SET status = ?, broken_at = ? WHERE vow_id = ?', ['broken', now, vow.vow_id]);
    await loadVows();
    setDetailModalVisible(false);
    setSelectedVow(null);
    Alert.alert('Vow paused', 'This vow has been moved to your history.');
  };

  const checkInToday = async (vow: VowRow) => {
    const date = todayYmd();
    const now = new Date().toISOString();
    const existing = await db.getAllAsync<{ check_in_id: number }>(
      'SELECT check_in_id FROM VowCheckIns WHERE vow_id = ? AND check_in_date = ?',
      [vow.vow_id, date]
    );
    if (existing.length > 0) {
      Alert.alert('Already checked in', "You've already logged a check-in for today.");
      return;
    }
    await db.runAsync(
      'INSERT INTO VowCheckIns (vow_id, check_in_date, kept, created_at) VALUES (?, ?, 1, ?)',
      [vow.vow_id, date, now]
    );
    loadCheckIns(vow.vow_id);
    Alert.alert('Check-in logged', 'Your check-in for this vow has been recorded.');
  };

  const deleteCheckIn = async (checkInId: number, vowId: number) => {
    Alert.alert(
      'Delete check-in?',
      'This will remove this check-in from your history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await db.runAsync('DELETE FROM VowCheckIns WHERE check_in_id = ?', [checkInId]);
            await loadCheckIns(vowId);
          },
        },
      ],
    );
  };

  const shareVow = async (vow: VowRow) => {
    try {
      await Share.share({ message: `My vow: ${vow.title}`, title: 'MyVow Fit' });
    } catch (e) {
      if ((e as any)?.message !== 'User did not share') Alert.alert('Error', 'Could not open share.');
    }
  };

  const deleteVow = async (vow: VowRow) => {
    await db.runAsync('DELETE FROM VowCheckIns WHERE vow_id = ?', [vow.vow_id]);
    await db.runAsync('DELETE FROM Vows WHERE vow_id = ?', [vow.vow_id]);
    await loadVows();
    setDetailModalVisible(false);
    setSelectedVow(null);
  };

  const confirmComplete = (vow: VowRow) => {
    Alert.alert('Complete vow?', `Mark "${vow.title}" as kept?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Complete', onPress: () => markCompleted(vow) },
    ]);
  };

  const confirmPause = (vow: VowRow) => {
    Alert.alert('Pause this vow?', 'Sage can help you reflect when you’re ready.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Pause', onPress: () => markPaused(vow) },
    ]);
  };

  // Open write modal with suggestion pre-filled so user can edit before saving
  const openAddSuggestedVow = (title: string, category: string) => {
    setWriteText(title);
    setWriteCategory(category);
    setWriteFrequency('3');
    setSuggestedModalVisible(false);
    setWriteModalVisible(true);
  };

  const saveWriteOwn = () => {
    if (!writeText.trim()) return;
    const freq = Math.max(0, parseInt(writeFrequency, 10) || 0);
    addVow(writeText.trim(), writeCategory, freq);
    setWriteText('');
    setWriteCategory('Movement');
    setWriteFrequency('3');
    setWriteModalVisible(false);
  };

  const openSageForVows = () => {
    navigation.navigate('Sage', {
      initialPrompt: "I'd like to create this week's vows. Help me with a workout focus and nutrition focus for this week—keep it simple and doable.",
      fromMyVow: true,
    });
  };

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background || CREAM }]}>
        <ActivityIndicator size="large" color={SAGE} />
      </View>
    );
  }

  const fitnessVows = activeVows.filter((v) => v.category === 'Fitness');
  const movementVows = activeVows.filter((v) => v.category === 'Movement');
  const nutritionVows = activeVows.filter((v) => v.category === 'Nutrition');
  const recoveryVows = activeVows.filter((v) => v.category === 'Recovery');
  const mindsetVows = activeVows.filter((v) => v.category === 'Mindset');
  const otherVows = activeVows.filter(
    (v) => !['Fitness', 'Movement', 'Nutrition', 'Recovery', 'Mindset'].includes(v.category)
  );
  const historyCount = completedVows.length + brokenVows.length;

  return (
    <View style={[styles.container, { backgroundColor: theme.background || CREAM }]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Sage card */}
        <View style={[styles.sageCard, { backgroundColor: SAGE_LIGHT, borderColor: SAGE }]}>
          <View style={styles.sageCardHeader}>
            <View style={[styles.sageAvatar, { backgroundColor: SAGE }]}>
              <Ionicons name="sparkles" size={22} color="#fff" />
            </View>
            <Text style={[styles.sageName, { color: theme.text }]}>Sage</Text>
          </View>
          <Text style={[styles.sageMessage, { color: theme.text }]}>
            Ready to create this week's vows? I can suggest a workout and nutrition focus—or you can write your own promise.
          </Text>
          <View style={styles.ctaRow}>
            <TouchableOpacity style={[styles.ctaPrimary, { backgroundColor: SAGE }]} onPress={openSageForVows}>
              <Ionicons name="sparkles" size={18} color="#fff" />
              <Text style={styles.ctaPrimaryText}>Generate with Sage</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.ctaSecondary, { borderColor: SAGE }]} onPress={() => setWriteModalVisible(true)}>
              <Ionicons name="create-outline" size={18} color={SAGE} />
              <Text style={[styles.ctaSecondaryText, { color: SAGE }]}>Create my own vow</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.ctaSecondary, { borderColor: SAGE }]} onPress={() => setSuggestedModalVisible(true)}>
              <Ionicons name="list-outline" size={18} color={SAGE} />
              <Text style={[styles.ctaSecondaryText, { color: SAGE }]}>Suggested vows</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* This Week's Vows */}
        <Text style={[styles.sectionTitle, { color: theme.text }]}>This Week's Vows</Text>

        {activeVows.length === 0 ? (
          <View style={[styles.placeholderCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.placeholderText, { color: theme.text }]}>
              No vows yet. Create a promise to yourself above—or let Sage suggest one.
            </Text>
            <TouchableOpacity style={[styles.placeholderBtn, { backgroundColor: SAGE_LIGHT }]} onPress={() => setWriteModalVisible(true)}>
              <Text style={[styles.placeholderBtnText, { color: SAGE }]}>Create my first vow</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {fitnessVows.map((vow) => (
              <VowCard
                key={vow.vow_id}
                vow={vow}
                theme={theme}
                icon="barbell-outline"
                subtitle="Workout"
                actionLabel="Check in"
                onPress={() => openDetail(vow)}
                onAction={() => checkInToday(vow)}
              />
            ))}
            {movementVows.map((vow) => (
              <VowCard
                key={vow.vow_id}
                vow={vow}
                theme={theme}
                icon="walk-outline"
                subtitle="Movement"
                actionLabel="Check in"
                onPress={() => openDetail(vow)}
                onAction={() => checkInToday(vow)}
              />
            ))}
            {nutritionVows.map((vow) => (
              <VowCard
                key={vow.vow_id}
                vow={vow}
                theme={theme}
                icon="nutrition-outline"
                subtitle="Nutrition"
                actionLabel="Check in"
                onPress={() => openDetail(vow)}
                onAction={() => checkInToday(vow)}
              />
            ))}
            {recoveryVows.map((vow) => (
              <VowCard
                key={vow.vow_id}
                vow={vow}
                theme={theme}
                icon="moon-outline"
                subtitle="Recovery"
                actionLabel="Check in"
                onPress={() => openDetail(vow)}
                onAction={() => checkInToday(vow)}
              />
            ))}
            {mindsetVows.map((vow) => (
              <VowCard
                key={vow.vow_id}
                vow={vow}
                theme={theme}
                icon="heart-outline"
                subtitle="Mindset"
                actionLabel="Check in"
                onPress={() => openDetail(vow)}
                onAction={() => checkInToday(vow)}
              />
            ))}
            {otherVows.map((vow) => (
              <VowCard
                key={vow.vow_id}
                vow={vow}
                theme={theme}
                icon="heart-outline"
                subtitle={vow.category}
                actionLabel="Check in"
                onPress={() => openDetail(vow)}
                onAction={() => checkInToday(vow)}
              />
            ))}
          </>
        )}

        {/* Weekly report */}
        <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 24 }]}>This Week's Report</Text>
        {weeklyReport.length === 0 ? (
          <Text style={[styles.hint, { color: theme.text }]}>
            Set a weekly frequency on your vows to see a report here.
          </Text>
        ) : (
          <View style={[styles.historyCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {weeklyReport.map((row) => (
              <View key={row.vow_id} style={[styles.historyRow, { borderColor: theme.border }]}>
                <Text style={[styles.historyRowTitle, { color: theme.text }]} numberOfLines={2}>
                  {row.title}
                </Text>
                <Text
                  style={[
                    styles.historyRowDate,
                    { color: row.met ? '#2ECC71' : '#C0392B', fontWeight: '600' },
                  ]}
                >
                  {row.actual}/{row.frequency}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* History */}
        <TouchableOpacity
          style={[styles.historyHeader, { borderColor: theme.border }]}
          onPress={() => setHistoryCollapsed(!historyCollapsed)}
        >
          <Text style={[styles.sectionTitle, { color: theme.text }]}>History</Text>
          <Text style={[styles.historyMeta, { color: theme.text }]}>
            {historyCount > 0 ? `${completedVows.length} kept · ${brokenVows.length} paused` : 'No history yet'}
          </Text>
          <Ionicons name={historyCollapsed ? 'chevron-down' : 'chevron-up'} size={20} color={theme.text} />
        </TouchableOpacity>
        {!historyCollapsed && (
          <View style={[styles.historyCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            {completedVows.length === 0 && brokenVows.length === 0 ? (
              <Text style={[styles.hint, { color: theme.text }]}>When you keep or pause a vow, it will show here.</Text>
            ) : (
              <>
                {completedVows.slice(0, 7).map((v) => (
                  <TouchableOpacity key={v.vow_id} style={[styles.historyRow, { borderColor: theme.border }]} onPress={() => openDetail(v)}>
                    <Ionicons name="checkmark-circle" size={20} color={SAGE} />
                    <Text style={[styles.historyRowTitle, { color: theme.text }]}>{v.title}</Text>
                    <Text style={[styles.historyRowDate, { color: theme.text }]}>{v.completed_at?.slice(0, 10)}</Text>
                  </TouchableOpacity>
                ))}
                {brokenVows.slice(0, 5).map((v) => (
                  <TouchableOpacity key={v.vow_id} style={[styles.historyRow, { borderColor: theme.border }]} onPress={() => openDetail(v)}>
                    <Ionicons name="pause-circle-outline" size={20} color="#888" />
                    <Text style={[styles.historyRowTitle, { color: theme.text }]}>{v.title}</Text>
                    <Text style={[styles.historyRowDate, { color: theme.text }]}>{v.broken_at?.slice(0, 10)}</Text>
                  </TouchableOpacity>
                ))}
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* Suggested Vows modal: cards by category with Add Vow */}
      <Modal visible={suggestedModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: theme.background }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Suggested vows</Text>
              <TouchableOpacity onPress={() => setSuggestedModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.text} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.suggestedIntro, { color: theme.text }]}>
              Supportive ideas for movement, nutrition, recovery, and self-compassion. Tap Add Vow to use one—you can edit it before saving.
            </Text>
            <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
              {SUGGESTED_VOW_CATEGORIES.map((cat) => (
                <View key={cat} style={styles.suggestedCategory}>
                  <Text style={[styles.suggestedSectionHeader, { color: SAGE }]}>
                    {cat === 'Mindset' ? 'Mindset / Self-Compassion' : cat}
                  </Text>
                  {SUGGESTED_VOWS[cat].map((title, i) => (
                    <SuggestedVowCard
                      key={`${cat}-${i}`}
                      text={title}
                      category={cat}
                      theme={theme}
                      onAddVow={() => openAddSuggestedVow(title, cat)}
                    />
                  ))}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={writeModalVisible} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.modalOverlay}>
              <View style={[styles.modalBox, { backgroundColor: theme.background }]}>
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, { color: theme.text }]}>Create your own vow</Text>
                  <TouchableOpacity onPress={() => setWriteModalVisible(false)}>
                    <Ionicons name="close" size={24} color={theme.text} />
                  </TouchableOpacity>
                </View>
                <ScrollView
                  style={{ maxHeight: 420 }}
                  contentContainerStyle={{ paddingBottom: 20 }}
                  keyboardShouldPersistTaps="handled"
                >
              <Text style={[styles.label, { color: theme.text }]}>Your vow</Text>
              <TextInput
                style={[styles.input, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]}
                value={writeText}
                onChangeText={setWriteText}
                placeholder="e.g. Move for 30 minutes this week"
                placeholderTextColor="#888"
                multiline
              />
              <Text style={[styles.label, { color: theme.text }]}>Times per week (goal)</Text>
              <TextInput
                style={[
                  styles.input,
                  { backgroundColor: theme.card, color: theme.text, borderColor: theme.border, minHeight: 0 },
                ]}
                value={writeFrequency}
                onChangeText={setWriteFrequency}
                placeholder="e.g. 3"
                placeholderTextColor="#888"
                keyboardType="number-pad"
              />
              <Text style={[styles.label, { color: theme.text }]}>Category</Text>
                  <View style={styles.categoryRow}>
                    {(['Movement', 'Nutrition', 'Recovery', 'Mindset'] as const).map((c) => (
                      <TouchableOpacity
                        key={c}
                        style={[styles.categoryChip, writeCategory === c && { backgroundColor: SAGE }, { borderColor: theme.border }]}
                        onPress={() => setWriteCategory(c)}
                      >
                        <Text style={[styles.categoryChipText, { color: writeCategory === c ? '#fff' : theme.text }]}>
                          {c === 'Mindset' ? 'Mindset' : c}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
                <TouchableOpacity style={[styles.saveBtn, { backgroundColor: SAGE }]} onPress={saveWriteOwn}>
                  <Text style={styles.saveBtnText}>Save vow</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={detailModalVisible} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: theme.background }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]} numberOfLines={1}>{selectedVow?.title}</Text>
              <TouchableOpacity onPress={() => { setDetailModalVisible(false); setSelectedVow(null); }}>
                <Ionicons name="close" size={24} color={theme.text} />
              </TouchableOpacity>
            </View>
            {selectedVow && (
              <>
                <Text style={[styles.detailMeta, { color: theme.text }]}>{selectedVow.category} · {selectedVow.status}</Text>
                {selectedVow.status === 'active' && (
                  <View style={styles.detailActions}>
                    <TouchableOpacity style={[styles.detailBtn, { backgroundColor: SAGE }]} onPress={() => checkInToday(selectedVow)}>
                      <Text style={styles.detailBtnText}>I kept this this week</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.detailBtn, styles.detailBtnOutline, { borderColor: theme.border }]} onPress={() => confirmPause(selectedVow)}>
                      <Text style={[styles.detailBtnText, { color: theme.text }]}>Pause this vow</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.detailBtn, styles.detailBtnOutline, { borderColor: theme.border }]} onPress={() => shareVow(selectedVow)}>
                      <Ionicons name="share-outline" size={18} color={theme.text} />
                      <Text style={[styles.detailBtnText, { color: theme.text }]}> Share</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <Text style={[styles.label, { color: theme.text }]}>Check-ins</Text>
                {checkIns.length === 0 ? (
                  <Text style={[styles.hint, { color: theme.text }]}>No check-ins yet.</Text>
                ) : (
                  checkIns.slice(0, 14).map((c) => (
                    <View key={c.check_in_id} style={[styles.checkInRow, { borderColor: theme.border }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.checkInDate, { color: theme.text }]}>{c.check_in_date}</Text>
                        <Text style={[styles.checkInKept, { color: c.kept ? SAGE : '#888' }]}>{c.kept ? 'Kept' : 'Missed'}</Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => deleteCheckIn(c.check_in_id, selectedVow.vow_id)}
                        style={{ paddingHorizontal: 8, paddingVertical: 4 }}
                      >
                        <Text style={{ color: '#C0392B', fontSize: 12 }}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}
                <TouchableOpacity
                  style={[styles.detailBtn, styles.detailBtnOutline, { borderColor: '#C0392B', marginTop: 16 }]}
                  onPress={() => {
                    Alert.alert('Delete vow?', 'This cannot be undone.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => deleteVow(selectedVow) },
                    ]);
                  }}
                >
                  <Text style={[styles.detailBtnText, { color: '#C0392B' }]}>Delete vow</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function VowCard({
  vow,
  theme,
  icon,
  subtitle,
  actionLabel,
  onPress,
  onAction,
}: {
  vow: VowRow;
  theme: any;
  icon: string;
  subtitle: string;
  actionLabel: string;
  onPress: () => void;
  onAction: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.vowCard, { backgroundColor: theme.card, borderColor: theme.border }]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.vowCardTop}>
        <View style={[styles.vowCardIconWrap, { backgroundColor: SAGE_LIGHT }]}>
          <Ionicons name={icon as any} size={24} color={SAGE} />
        </View>
        <View style={styles.vowCardBody}>
          <Text style={[styles.vowCardSubtitle, { color: SAGE }]}>{subtitle}</Text>
          <Text style={[styles.vowCardTitle, { color: theme.text }]} numberOfLines={2}>{vow.title}</Text>
        </View>
      </View>
      <TouchableOpacity style={[styles.vowCardAction, { backgroundColor: SAGE }]} onPress={(e) => { e.stopPropagation(); onAction(); }}>
        <Text style={styles.vowCardActionText}>{actionLabel}</Text>
        <Ionicons name="chevron-forward" size={16} color="#fff" />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  sageCard: {
    padding: 18,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 24,
  },
  sageCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  sageAvatar: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  sageName: { fontSize: 16, fontWeight: '700' },
  sageMessage: { fontSize: 15, lineHeight: 22, opacity: 0.9, marginBottom: 16 },
  ctaRow: { gap: 10 },
  ctaPrimary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 14, gap: 8 },
  ctaPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  ctaSecondary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 14, borderWidth: 2, gap: 8 },
  ctaSecondaryText: { fontWeight: '600', fontSize: 15 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  placeholderCard: {
    padding: 24,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 16,
    alignItems: 'center',
  },
  placeholderText: { fontSize: 15, textAlign: 'center', opacity: 0.85, marginBottom: 16 },
  placeholderBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 14 },
  placeholderBtnText: { fontWeight: '600', fontSize: 15 },
  vowCard: {
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 12,
  },
  vowCardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  vowCardIconWrap: { width: 48, height: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  vowCardBody: { flex: 1 },
  vowCardSubtitle: { fontSize: 12, fontWeight: '700', marginBottom: 4 },
  vowCardTitle: { fontSize: 16, fontWeight: '600' },
  vowCardAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 12, gap: 6 },
  vowCardActionText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  ringWrapper: { alignItems: 'center' },
  ringCenter: { justifyContent: 'center', alignItems: 'center' },
  ringPercent: { fontSize: 11, fontWeight: '700' },
  ringLabel: { fontSize: 10, marginTop: 6, textAlign: 'center' },
  historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, marginTop: 8 },
  historyMeta: { fontSize: 13, opacity: 0.8 },
  historyCard: { padding: 12, borderRadius: 16, borderWidth: 1, marginTop: 8, marginBottom: 16 },
  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1 },
  historyRowTitle: { flex: 1, fontSize: 15, marginLeft: 10 },
  historyRowDate: { fontSize: 12, opacity: 0.7 },
  hint: { fontSize: 14, opacity: 0.8, marginBottom: 8 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalBox: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '85%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', flex: 1 },
  modalScroll: { maxHeight: 420 },
  suggestedIntro: { fontSize: 14, lineHeight: 20, opacity: 0.9, marginBottom: 16 },
  suggestedCategory: { marginBottom: 24 },
  suggestedSectionHeader: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  suggestedVowCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
  },
  suggestedVowCardBody: { marginBottom: 14 },
  suggestedVowCardCategory: { fontSize: 12, fontWeight: '700', marginBottom: 6 },
  suggestedVowCardText: { fontSize: 15, lineHeight: 22 },
  suggestedVowCardButton: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  suggestedVowCardButtonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  categoryLabel: { fontSize: 14, fontWeight: '700', marginBottom: 8 },
  suggestedItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderRadius: 10, borderWidth: 1, marginBottom: 8 },
  suggestedItemText: { fontSize: 15 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16, minHeight: 80, marginBottom: 16 },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  categoryChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  categoryChipText: { fontSize: 14 },
  saveBtn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '700' },
  detailMeta: { fontSize: 13, opacity: 0.8, marginBottom: 12 },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  detailBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 },
  detailBtnOutline: { backgroundColor: 'transparent', borderWidth: 1 },
  detailBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  checkInRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1 },
  checkInDate: { fontSize: 14 },
  checkInKept: { fontSize: 14, fontWeight: '600' },
});
