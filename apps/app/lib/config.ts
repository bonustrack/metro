/**
 * Persisted config — daemon URL, bearer token, self URI.
 *
 * Stored in `expo-secure-store` (Keychain/Keystore) on native; falls back to
 * an in-memory map on web (Secure Store isn't supported on web).
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEYS = {
  daemonUrl: 'metro_daemon_url',
  token: 'metro_bearer_token',
  userId: 'metro_user_id',
} as const;

export type Config = {
  daemonUrl: string;
  token: string;
  userId: string;
};

const memWeb: Record<string, string> = {};

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return memWeb[key] ?? null;
  try { return await SecureStore.getItemAsync(key); }
  catch { return null; }
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') { memWeb[key] = value; return; }
  await SecureStore.setItemAsync(key, value);
}

export async function loadConfig(): Promise<Config> {
  const [daemonUrl, token, userId] = await Promise.all([
    getItem(KEYS.daemonUrl),
    getItem(KEYS.token),
    getItem(KEYS.userId),
  ]);
  return {
    daemonUrl: daemonUrl ?? '',
    token: token ?? '',
    userId: userId ?? '',
  };
}

export async function saveConfig(cfg: Config): Promise<void> {
  await Promise.all([
    setItem(KEYS.daemonUrl, cfg.daemonUrl.trim()),
    setItem(KEYS.token, cfg.token.trim()),
    setItem(KEYS.userId, cfg.userId.trim()),
  ]);
}

/** True iff all three required fields are set — the auth-guard uses this. */
export function isConfigured(cfg: Config): boolean {
  return !!cfg.daemonUrl && !!cfg.token;
}
