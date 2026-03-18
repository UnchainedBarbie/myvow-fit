import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from 'react-i18next';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { getClaudeApiKey } from '../utils/claudeApiKeyStorage';
import { generateWorkoutWithAI, insertAIWorkout } from '../utils/generateWorkoutWithAI';
import type { SQLiteDatabase } from 'expo-sqlite';

type GenerateWorkoutModalProps = {
  visible: boolean;
  onClose: () => void;
  db: SQLiteDatabase;
  onSuccess: () => Promise<void>;
};

export default function GenerateWorkoutModal({
  visible,
  onClose,
  db,
  onSuccess,
}: GenerateWorkoutModalProps) {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (!loading) {
      setDescription('');
      setError(null);
      onClose();
    }
  };

  const handleGenerate = async () => {
    console.log('Generate button pressed');
    const trimmed = description.trim();
    if (!trimmed) {
      setError(t('aiWorkoutDescribeRequired') || 'Please describe the workout you want.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const apiKey = await getClaudeApiKey();
      const masked =
        apiKey && apiKey.length > 4
          ? apiKey.slice(0, -4).replace(/./g, '*') + apiKey.slice(-4)
          : apiKey || null;
      console.log('Claude API key loaded (masked):', masked);
      if (!apiKey) {
        setError(t('aiWorkoutApiKeyRequired') || 'Set your Claude API key in Settings first.');
        setLoading(false);
        return;
      }
      const workout = await generateWorkoutWithAI(apiKey, trimmed);
      await insertAIWorkout(db, workout);
      await onSuccess();
      handleClose();
    } catch (e) {
      console.log('Modal error:', e);
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={[styles.overlay, { backgroundColor: 'rgba(0, 0, 0, 0.5)' }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.modalBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.text }]}>{t('aiWorkoutTitle')}</Text>
            <TouchableOpacity onPress={handleClose} disabled={loading} hitSlop={12}>
              <Ionicons name="close" size={28} color={theme.text} />
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.hint, { color: theme.text }]}>
              {t('aiWorkoutHint')}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: theme.background,
                  color: theme.text,
                  borderColor: theme.border,
                },
              ]}
              placeholder={t('aiWorkoutPlaceholder')}
              placeholderTextColor={theme.text}
              value={description}
              onChangeText={(text) => { setDescription(text); setError(null); }}
              multiline
              numberOfLines={4}
              editable={!loading}
            />
            {error ? (
              <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
            ) : null}
            <TouchableOpacity
              style={[
                styles.generateButton,
                { backgroundColor: theme.buttonBackground },
                loading && styles.generateButtonDisabled,
              ]}
              onPress={handleGenerate}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={theme.buttonText} size="small" />
              ) : (
                <>
                  <Ionicons name="sparkles" size={22} color={theme.buttonText} style={styles.buttonIcon} />
                  <Text style={[styles.generateButtonText, { color: theme.buttonText }]}>
                    {t('aiWorkoutGenerate')}
                  </Text>
                </>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cancelButton, { borderColor: theme.border }]}
              onPress={handleClose}
              disabled={loading}
            >
              <Text style={[styles.cancelButtonText, { color: theme.text }]}>{t('alertCancel')}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalBox: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
  },
  scroll: {
    maxHeight: 400,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  hint: {
    fontSize: 14,
    marginBottom: 12,
    opacity: 0.9,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  errorText: {
    fontSize: 14,
    marginTop: 10,
    opacity: 0.9,
  },
  generateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    marginTop: 20,
  },
  generateButtonDisabled: {
    opacity: 0.7,
  },
  buttonIcon: {
    marginRight: 8,
  },
  generateButtonText: {
    fontSize: 18,
    fontWeight: '700',
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

