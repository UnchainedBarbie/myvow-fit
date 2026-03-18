import AsyncStorage from '@react-native-async-storage/async-storage';

const ANTHROPIC_API_KEY_STORAGE_KEY = '@simplefitness_anthropic_api_key';

export async function getClaudeApiKey(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ANTHROPIC_API_KEY_STORAGE_KEY);
  } catch (e) {
    console.error('Error reading Claude API key:', e);
    return null;
  }
}

export async function setClaudeApiKey(key: string | null): Promise<void> {
  try {
    if (key === null || key.trim() === '') {
      await AsyncStorage.removeItem(ANTHROPIC_API_KEY_STORAGE_KEY);
    } else {
      await AsyncStorage.setItem(ANTHROPIC_API_KEY_STORAGE_KEY, key.trim());
    }
  } catch (e) {
    console.error('Error saving Claude API key:', e);
    throw e;
  }
}

