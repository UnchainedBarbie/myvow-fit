/**
 * Profile state and modal. Loads user_profile_photo on mount; provides
 * profilePhotoUri, setProfilePhotoUri, and openProfileModal for headers.
 * Includes Sage context and Favorite foods (moved from Settings).
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
  ScrollView,
  Image,
  Platform,
  Keyboard,
  KeyboardAvoidingView,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from 'react-native-vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeContext';
import { useTranslation } from 'react-i18next';

const SAGE = '#7C9A7E';
const STORAGE_KEYS = {
  photo: '@user_profile_photo',
  name: '@user_name',
  heightInches: '@user_height_inches',
  startingWeight: '@user_starting_weight',
  startingDate: '@user_starting_date',
  weightUnit: '@user_weight_unit',
} as const;

type ProfileContextValue = {
  profilePhotoUri: string | null;
  setProfilePhotoUri: (uri: string | null) => void;
  openProfileModal: () => void;
  /** Increments when profile is saved (so MyProgress etc. can reload starting weight/date). */
  profileSavedTrigger: number;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile() {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profilePhotoUri, setProfilePhotoUriState] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profileSavedTrigger, setProfileSavedTrigger] = useState(0);

  const setProfilePhotoUri = useCallback((uri: string | null) => {
    setProfilePhotoUriState(uri);
    if (uri !== null) AsyncStorage.setItem(STORAGE_KEYS.photo, uri);
    else AsyncStorage.removeItem(STORAGE_KEYS.photo);
  }, []);

  const openProfileModal = useCallback(() => setModalVisible(true), []);

  const onProfileSaved = useCallback(() => {
    setProfileSavedTrigger((t) => t + 1);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const uri = await AsyncStorage.getItem(STORAGE_KEYS.photo);
        setProfilePhotoUriState(uri);
      } catch (_) {}
      setLoading(false);
    })();
  }, []);

  const value: ProfileContextValue = {
    profilePhotoUri,
    setProfilePhotoUri,
    openProfileModal,
    profileSavedTrigger,
  };

  return (
    <ProfileContext.Provider value={value}>
      {children}
      {!loading && (
        <ProfileModal
          visible={modalVisible}
          onClose={() => setModalVisible(false)}
          onProfileSaved={onProfileSaved}
          profilePhotoUri={profilePhotoUri}
          setProfilePhotoUri={setProfilePhotoUri}
        />
      )}
    </ProfileContext.Provider>
  );
}

type ProfileModalProps = {
  visible: boolean;
  onClose: () => void;
  onProfileSaved: () => void;
  profilePhotoUri: string | null;
  setProfilePhotoUri: (uri: string | null) => void;
};

const SAGE_STORAGE_KEYS = {
  goals: '@sage_goals',
  diet: '@sage_diet',
  allergies: '@sage_allergies',
  brands: '@sage_brands',
} as const;

