import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import type { Database } from './client.js';
import { pushDevices } from './schema.js';

export const PUSH_DEVICES_MAX = 10;
export const PUSH_PLATFORMS = ['android', 'ios'] as const;
export const EXPO_PUSH_TOKEN_RE = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export interface PushDevice {
  user: string;
  token: string;
  platform: PushPlatform;
  now: number;
}

export const isPushPlatform = (value: unknown): value is PushPlatform => typeof value === 'string' && (PUSH_PLATFORMS as readonly string[]).includes(value);

export async function registerPushDevice(db: Database, device: PushDevice): Promise<void> {
  await db
    .insert(pushDevices)
    .values({ id: newId(), userId: device.user, token: device.token, platform: device.platform, createdAt: device.now, lastSeenAt: device.now })
    .onConflictDoUpdate({ target: pushDevices.token, set: { userId: device.user, platform: device.platform, lastSeenAt: device.now } });
  const kept = db.select({ id: pushDevices.id }).from(pushDevices).where(eq(pushDevices.userId, device.user)).orderBy(desc(pushDevices.lastSeenAt), desc(pushDevices.id)).limit(PUSH_DEVICES_MAX);
  await db.delete(pushDevices).where(and(eq(pushDevices.userId, device.user), notInArray(pushDevices.id, kept)));
}

export async function dropPushDevice(db: Database, user: string, token: string): Promise<boolean> {
  const removed = await db.delete(pushDevices).where(and(eq(pushDevices.userId, user), eq(pushDevices.token, token))).returning({ id: pushDevices.id });
  return removed.length > 0;
}

export async function pushTokensOf(db: Database, users: string[]): Promise<string[]> {
  if (users.length === 0) return [];
  const rows = await db.select({ token: pushDevices.token }).from(pushDevices).where(inArray(pushDevices.userId, users)).orderBy(pushDevices.token);
  return rows.map((row) => row.token);
}

export async function dropPushTokens(db: Database, tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  const removed = await db.delete(pushDevices).where(inArray(pushDevices.token, tokens)).returning({ id: pushDevices.id });
  return removed.length;
}
