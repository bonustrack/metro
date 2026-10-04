import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store';
import { configurePlatform, memoryKeyValue, type KeyValue } from '@metro-labs/client/platform';
import { logError } from './log.js';

const PREFIX = 'metro.';
const SECRET = new Set(['metro.account']);
const SECURE_KEY = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_');

function persisted(seed: Record<string, string>): KeyValue {
  const memory = memoryKeyValue(seed);
  return {
    getItem: (key) => memory.getItem(key),
    setItem: (key, value) => {
      memory.setItem(key, value);
      const write = SECRET.has(key) ? setItemAsync(SECURE_KEY(key), value) : AsyncStorage.setItem(key, value);
      write.catch(logError('storage.set'));
    },
    removeItem: (key) => {
      memory.removeItem(key);
      const drop = SECRET.has(key) ? deleteItemAsync(SECURE_KEY(key)) : AsyncStorage.removeItem(key);
      drop.catch(logError('storage.remove'));
    },
  };
}

async function readAll(): Promise<Record<string, string>> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(PREFIX) && !SECRET.has(key));
  const pairs = await AsyncStorage.multiGet(keys);
  const seed: Record<string, string> = {};
  for (const [key, value] of pairs) if (value !== null) seed[key] = value;
  for (const key of SECRET) {
    const value = await getItemAsync(SECURE_KEY(key));
    if (value !== null) seed[key] = value;
  }
  return seed;
}

export async function prepareStorage(): Promise<void> {
  const seed = await readAll().catch((err: unknown) => {
    logError('storage.read')(err);
    return {};
  });
  configurePlatform({ kv: persisted(seed), tabKv: memoryKeyValue() });
}