function ProfileModal({ visible, onClose, profilePhotoUri, setProfilePhotoUri }: ProfileModalProps) {
  const { theme } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [heightFeet, setHeightFeet] = useState('');
  const [heightInches, setHeightInches] = useState('');
  const [startingWeight, setStartingWeight] = useState('');
  const [startingDate, setStartingDate] = useState<Date>(() => new Date());
  const [weightUnit, setWeightUnit] = useState<'lbs' | 'kg'>('lbs');
  const [photoUri, setPhotoUri] = useState<string | null>(profilePhotoUri);
  const [sageGoals, setSageGoals] = useState('');
  const [sageDiet, setSageDiet] = useState('');
  const [sageAllergies, setSageAllergies] = useState('');
  const [sageBrands, setSageBrands] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const loadStored = useCallback(async () => {
    try {
      const [n, hi, sw, sd, wu] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.name),
        AsyncStorage.getItem(STORAGE_KEYS.heightInches),
        AsyncStorage.getItem(STORAGE_KEYS.startingWeight),
        AsyncStorage.getItem(STORAGE_KEYS.startingDate),
        AsyncStorage.getItem(STORAGE_KEYS.weightUnit),
      ]);
      setName(n ?? '');
      const totalInches = hi ? parseInt(hi, 10) : 0;
      if (totalInches) {
        setHeightFeet(String(Math.floor(totalInches / 12)));
        setHeightInches(String(totalInches % 12));
      } else {
        setHeightFeet('');
        setHeightInches('');
      }
      setStartingWeight(sw ?? '');
      if (sd && /^\d{4}-\d{2}-\d{2}$/.test(sd)) {
        const [y, m, d] = sd.split('-').map(Number);
        setStartingDate(new Date(y, m - 1, d));
      } else {
        setStartingDate(new Date());
      }
      setWeightUnit((wu as 'lbs' | 'kg') || 'lbs');
      setPhotoUri(profilePhotoUri);
    } catch (_) {}
  }, [profilePhotoUri]);

  const loadSageFromStorage = useCallback(async () => {
    try {
      const [goals, diet, allergies, brands] = await Promise.all([
        AsyncStorage.getItem(SAGE_STORAGE_KEYS.goals),
        AsyncStorage.getItem(SAGE_STORAGE_KEYS.diet),
        AsyncStorage.getItem(SAGE_STORAGE_KEYS.allergies),
        AsyncStorage.getItem(SAGE_STORAGE_KEYS.brands),
      ]);
      if (goals) setSageGoals(goals);
      if (diet) setSageDiet(diet);
      if (allergies) setSageAllergies(allergies);
      if (brands) setSageBrands(brands);
    } catch (e) {
      console.error('Error loading Sage preferences:', e);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      loadStored();
      loadSageFromStorage();
    }
  }, [visible, loadStored, loadSageFromStorage]);

  useEffect(() => {
    if (!visible) {
      setKeyboardHeight(0);
      return;
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const onHide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, [visible]);

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo library access to set profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (!result.canceled && result.assets?.[0]?.uri) {
      setPhotoUri(result.assets[0].uri);
    }
  };

  const save = async () => {
    Keyboard.dismiss();
    const totalInches = (parseInt(heightFeet, 10) || 0) * 12 + (parseInt(heightInches, 10) || 0);
    try {
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.name, name.trim()],
        [STORAGE_KEYS.heightInches, String(totalInches)],
        [STORAGE_KEYS.startingWeight, startingWeight.trim()],
        [STORAGE_KEYS.startingDate, startingDate.toISOString().slice(0, 10)],
        [STORAGE_KEYS.weightUnit, weightUnit],
        [SAGE_STORAGE_KEYS.goals, sageGoals],
        [SAGE_STORAGE_KEYS.diet, sageDiet],
        [SAGE_STORAGE_KEYS.allergies, sageAllergies],
        [SAGE_STORAGE_KEYS.brands, sageBrands],
      ]);
      if (photoUri !== profilePhotoUri) {
        setProfilePhotoUri(photoUri);
      }
      onProfileSaved();
    } catch (e) {
      if (__DEV__) console.warn('Profile save error:', e);
    } finally {
      onClose();
    }
  };

  const scrollBottomPad = 24 + keyboardHeight + Math.max(insets.bottom, 8);

  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardAvoidingView
        style={styles.keyboardRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, { backgroundColor: theme.card }]}>
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Edit Profile</Text>
              <TouchableOpacity onPress={onClose} hitSlop={12}>
                <Ionicons name="close" size={24} color={theme.text} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.scroll}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              contentContainerStyle={[styles.scrollContent, { paddingBottom: scrollBottomPad }]}
              showsVerticalScrollIndicator
            >
            <TouchableOpacity style={styles.photoWrap} onPress={pickImage}>
              {photoUri ? (
                <Image source={{ uri: photoUri }} style={styles.photoCircle} />
              ) : (
                <View style={styles.photoPlaceholder}>
                  <Ionicons name="person-circle-outline" size={64} color={SAGE} />
                </View>
              )}
            </TouchableOpacity>

            <Text style={[styles.label, { color: theme.text }]}>Name</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              value={name}
              onChangeText={setName}
              placeholder="Your name"
              placeholderTextColor={theme.textSecondary ?? '#888'}
            />

            <Text style={[styles.label, { color: theme.text }]}>Height</Text>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.inputHalf, { borderColor: theme.border, color: theme.text }]}
                value={heightFeet}
                onChangeText={setHeightFeet}
                placeholder="Ft"
                placeholderTextColor={theme.textSecondary ?? '#888'}
                keyboardType="number-pad"
              />
              <TextInput
                style={[styles.input, styles.inputHalf, { borderColor: theme.border, color: theme.text }]}
                value={heightInches}
                onChangeText={setHeightInches}
                placeholder="In"
                placeholderTextColor={theme.textSecondary ?? '#888'}
                keyboardType="number-pad"
              />
            </View>

            <Text style={[styles.label, { color: theme.text }]}>Starting weight</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              value={startingWeight}
              onChangeText={setStartingWeight}
              placeholder="e.g. 150"
              placeholderTextColor={theme.textSecondary ?? '#888'}
              keyboardType="decimal-pad"
            />

            <Text style={[styles.label, { color: theme.text }]}>Starting date</Text>
            <TouchableOpacity
              style={[styles.dateRow, { backgroundColor: theme.card ?? '#f5f5f5', borderColor: theme.border ?? '#ddd' }]}
              onPress={() => setShowDatePicker(true)}
              activeOpacity={0.7}
            >
              <Text style={[styles.dateRowText, { color: theme.text }]}>
                {startingDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
              <Ionicons name="calendar-outline" size={20} color={theme.textSecondary ?? '#888'} />
            </TouchableOpacity>
            {showDatePicker && Platform.OS === 'ios' && (
              <Modal visible transparent animationType="slide">
                <View style={styles.datePickerModalOverlay}>
                  <View style={[styles.datePickerModalContent, { backgroundColor: theme.background ?? '#fff' }]}>
                    <View style={styles.datePickerModalHeader}>
                      <TouchableOpacity onPress={() => setShowDatePicker(false)}>
                        <Text style={[styles.datePickerDoneText, { color: theme.primary || SAGE }]}>Done</Text>
                      </TouchableOpacity>
                    </View>
                    <DateTimePicker
                      value={startingDate}
                      mode="date"
                      display="inline"
                      onChange={(_, date) => {
                        if (date) setStartingDate(date);
                        setShowDatePicker(false);
                      }}
                      maximumDate={new Date()}
                    />
                  </View>
                </View>
              </Modal>
            )}
            {showDatePicker && Platform.OS === 'android' && (
              <DateTimePicker
                value={startingDate}
                mode="date"
                display="default"
                onChange={(_, date) => {
                  if (date) setStartingDate(date);
                  setShowDatePicker(false);
                }}
                maximumDate={new Date()}
                style={styles.datePickerAndroid}
              />
            )}

            <Text style={[styles.label, { color: theme.text }]}>Weight unit</Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.unitBtn, { borderColor: theme.border }, weightUnit === 'lbs' && styles.unitBtnActive]}
                onPress={() => setWeightUnit('lbs')}
              >
                <Text style={[styles.unitBtnText, { color: theme.text }, weightUnit === 'lbs' && styles.unitBtnTextActive]}>lbs</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.unitBtn, { borderColor: theme.border }, weightUnit === 'kg' && styles.unitBtnActive]}
                onPress={() => setWeightUnit('kg')}
              >
                <Text style={[styles.unitBtnText, { color: theme.text }, weightUnit === 'kg' && styles.unitBtnTextActive]}>kg</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.sectionLabel, { color: theme.text }]}>Sage Context</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Goals (e.g., lose fat, maintain muscle)"
              placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : '#888'}
              value={sageGoals}
              onChangeText={(text) => {
                setSageGoals(text);
                AsyncStorage.setItem(SAGE_STORAGE_KEYS.goals, text).catch(() => {});
              }}
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Dietary preferences (e.g., carnivore, no gluten)"
              placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : '#888'}
              value={sageDiet}
              onChangeText={(text) => {
                setSageDiet(text);
                AsyncStorage.setItem(SAGE_STORAGE_KEYS.diet, text).catch(() => {});
              }}
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Allergies/restrictions"
              placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : '#888'}
              value={sageAllergies}
              onChangeText={(text) => {
                setSageAllergies(text);
                AsyncStorage.setItem(SAGE_STORAGE_KEYS.allergies, text).catch(() => {});
              }}
            />
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text }]}
              placeholder="Preferred brands (e.g., Fage, Kerrygold)"
              placeholderTextColor={theme.type === 'dark' ? 'rgba(255,255,255,0.5)' : '#888'}
              value={sageBrands}
              onChangeText={(text) => {
                setSageBrands(text);
                AsyncStorage.setItem(SAGE_STORAGE_KEYS.brands, text).catch(() => {});
              }}
            />
            </ScrollView>
            <View
              style={[
                styles.saveFooter,
                {
                  borderTopColor: theme.border,
                  paddingBottom: Math.max(16, insets.bottom),
                },
              ]}
            >
              <TouchableOpacity style={styles.saveBtn} onPress={save} activeOpacity={0.8}>
                <Text style={styles.saveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  keyboardRoot: {
    flex: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalBox: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    width: '100%',
    height: '88%',
    maxHeight: '92%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#333' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24 },
  photoWrap: { alignSelf: 'center', marginBottom: 20 },
  photoCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#f0f0f0',
  },
  photoPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: { fontSize: 14, fontWeight: '600', color: '#333', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    marginBottom: 14,
    color: '#333',
  },
  inputHalf: { flex: 1, marginHorizontal: 4 },
  row: { flexDirection: 'row', marginBottom: 14 },
  unitBtn: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    marginRight: 8,
  },
  unitBtnActive: { backgroundColor: SAGE, borderColor: SAGE },
  unitBtnText: { fontSize: 16, color: '#333' },
  unitBtnTextActive: { color: '#fff', fontWeight: '600' },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
  },
  dateRowText: { fontSize: 16 },
  datePickerModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  datePickerModalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 24,
  },
  datePickerModalHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    padding: 16,
    paddingBottom: 8,
  },
  datePickerDoneText: {
    fontSize: 17,
    fontWeight: '600',
  },
  datePickerAndroid: { width: '100%' },
  sectionLabel: { fontSize: 16, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  saveFooter: {
    paddingHorizontal: 16,
    paddingTop: 16,
    borderTopWidth: 1,
  },
  saveBtn: {
    backgroundColor: SAGE,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
