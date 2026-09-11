import { isRecord } from '../api/accounts.js';

export interface AwsSettings {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface Launch {
  instanceId: string;
  region: string;
  name: string;
  launchedAt: string;
}

const SETTINGS_KEY = 'metro.aws';
const LAUNCHES_KEY = 'metro.aws.launches';
const KEYS_KEY = 'metro.aws.keys';
export const BOOT_WINDOW_MS = 30 * 60_000;
const SLUG_MAX = 30;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readRecord(key: string): Record<string, unknown> | null {
  try {
    const raw = storage()?.getItem(key);
    const parsed: unknown = raw === null || raw === undefined ? null : JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function readAwsSettings(): AwsSettings | null {
  const raw = readRecord(SETTINGS_KEY);
  if (raw === null) return null;
  const settings = { accessKeyId: str(raw.accessKeyId), secretAccessKey: str(raw.secretAccessKey), region: str(raw.region) };
  return settings.accessKeyId === '' || settings.secretAccessKey === '' ? null : settings;
}

export function storeAwsSettings(settings: AwsSettings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function launches(): Record<string, Launch> {
  const raw = readRecord(LAUNCHES_KEY);
  if (raw === null) return {};
  const out: Record<string, Launch> = {};
  for (const [host, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const v = value;
    if (str(v.instanceId) !== '' && str(v.region) !== '')
      out[host] = { instanceId: str(v.instanceId), region: str(v.region), name: str(v.name), launchedAt: str(v.launchedAt) };
  }
  return out;
}

export function recordLaunch(host: string, launch: Launch): void {
  writeJson(LAUNCHES_KEY, { ...launches(), [host]: launch });
}

export function bootingLaunch(host: string, now = Date.now()): Launch | null {
  const launch = launches()[host];
  if (launch === undefined) return null;
  const at = Date.parse(launch.launchedAt);
  return Number.isFinite(at) && now - at < BOOT_WINDOW_MS ? launch : null;
}

export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

export const nodeNameOf = (slug: string): string => `metro-${slug}`;

const TAILNET_HOST = /^[a-z0-9-]+\.((?:[a-z0-9-]+\.)*ts\.net)$/i;

export function tailnetSuffix(hosts: string[]): string | null {
  for (const host of hosts) {
    const m = TAILNET_HOST.exec(host.split(':')[0] ?? '');
    if (m?.[1] !== undefined) return m[1].toLowerCase();
  }
  return null;
}

export const hostOf = (node: string, suffix: string): string => `${node}.${suffix.replace(/^\.+|\.+$/g, '')}`;

export interface UsedKey {
  name: string;
  at: string;
}

export function authKeyUsedFor(fingerprint: string): UsedKey | null {
  const raw = readRecord(KEYS_KEY);
  const entry = raw?.[fingerprint];
  if (!isRecord(entry) || str(entry.name) === '') return null;
  return { name: str(entry.name), at: str(entry.at) };
}

export function rememberAuthKey(fingerprint: string, used: UsedKey): void {
  writeJson(KEYS_KEY, { ...(readRecord(KEYS_KEY) ?? {}), [fingerprint]: used });
}
