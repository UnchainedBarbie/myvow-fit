import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ScrollView,
  Alert,
  TextInput,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { useSettings } from '../context/SettingsContext';
import { useTheme } from '../context/ThemeContext';
import { useTranslation } from 'react-i18next';
import { useNotifications } from '../utils/useNotifications';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import { setClaudeApiKey } from '../utils/claudeApiKeyStorage';

export default function Settings() {
  const {
    dateFormat,
    setDateFormat,
    timeFormat,
    setTimeFormat,
    weightFormat,
    setWeightFormat,
    language,
    setLanguage,
    notificationPermissionGranted,
    setNotificationPermissionGranted,
  } = useSettings();
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation(); // for translations
  const [claudeApiKey, setClaudeApiKeyState] = useState('');
  const [apiKeySavedMessage, setApiKeySavedMessage] = useState<string | null>(
    null,
  );

  // Use the notifications hook to access all notification-related functionality
  const { requestNotificationPermission, cancelAllNotifications } =
    useNotifications();

  const handleSaveClaudeKey = async () => {
    try {
      await setClaudeApiKey(claudeApiKey);
      const msg =
        t('aiWorkoutSettingsSaved') ||
        'Anthropic API key saved successfully.';
      setApiKeySavedMessage(msg);
      Alert.alert(t('Save') || 'Save', msg);
    } catch {
      Alert.alert(
        t('errorTitle') || 'Error',
        t('aiWorkoutSettingsSaveError') || 'Failed to save API key.',
      );
    }
  };

  // Manages whether the language dropdown is visible
  const [languageDropdownVisible, setLanguageDropdownVisible] = useState(false);

  // Languages array with i18n-compatible codes
  const languages = [
    { code: 'cs', label: 'Čeština' },
    { code: 'de', label: 'Deutsch' },
    { code: 'dk', label: 'Dansk' },
    { code: 'el', label: 'Ελληνική' },
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Español' },
    { code: 'fi', label: 'Suomi' },
    { code: 'fr', label: 'Français' },
    { code: 'it', label: 'Italiano' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'nl', label: 'Nederlands' },
    { code: 'no', label: 'Norsk' },
    { code: 'pl', label: 'Polski' },
    { code: 'pt', label: 'Português' },
    { code: 'ro', label: 'Română' },
    { code: 'ru', label: 'Русский' },
    { code: 'sl', label: 'Slovenščina' },
    { code: 'sv', label: 'Svenska' },
    { code: 'tr', label: 'Türkçe' },
    { code: 'uk', label: 'Українська' },
    { code: 'zh', label: '中文' },
    // add more languages here #2
  ];

  const currentLanguage = language;

  const handleLanguageChange = (languageCode: string) => {
    setLanguage(languageCode);
    setLanguageDropdownVisible(false); // close dropdown
  };

  const handleDateFormatChange = (format: string) => {
    setDateFormat(format);
  };

  const handleTimeFormatChange = (format: '24h' | 'AM/PM') => {
    setTimeFormat(format);
  };

  const handleWeightFormatChange = (format: string) => {
    setWeightFormat(format);
  };

  // Handle notification main toggle change
  const handleNotificationToggle = async (value: boolean) => {
    if (value) {
      const granted = await requestNotificationPermission();
      setNotificationPermissionGranted(granted);
    } else {
      Alert.alert(
        t('notificationsDisableTitle') || 'Disable Notifications',
        t('notificationsDisableMessage') ||
          'Turning off notifications will cancel all scheduled workout reminders. Are you sure?',
        [
          {
            text: t('cancel') || 'Cancel',
            style: 'cancel',
          },
          {
            text: t('confirm') || 'Confirm',
            onPress: async () => {
              await cancelAllNotifications();
              setNotificationPermissionGranted(false);
            },
          },
        ],
        { cancelable: true },
      );
    }
  };

  const renderLanguageButton = () => (
    <TouchableOpacity
      style={[styles.dropdownButton, { minWidth: 180 }]}
      onPress={() => setLanguageDropdownVisible((prev) => !prev)}
    >
      <Text style={[styles.buttonText, { color: 'white' }]}>
        {languages.find((lang) => lang.code === currentLanguage)?.label ||
          'Select Language'}
      </Text>
      <Ionicons
        name={languageDropdownVisible ? 'chevron-up' : 'chevron-down'}
        size={18}
        color="white"
        style={styles.dropdownIcon}
      />
    </TouchableOpacity>
  );

  const openSimplePicker = (
    title: string,
    options: string[],
    current: string,
    onSelect: (val: string) => void,
  ) => {
    Alert.alert(
      title,
      undefined,
      options.map((opt) => ({
        text: `${opt}${opt === current ? ' ✓' : ''}`,
        onPress: () => onSelect(opt),
      })),
    );
  };

  // Database management functions
  const exportDatabase = async () => {
    try {
      const dbName = 'SimpleDB.db';
      const dbFilePath = `${FileSystem.documentDirectory}SQLite/${dbName}`;

      const fileInfo = await FileSystem.getInfoAsync(dbFilePath);

      if (!fileInfo.exists) {
        Alert.alert(
          t('exportFailedTitle') || 'Export Failed',
          t('databaseNotFound') || 'Database file not found',
          [{ text: 'OK' }],
        );
        return;
      }

      const today = new Date();
      const day = String(today.getDate()).padStart(2, '0');
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const year = today.getFullYear();

      const formattedDate =
        dateFormat === 'dd-mm-yyyy'
          ? `${day}-${month}-${year}`
          : `${month}-${day}-${year}`;

      const exportDbName = `SimpleDB-${formattedDate}.db`;

      const tempExportPath = `${FileSystem.cacheDirectory}${exportDbName}`;
      await FileSystem.copyAsync({
        from: dbFilePath,
        to: tempExportPath,
      });

      const isAvailable = await Sharing.isAvailableAsync();

      if (!isAvailable) {
        Alert.alert(
          t('exportFailedTitle') || 'Export Failed',
          t('sharingNotAvailable') ||
            'Sharing is not available on this device',
          [{ text: 'OK' }],
        );
        return;
      }

      await Sharing.shareAsync(tempExportPath, {
        mimeType: 'application/x-sqlite3',
        dialogTitle: t('exportDatabaseTitle') || 'Export Workout Database',
        UTI: 'public.database',
      });
    } catch (error) {
      console.error('Error exporting database:', error);
      Alert.alert(
        t('exportFailedTitle') || 'Export Failed',
        t('exportErrorMessage') ||
          'Failed to export database. Please try again.',
        [{ text: 'OK' }],
      );
    }
  };

  const importDatabase = async () => {
    Alert.alert(
      t('importConfirmTitle') || 'Import Database',
      t('importConfirmMessage') ||
        'Importing a database will replace your current data. This action cannot be undone. Continue?',
      [
        { text: t('cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('confirm') || 'Confirm',
          onPress: async () => {
            const dbName = 'SimpleDB.db';
            const dbDirectory = `${FileSystem.documentDirectory}SQLite/`;
            const dbFilePath = `${dbDirectory}${dbName}`;
            const backupDbFilePath = `${dbFilePath}.backup`;

            let documentPickerResult;
            try {
              documentPickerResult = await DocumentPicker.getDocumentAsync({
                type: [
                  'application/x-sqlite3',
                  'application/octet-stream',
                  'application/vnd.sqlite3',
                ],
                copyToCacheDirectory: true,
              });

              if (
                documentPickerResult.canceled ||
                !documentPickerResult.assets ||
                documentPickerResult.assets.length === 0 ||
                !documentPickerResult.assets[0].uri
              ) {
                Alert.alert(
                  t('importFailedTitle') || 'Import Failed',
                  t('fileNotSelectedError') ||
                    'No file was selected or the file is invalid.',
                );
                return;
              }
            } catch (pickerError) {
              console.error('DocumentPicker error:', pickerError);
              Alert.alert(
                t('importFailedTitle') || 'Import Failed',
                t('filePickerError') ||
                  'An error occurred while selecting the file. Please try again.',
              );
              return;
            }

            const sourceUri = documentPickerResult.assets[0].uri;
            let originalDbExists = false;
            let backupSuccessfullyCreated = false;

            try {
              const originalDbInfo = await FileSystem.getInfoAsync(dbFilePath);
              originalDbExists = originalDbInfo.exists;

              if (originalDbExists) {
                await FileSystem.copyAsync({
                  from: dbFilePath,
                  to: backupDbFilePath,
                });
                backupSuccessfullyCreated = true;
              }

              await FileSystem.deleteAsync(dbFilePath, { idempotent: true });
              await FileSystem.copyAsync({ from: sourceUri, to: dbFilePath });

              Alert.alert(
                t('importSuccessTitle') || 'Import Successful',
                t('importSuccessMessage') ||
                  'Database imported successfully. Please restart the app for changes to take effect.',
                [{ text: 'OK' }],
              );

              if (backupSuccessfullyCreated) {
                await FileSystem.deleteAsync(backupDbFilePath, {
                  idempotent: true,
                });
              }
            } catch (error) {
              console.error('Error during database replacement:', error);
              let finalAlertMessage =
                t('importErrorMessageDefault') ||
                'Database import failed. An unexpected error occurred.';

              if (backupSuccessfullyCreated) {
                try {
                  await FileSystem.deleteAsync(dbFilePath, {
                    idempotent: true,
                  });
                  await FileSystem.copyAsync({
                    from: backupDbFilePath,
                    to: dbFilePath,
                  });
                  finalAlertMessage =
                    t('importFailedRestoreSuccess') ||
                    'Import failed, but your original data has been successfully restored.';
                  await FileSystem.deleteAsync(backupDbFilePath, {
                    idempotent: true,
                  });
                } catch (restoreError) {
                  console.error(
                    'CRITICAL: Error restoring database from backup:',
                    restoreError,
                  );
                  const baseMsg =
                    t('importFailedRestoreErrorBase') ||
                    'Import failed. CRITICAL: Could not restore original data. Backup may be available at: ';
                  finalAlertMessage = baseMsg + backupDbFilePath;
                }
              } else if (originalDbExists) {
                finalAlertMessage =
                  t('importFailedOriginalIntact') ||
                  'Import failed (error during backup step). Your original data should be intact.';
              } else {
                finalAlertMessage =
                  t('importFailedNewFileError') ||
                  'Import failed while copying the new database. No prior data existed.';
              }
              Alert.alert(
                t('importFailedTitle') || 'Import Failed',
                finalAlertMessage,
                [{ text: 'OK' }],
              );
            }
          },
        },
      ],
      { cancelable: true },
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <Text style={[styles.title, { color: theme.text }]}>
          {t('settingsTitle')}
        </Text>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('settingsLanguage')}
          </Text>
          {renderLanguageButton()}
          {languageDropdownVisible && (
            <View style={[styles.dropdownList, { backgroundColor: theme.card, borderColor: theme.border }]}>
              {languages.map((item) => (
                <TouchableOpacity
                  key={item.code}
                  style={[
                    styles.dropdownItem,
                    currentLanguage === item.code && styles.activeDropdownItem,
                  ]}
                  onPress={() => handleLanguageChange(item.code)}
                >
                  <Text
                    style={[
                      styles.dropdownItemText,
                      currentLanguage === item.code &&
                        styles.activeDropdownItemText,
                    ]}
                  >
                    {item.label}{' '}
                    {currentLanguage === item.code && (
                      <Ionicons
                        name="checkmark"
                        size={18}
                        color="white"
                        style={styles.tickIcon}
                      />
                    )}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('notifications')}
          </Text>

          <View style={styles.toggleRow}>
            <Text style={[styles.toggleText, { color: theme.text }]}>
              {t('remindScheduledWorkouts')}
            </Text>
            <Switch
              value={notificationPermissionGranted}
              onValueChange={handleNotificationToggle}
              trackColor={{ false: '#767577', true: '#FFFFFF' }}
              thumbColor={notificationPermissionGranted ? '#ffffff' : '#f4f3f4'}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('settingsDateFormat')}
          </Text>
          <TouchableOpacity
            style={[
              styles.pickerField,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
            onPress={() =>
              openSimplePicker(
                t('settingsDateFormat') || 'Date Format',
                ['dd-mm-yyyy', 'mm-dd-yyyy'],
                dateFormat,
                handleDateFormatChange,
              )
            }
          >
            <Text style={{ color: theme.text }}>{dateFormat}</Text>
            <Ionicons
              name="chevron-down"
              size={18}
              color={theme.text}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('settingsTimeFormat')}
          </Text>
          <TouchableOpacity
            style={[
              styles.pickerField,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
            onPress={() =>
              openSimplePicker(
                t('settingsTimeFormat') || 'Time Format',
                ['24h', 'AM/PM'],
                timeFormat,
                (val) => handleTimeFormatChange(val as '24h' | 'AM/PM'),
              )
            }
          >
            <Text style={{ color: theme.text }}>{timeFormat}</Text>
            <Ionicons
              name="chevron-down"
              size={18}
              color={theme.text}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('settingsWeightFormat')}
          </Text>
          <TouchableOpacity
            style={[
              styles.pickerField,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
            onPress={() =>
              openSimplePicker(
                t('settingsWeightFormat') || 'Weight Format',
                ['kg', 'lbs'],
                weightFormat,
                handleWeightFormatChange,
              )
            }
          >
            <Text style={{ color: theme.text }}>{weightFormat}</Text>
            <Ionicons
              name="chevron-down"
              size={18}
              color={theme.text}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('aiWorkoutSettingsTitle') || 'AI Workout Generator'}
          </Text>
          <Text
            style={{
              color: theme.text,
              marginBottom: 4,
              textAlign: 'center',
            }}
          >
            {t('aiWorkoutSettingsHint') ||
              'Enter your Anthropic Claude API key to enable AI-powered workout generation.'}
          </Text>
          <TextInput
            style={[
              styles.aiKeyInput,
              {
                borderColor: theme.text,
                color: theme.text,
              },
            ]}
            placeholder={
              t('aiWorkoutApiKeyPlaceholder') ||
              'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
            }
            placeholderTextColor={theme.text}
            value={claudeApiKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(text) => {
              setClaudeApiKeyState(text);
              setApiKeySavedMessage(null);
            }}
          />
          <TouchableOpacity
            style={[
              styles.dataManagementButton,
              { backgroundColor: '#121212', alignSelf: 'center', marginTop: 10 },
            ]}
            onPress={handleSaveClaudeKey}
          >
            <View style={styles.dataManagementButtonContent}>
              <Ionicons
                name="save-outline"
                size={18}
                color="#FFFFFF"
                style={styles.dataButtonIcon}
              />
              <Text
                style={[
                  styles.dataManagementButtonText,
                  { color: '#FFFFFF' },
                ]}
              >
                {t('Save') || 'Save'}
              </Text>
            </View>
          </TouchableOpacity>
          {apiKeySavedMessage ? (
            <Text
              style={{
                marginTop: 4,
                textAlign: 'center',
                color: theme.text,
                fontSize: 14,
              }}
            >
              {apiKeySavedMessage}
            </Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('settingsTheme')}
          </Text>
          <View style={styles.buttonGroup}>
            <TouchableOpacity
              style={[
                styles.button,
                theme.type === 'dark' && styles.activeButton,
                { minWidth: 150, backgroundColor: theme.type === 'light' ? theme.card : undefined, borderColor: theme.border },
              ]}
              onPress={toggleTheme}
            >
              <Text
                style={[
                  styles.buttonText,
                  { color: theme.type === 'light' ? theme.text : undefined },
                  theme.type === 'dark' && styles.activeButtonText,
                ]}
              >
                {theme.type === 'light'
                  ? t('settingsSwitchDark')
                  : t('settingsSwitchLight')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>
            {t('dataManagement') || 'Data Management'}
          </Text>

          <View style={styles.dataManagementButtonGroup}>
            <TouchableOpacity
              style={[
                styles.dataManagementButton,
                { backgroundColor: theme.darkGreen || '#5C7A5E' },
              ]}
              onPress={exportDatabase}
            >
              <View style={styles.dataManagementButtonContent}>
                <Ionicons
                  name="share-outline"
                  size={18}
                  color="#FFFFFF"
                  style={styles.dataButtonIcon}
                />
                <Text
                  style={[
                    styles.dataManagementButtonText,
                    { color: '#FFFFFF' },
                  ]}
                  numberOfLines={2}
                >
                  {t('exportData') || 'Export Data'}
                </Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.dataManagementButton,
                { backgroundColor: theme.card },
              ]}
              onPress={importDatabase}
            >
              <View style={styles.dataManagementButtonContent}>
                <Ionicons
                  name="download-outline"
                  size={18}
                  color={theme.text}
                  style={styles.dataButtonIcon}
                />
                <Text
                  style={[
                    styles.dataManagementButtonText,
                    { color: theme.text },
                  ]}
                  numberOfLines={2}
                >
                  {t('importData') || 'Import Data'}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 20,
    paddingHorizontal: 20,
  },
  backButton: {
    position: 'absolute',
    top: 20,
    left: 10,
    zIndex: 10,
    padding: 8,
  },
  title: {
    fontSize: 30,
    fontFamily: 'CormorantGaramond-Bold',
    marginBottom: 16,
    textAlign: 'center',
    color: '#000000',
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 22,
    fontFamily: 'CormorantGaramond-SemiBold',
    textAlign: 'center',
    marginBottom: 6,
  },
  buttonGroup: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  button: {
    borderWidth: 1,
    borderColor: '#DDE8DD',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: '#FFFFFF',
  },
  activeButton: {
    backgroundColor: '#121212',
  },
  buttonText: {
    fontSize: 18,
    fontFamily: 'Jost_500Medium',
    color: '#000000',
  },
  activeButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tickIcon: {
    marginLeft: 10,
  },
  dropdownButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DDE8DD',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 15,
    backgroundColor: '#7C9A7E',
  },
  dropdownIcon: {
    marginLeft: 10,
  },
  dropdownList: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#DDE8DD',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 15,
  },
  activeDropdownItem: {
    backgroundColor: '#7C9A7E',
  },
  dropdownItemText: {
    fontSize: 18,
    fontFamily: 'Jost_400Regular',
  },
  activeDropdownItemText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 15,
    backgroundColor: '#7C9A7E',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DDE8DD',
  },
  toggleText: {
    fontSize: 16,
    fontFamily: 'Jost_400Regular',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  dataButtonIcon: {
    marginRight: 5,
  },
  dataManagementButtonGroup: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    flexWrap: 'wrap',
    gap: 10,
  },
  dataManagementButton: {
    borderWidth: 1,
    borderColor: '#DDE8DD',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 15,
    minWidth: 130,
    flex: 1,
    marginHorizontal: 5,
  },
  dataManagementButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  dataManagementButtonText: {
    fontSize: 18,
    fontFamily: 'Jost_500Medium',
    flexShrink: 1,
  },
  pickerField: {
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aiKeyInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 16,
    marginTop: 4,
  },
});

