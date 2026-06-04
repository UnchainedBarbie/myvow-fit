import React from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useTheme } from '../context/ThemeContext';

export type ChoiceListOption = {
  key: string;
  label: string;
  onPress: () => void;
};

type ChoiceListModalProps = {
  visible: boolean;
  title: string;
  message?: string;
  options: ChoiceListOption[];
  cancelLabel?: string;
  onCancel: () => void;
};

/**
 * Vertical list of primary actions with a separated outlined Cancel below.
 * Matches GenerateWorkoutModal / MealPlanList copy-schedule cancel styling.
 */
export function ChoiceListModal({
  visible,
  title,
  message,
  options,
  cancelLabel = 'Cancel',
  onCancel,
}: ChoiceListModalProps) {
  const { theme } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableWithoutFeedback onPress={onCancel}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                },
              ]}
            >
              <View style={styles.headerRow}>
                <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
                <TouchableOpacity
                  onPress={onCancel}
                  hitSlop={12}
                  accessibilityLabel={cancelLabel}
                  accessibilityRole="button"
                >
                  <Ionicons name="close" size={24} color={theme.text} />
                </TouchableOpacity>
              </View>
              {message ? (
                <Text style={[styles.message, { color: theme.textSecondary ?? theme.text }]}>
                  {message}
                </Text>
              ) : null}
              <View style={styles.optionsBlock}>
                {options.map((opt) => (
                  <TouchableOpacity
                    key={opt.key}
                    style={[
                      styles.optionButton,
                      { backgroundColor: theme.buttonBackground },
                    ]}
                    onPress={() => {
                      onCancel();
                      opt.onPress();
                    }}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.optionButtonText, { color: theme.buttonText }]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity
                style={[
                  styles.cancelButton,
                  {
                    borderColor: theme.border,
                    backgroundColor: theme.card,
                  },
                ]}
                onPress={onCancel}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={cancelLabel}
              >
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>
                  {cancelLabel}
                </Text>
              </TouchableOpacity>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    marginRight: 8,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
    opacity: 0.9,
  },
  optionsBlock: {
    width: '100%',
    gap: 8,
  },
  optionButton: {
    width: '100%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  optionButtonText: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  cancelButton: {
    width: '100%',
    marginTop: 14,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
