/**
 * Full list of body weight logs (BodyMetrics) with edit/delete.
 * Navigated to from My Progress → My Body → "View all weight logs".
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
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSQLiteContext } from 'expo-sqlite';
import { useTheme } from '../context/ThemeContext';
import Ionicons from 'react-native-vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SAGE = '#7C9A7E';
const USER_HEIGHT_KEY = '@user_height_inches';

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

export default function BodyWeightLogs() {
  const db = useSQLiteContext();
  const navigation = useNavigation();
  const { theme } = useTheme();
  const [logs, setLogs] = useState<BodyMetricRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingLog, setEditingLog] = useState<BodyMetricRow | null>(null);
  const [editLogDate, setEditLogDate] = useState<string>('');
  const [showEditDatePicker, setShowEditDatePicker] = useState(false);
  const [logWeight, setLogWeight] = useState('');
  const [logMuscle, setLogMuscle] = useState('');
  const [logBone, setLogBone] = useState('');
  const [logWater, setLogWater] = useState('');
  const [logFat, setLogFat] = useState('');
  const [logNotes, setLogNotes] = useState('');
  const [userHeightInches, setUserHeightInches] = useState('');

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await db.getAllAsync<BodyMetricRow>(
        'SELECT * FROM BodyMetrics ORDER BY log_date DESC;'
      );
      setLogs(rows);
    } catch (e) {
      console.error('Load body logs:', e);
    } finally {
      setLoading(false);
    }
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      loadLogs();
    }, [loadLogs])
  );

  const openEdit = async (row: BodyMetricRow) => {
    setEditingLog(row);
    setEditLogDate(row.log_date);
    setLogWeight(row.weight != null ? String(row.weight) : '');
    setLogMuscle(row.muscle_mass != null ? String(row.muscle_mass) : '');
    setLogBone(row.bone_mass != null ? String(row.bone_mass) : '');
    setLogWater(row.body_water != null ? String(row.body_water) : '');
    setLogFat(row.body_fat != null ? String(row.body_fat) : '');
    setLogNotes(row.notes ?? '');
    const h = await AsyncStorage.getItem(USER_HEIGHT_KEY);
    if (h) setUserHeightInches(h);
  };

  const updateLog = async () => {
    if (!editingLog) return;
    const weight = logWeight.trim() ? parseFloat(logWeight) : null;
    const muscle = logMuscle.trim() ? parseFloat(logMuscle) : null;
    const bone = logBone.trim() ? parseFloat(logBone) : null;
    const water = logWater.trim() ? parseFloat(logWater) : null;
    const fat = logFat.trim() ? parseFloat(logFat) : null;
    let bmi: number | null = null;
    if (weight != null && userHeightInches) {
      const hi = parseFloat(userHeightInches);
      if (hi > 0) bmi = (weight / (hi * hi)) * 703;
    } else if (editingLog.bmi != null) {
      bmi = editingLog.bmi;
    }
    try {
      const dateToSave = editLogDate || editingLog.log_date;
      await db.runAsync(
        `UPDATE BodyMetrics SET log_date = ?, weight = ?, muscle_mass = ?, bone_mass = ?, body_water = ?, body_fat = ?, bmi = ?, notes = ? WHERE metric_id = ?`,
        [dateToSave, weight, muscle, bone, water, fat, bmi, logNotes.trim() || null, editingLog.metric_id]
      );
      setEditingLog(null);
      loadLogs();
    } catch (e) {
      console.error('Update body log:', e);
    }
  };

  const deleteLog = (row: BodyMetricRow) => {
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
              setEditingLog(null);
              loadLogs();
            } catch (e) {
              console.error('Delete body log:', e);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={SAGE} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>All weight logs</Text>
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={SAGE} style={{ marginTop: 24 }} />
      ) : logs.length === 0 ? (
        <Text style={[styles.empty, { color: theme.textSecondary }]}>No weight logs yet. Log from My Body.</Text>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {logs.map((row) => (
            <View key={row.metric_id} style={[styles.row, { borderColor: theme.border }]}>
              <View style={styles.rowMain}>
                <Text style={[styles.rowDate, { color: theme.text }]}>
                  {new Date(row.log_date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                </Text>
                <Text style={[styles.rowSummary, { color: theme.textSecondary }]}>
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
              <View style={styles.rowActions}>
                <TouchableOpacity onPress={() => openEdit(row)} style={[styles.btn, { borderColor: theme.border }]}>
                  <Text style={[styles.btnText, { color: theme.text }]}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => deleteLog(row)} style={[styles.btn, styles.btnDanger]}>
                  <Text style={styles.btnTextDanger}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={editingLog != null} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={[styles.modalBox, { backgroundColor: theme.card }]}
          >
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <View style={{ flex: 1 }}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Edit weight log</Text>
            <TouchableOpacity
              style={[styles.input, { borderColor: theme.border, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }]}
              onPress={() => setShowEditDatePicker(true)}
            >
              <Text style={[styles.modalHint, { color: theme.text, marginBottom: 0 }]}>
                {editLogDate
                  ? new Date(editLogDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                  : 'Tap to pick date'}
              </Text>
              <Ionicons name="calendar-outline" size={20} color={theme.textSecondary} />
            </TouchableOpacity>
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
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalBtn, { borderColor: theme.border }]} onPress={() => setEditingLog(null)}>
                <Text style={[styles.modalBtnText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, { backgroundColor: SAGE }]} onPress={updateLog}>
                <Text style={styles.modalBtnTextWhite}>Save</Text>
              </TouchableOpacity>
            </View>
              </View>
            </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.08)' },
  backBtn: { padding: 4, marginRight: 8 },
  title: { fontFamily: 'Jost_600SemiBold', fontSize: 18 },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  empty: { textAlign: 'center', marginTop: 24, fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, marginBottom: 10 },
  rowMain: { flex: 1 },
  rowDate: { fontFamily: 'Jost_600SemiBold', fontSize: 14 },
  rowSummary: { fontFamily: 'Jost_400Regular', fontSize: 12, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 8 },
  btn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
  btnText: { fontFamily: 'Jost_500Medium', fontSize: 13 },
  btnDanger: { borderColor: '#C0392B' },
  btnTextDanger: { fontFamily: 'Jost_500Medium', fontSize: 13, color: '#C0392B' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  modalBox: { borderRadius: 16, padding: 20, maxHeight: '80%' },
  modalTitle: { fontFamily: 'Jost_600SemiBold', fontSize: 18, marginBottom: 4 },
  modalHint: { fontFamily: 'Jost_400Regular', fontSize: 13, marginBottom: 16, color: '#666' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, fontFamily: 'Jost_400Regular', fontSize: 16 },
  modalButtons: { flexDirection: 'row', gap: 12, marginTop: 16, paddingHorizontal: 16 },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  modalBtnText: { fontFamily: 'Jost_600SemiBold', fontSize: 15 },
  modalBtnTextWhite: { fontFamily: 'Jost_600SemiBold', fontSize: 15, color: '#FFFFFF' },
});
