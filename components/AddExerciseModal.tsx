import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../context/ThemeContext';
import { validateRepsOrDurationInput } from '../utils/exerciseTrackingUtils';

export type AddExerciseFormValues = {
  name: string;
  sets: string;
  reps: string;
  durationSeconds: string;
};

type AddExerciseModalProps = {
  visible: boolean;
  isStrength: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSave: (values: AddExerciseFormValues) => void | Promise<void>;
};

export function AddExerciseModal({
  visible,
  isStrength,
  isSaving,
  onClose,
  onSave,
}: AddExerciseModalProps) {
  const { theme } = useTheme();
  const { t } = useTranslation();

  const [name, setName] = useState('');
  const [sets, setSets] = useState('3');
  const [reps, setReps] = useState('10');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setName('');
      setSets('3');
      setReps('10');
      setDurationSeconds('');
      setFieldError(null);
    }
  }, [visible]);

  const handleSavePress = () => {
    if (isStrength) {
      const tracking = validateRepsOrDurationInput(reps, durationSeconds);
      if (!tracking.ok) {
        setFieldError(tracking.message);
        return;
      }
    }
    setFieldError(null);
    void onSave({ name, sets, reps, durationSeconds });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {visible ? (
        <StatusBar
          backgroundColor={theme.type === 'light' ? 'rgba(0, 0, 0, 0.5)' : 'black'}
          barStyle="light-content"
        />
      ) : null}
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPressOut={onClose}>
        <View
          style={[styles.modalContainer, { backgroundColor: theme.card, borderColor: theme.border }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              {t('addExerciseFromDetails')}
            </Text>
            <TouchableOpacity
              onPress={onClose}
              style={styles.modalCloseButton}
              disabled={isSaving}
              accessibilityLabel="Close"
            >
              <Ionicons name="close-outline" size={28} color={theme.text} />
            </TouchableOpacity>
          </View>
          <View style={styles.formBody}>
            <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>{t('exerciseNameLabel')}</Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: theme.card,
                  color: theme.text,
                  borderColor: theme.border,
                },
              ]}
              value={name}
              onChangeText={setName}
              placeholder={t('exerciseNameLabel')}
              placeholderTextColor={
                theme.type === 'dark' ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)'
              }
              autoCapitalize="words"
              editable={!isSaving}
            />
            <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>{t('setsLabel')}</Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: theme.card,
                  color: theme.text,
                  borderColor: theme.border,
                  marginBottom: isStrength ? 12 : 16,
                },
              ]}
              value={sets}
              onChangeText={setSets}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={3}
              editable={!isSaving}
            />
            {isStrength && (
              <>
                <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>{t('repsLabel')}</Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.card,
                      color: theme.text,
                      borderColor: theme.border,
                    },
                  ]}
                  value={reps}
                  onChangeText={setReps}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={4}
                  editable={!isSaving}
                />
                <Text style={[styles.inputLabel, { color: theme.textSecondary }]}>Duration (sec)</Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: theme.card,
                      color: theme.text,
                      borderColor: theme.border,
                      marginBottom: fieldError ? 8 : 16,
                    },
                  ]}
                  value={durationSeconds}
                  onChangeText={setDurationSeconds}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  maxLength={5}
                  editable={!isSaving}
                />
              </>
            )}
            {fieldError ? (
              <Text style={[styles.fieldError, { color: '#C0392B' }]}>{fieldError}</Text>
            ) : null}
            <TouchableOpacity
              style={[
                styles.saveButton,
                {
                  backgroundColor: theme.buttonBackground,
                  opacity: isSaving ? 0.6 : 1,
                },
              ]}
              onPress={handleSavePress}
              disabled={isSaving}
              activeOpacity={0.85}
            >
              {isSaving ? (
                <ActivityIndicator color={theme.buttonText} />
              ) : (
                <Text style={[styles.saveButtonText, { color: theme.buttonText }]}>{t('Save')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContainer: {
    width: '90%',
    maxHeight: '70%',
    flexDirection: 'column',
    borderRadius: 15,
    borderWidth: 1,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingBottom: 15,
    width: '100%',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    flex: 1,
    marginRight: 8,
  },
  modalCloseButton: {
    padding: 5,
    alignSelf: 'flex-start',
  },
  formBody: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  inputLabel: {
    fontSize: 14,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 12,
  },
  saveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  fieldError: {
    fontSize: 13,
    marginBottom: 12,
    lineHeight: 18,
  },
});
