import AsyncStorage from '@react-native-async-storage/async-storage';

export type SageMessage = {
  role: 'user' | 'assistant';
  content: string;
  /** When true, this row is UI-only (truncation recovery) and must not be sent to the API. */
  truncationUi?: boolean;
};

const SAGE_STORAGE_KEY = '@simplefitness_sage_conversation';

export async function saveConversation(messages: SageMessage[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SAGE_STORAGE_KEY, JSON.stringify(messages));
  } catch (e) {
    console.error('Error saving Sage conversation:', e);
  }
}

export async function loadConversation(): Promise<SageMessage[] | null> {
  try {
    const raw = await AsyncStorage.getItem(SAGE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as SageMessage[];
  } catch (e) {
    console.error('Error loading Sage conversation:', e);
    return null;
  }
}

export async function clearConversation(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SAGE_STORAGE_KEY);
  } catch (e) {
    console.error('Error clearing Sage conversation:', e);
  }
}

