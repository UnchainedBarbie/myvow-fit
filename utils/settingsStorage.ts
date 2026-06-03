import * as FileSystem from 'expo-file-system/legacy';

// Make sure to use backticks here:
const SETTINGS_FILE = `${FileSystem.documentDirectory}userSettings.json`;

/**
 * Subscription state shape persisted alongside other user settings. Lives in the
 * same JSON file so we can read/write it without standing up a new store. All
 * three fields default to a "no subscription known yet" state.
 */
export type SubscriptionStatus = 'none' | 'active' | 'expired';

export type SubscriptionState = {
  subscription_status: SubscriptionStatus;
  subscription_product_id: string | null;
  subscription_expires_at: string | null;
};

const DEFAULT_SUBSCRIPTION_STATE: SubscriptionState = {
  subscription_status: 'none',
  subscription_product_id: null,
  subscription_expires_at: null,
};

async function readSettingsObject(): Promise<Record<string, unknown>> {
  try {
    const fileInfo = await FileSystem.getInfoAsync(SETTINGS_FILE);
    if (!fileInfo.exists) return {};
    const raw = await FileSystem.readAsStringAsync(SETTINGS_FILE);
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    console.error('Error reading settings object:', error);
    return {};
  }
}

async function writeSettingsObject(obj: Record<string, unknown>): Promise<void> {
  await FileSystem.writeAsStringAsync(SETTINGS_FILE, JSON.stringify(obj));
}

/**
 * Persists settings as a MERGE on top of the existing file. Older callers that
 * passed every known field still get the same effective result; newer callers
 * (subscription state, future flags) won't clobber unrelated fields written by
 * other code paths (e.g. SettingsContext re-saving its known keys).
 */
export const saveSettings = async (settings: object) => {
  try {
    const existing = await readSettingsObject();
    const merged = { ...existing, ...(settings as Record<string, unknown>) };
    await writeSettingsObject(merged);
    console.log('Settings saved successfully.');
  } catch (error) {
    console.error('Error saving settings:', error);
  }
};

export const loadSettings = async () => {
  try {
    const fileInfo = await FileSystem.getInfoAsync(SETTINGS_FILE);
    if (!fileInfo.exists) {
      console.log("Settings file doesn't exist, using default settings.");
      return null;
    }

    const settings = await FileSystem.readAsStringAsync(SETTINGS_FILE);
    return JSON.parse(settings);
  } catch (error) {
    console.error('Error loading settings:', error);
    return null;
  }
};

function isSubscriptionStatus(v: unknown): v is SubscriptionStatus {
  return v === 'none' || v === 'active' || v === 'expired';
}

export async function getSubscriptionState(): Promise<SubscriptionState> {
  const obj = await readSettingsObject();
  return {
    subscription_status: isSubscriptionStatus(obj.subscription_status)
      ? obj.subscription_status
      : DEFAULT_SUBSCRIPTION_STATE.subscription_status,
    subscription_product_id:
      typeof obj.subscription_product_id === 'string'
        ? obj.subscription_product_id
        : DEFAULT_SUBSCRIPTION_STATE.subscription_product_id,
    subscription_expires_at:
      typeof obj.subscription_expires_at === 'string'
        ? obj.subscription_expires_at
        : DEFAULT_SUBSCRIPTION_STATE.subscription_expires_at,
  };
}

export async function setSubscriptionState(
  state: Partial<SubscriptionState>,
): Promise<SubscriptionState> {
  const current = await getSubscriptionState();
  const next: SubscriptionState = {
    subscription_status:
      state.subscription_status !== undefined
        ? state.subscription_status
        : current.subscription_status,
    subscription_product_id:
      state.subscription_product_id !== undefined
        ? state.subscription_product_id
        : current.subscription_product_id,
    subscription_expires_at:
      state.subscription_expires_at !== undefined
        ? state.subscription_expires_at
        : current.subscription_expires_at,
  };
  await saveSettings(next);
  return next;
}
