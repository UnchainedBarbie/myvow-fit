import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTheme } from '../context/ThemeContext';

const SAGE = '#7C9A7E';

/** User-selectable categories when creating a vow (stored comma-separated in DB). */
export const WRITE_CATEGORY_OPTIONS = [
  'NervousSystem',
  'Nutrition',
  'BodyCare',
  'Mindset',
  'Sleep',
  'Movement',
  'Recovery',
  'Fitness',
] as const;

/** Friendly labels for chips. */
export const CATEGORY_DISPLAY_LABELS: Record<string, string> = {
  NervousSystem: 'Nervous system & stress',
  Nutrition: 'Nutrition & gut',
  BodyCare: 'Body care',
  Mindset: 'Mindset',
  Sleep: 'Sleep',
  Movement: 'Movement',
  Recovery: 'Recovery',
  Fitness: 'Fitness',
};

export function sortWriteCategories(cats: string[]): string[] {
  const uniq = [...new Set(cats)];
  return uniq.sort(
    (a, b) =>
      WRITE_CATEGORY_OPTIONS.indexOf(a as (typeof WRITE_CATEGORY_OPTIONS)[number]) -
      WRITE_CATEGORY_OPTIONS.indexOf(b as (typeof WRITE_CATEGORY_OPTIONS)[number]),
  );
}

export type CreateOwnVowSubmitPayload = {
  title: string;
  categoryCsv: string;
  frequencyPerWeek: number;
  whyText: string | null;
};

type CreateOwnVowModalProps = {
  visible: boolean;
  /** Pre-fills "Your vow" when the modal opens (e.g. from Sage or a suggested vow). */
  initialVowText?: string;
  /** Pre-select categories (e.g. suggested vow group id). Omit for default Movement. Pass [] for no selection (e.g. Help me decide). */
  initialCategories?: string[];
  onClose: () => void;
  onSubmit: (payload: CreateOwnVowSubmitPayload) => Promise<void>;
};

export function CreateOwnVowModal({
  visible,
  initialVowText,
  initialCategories,
  onClose,
  onSubmit,
}: CreateOwnVowModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  const [writeText, setWriteText] = useState('');
  const [writeWhy, setWriteWhy] = useState('');
  const [writeCategories, setWriteCategories] = useState<string[]>(['Movement']);
  const [writeFrequency, setWriteFrequency] = useState<string>('3');
  const [writeKeyboardHeight, setWriteKeyboardHeight] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) {
      setWriteKeyboardHeight(0);
      return;
    }
    setWriteText((initialVowText ?? '').trim());
    setWriteWhy('');
    if (initialCategories === undefined) {
      setWriteCategories(['Movement']);
    } else if (initialCategories.length === 0) {
      setWriteCategories([]);
    } else {
      setWriteCategories(sortWriteCategories(initialCategories));
    }
    setWriteFrequency('3');
  }, [visible, initialVowText, initialCategories]);

  useEffect(() => {
    if (!visible) return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvent, (e) => {
      setWriteKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const onHide = Keyboard.addListener(hideEvent, () => setWriteKeyboardHeight(0));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, [visible]);

  const toggleWriteCategory = useCallback((c: string) => {
    setWriteCategories((prev) => {
      if (prev.includes(c)) {
        if (prev.length <= 1) return prev;
        return sortWriteCategories(prev.filter((x) => x !== c));
      }
      return sortWriteCategories([...prev, c]);
    });
  }, []);

  const handleSave = async () => {
    if (!writeText.trim()) return;
    if (writeCategories.length === 0) {
      Alert.alert('Category', 'Select at least one category.');
      return;
    }
    const freq = Math.max(0, parseInt(writeFrequency, 10) || 0);
    const categoryCsv = sortWriteCategories(writeCategories).join(',');
    const why = writeWhy.trim() ? writeWhy.trim() : null;
    setSaving(true);
    try {
      await onSubmit({
        title: writeText.trim(),
        categoryCsv,
        frequencyPerWeek: freq,
        whyText: why,
      });
      onClose();
    } catch (e) {
      console.error('CreateOwnVowModal save error:', e);
      Alert.alert(
        'Could not save vow',
        e instanceof Error ? e.message : 'Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.writeModalRoot, { backgroundColor: theme.background }]}
      >
        <View
          style={[
            styles.writeModalInner,
            { paddingTop: insets.top + 8, paddingBottom: 0 },
          ]}
        >
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Create your own vow</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12} disabled={saving}>
              <Ionicons name="close" size={24} color={theme.text} />
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.writeModalScroll}
            contentContainerStyle={{
              paddingHorizontal: 4,
              paddingBottom: 24 + writeKeyboardHeight + Math.max(insets.bottom, 8),
              flexGrow: 1,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            showsVerticalScrollIndicator
          >
            <Text style={[styles.label, { color: theme.text }]}>Your vow</Text>
            <TextInput
              style={[styles.input, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]}
              value={writeText}
              onChangeText={setWriteText}
              placeholder="e.g. Move for 30 minutes this week"
              placeholderTextColor="#888"
              multiline
              editable={!saving}
            />
            <Text style={[styles.label, { color: theme.text }]}>Why</Text>
            <Text style={[styles.labelHint, { color: theme.textSecondary }]}>
              What matters about this promise? (Optional — helps you stay connected when it gets hard.)
            </Text>
            <TextInput
              style={[styles.input, styles.whyInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]}
              value={writeWhy}
              onChangeText={setWriteWhy}
              placeholder="e.g. I feel calmer when I move, and I want to trust myself again."
              placeholderTextColor="#888"
              multiline
              textAlignVertical="top"
              editable={!saving}
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
              editable={!saving}
            />
            <Text style={[styles.label, { color: theme.text }]}>Categories</Text>
            <Text style={[styles.labelHint, { color: theme.textSecondary }]}>
              Select all that apply (e.g. Movement and Mindset).
            </Text>
            <View style={styles.categoryRow}>
              {WRITE_CATEGORY_OPTIONS.map((c) => {
                const selected = writeCategories.includes(c);
                return (
                  <TouchableOpacity
                    key={c}
                    style={[styles.categoryChip, selected && { backgroundColor: SAGE }, { borderColor: theme.border }]}
                    onPress={() => toggleWriteCategory(c)}
                    disabled={saving}
                  >
                    <Text style={[styles.categoryChipText, { color: selected ? '#fff' : theme.text }]}>
                      {CATEGORY_DISPLAY_LABELS[c] ?? c}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <View
            style={[
              styles.writeModalFooter,
              {
                borderTopColor: theme.border,
                backgroundColor: theme.background,
                paddingBottom: Math.max(16, insets.bottom),
              },
            ]}
          >
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: SAGE, opacity: saving ? 0.65 : 1 }]}
              onPress={() => void handleSave()}
              disabled={saving}
            >
              <Text style={styles.saveBtnText}>{saving ? 'Saving…' : 'Save vow'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  writeModalRoot: { flex: 1 },
  writeModalInner: { flex: 1, paddingHorizontal: 20 },
  writeModalScroll: { flex: 1 },
  writeModalFooter: {
    paddingHorizontal: 0,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  whyInput: { minHeight: 100, marginBottom: 16 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', flex: 1 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 6 },
  labelHint: { fontSize: 12, marginBottom: 8, lineHeight: 16 },
  input: { borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16, minHeight: 80, marginBottom: 16 },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  categoryChip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  categoryChipText: { fontSize: 14 },
  saveBtn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '700' },
});
