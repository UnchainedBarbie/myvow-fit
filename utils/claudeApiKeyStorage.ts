import AsyncStorage from '@react-native-async-storage/async-storage';

const ANTHROPIC_API_KEY_STORAGE_KEY = '@simplefitness_anthropic_api_key';

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

