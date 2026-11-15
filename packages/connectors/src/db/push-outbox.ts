import { and, asc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { newId } from '@metro-labs/core/ids';
import type { Database } from './database.js';
import { pushOutbox } from './schema.js';

export const PUSH_ATTEMPTS_MAX = 5;
export const PUSH_KEEP_MS = 24 * 60 * 60_000;
export const PUSH_TEXT_MAX = 200;
export const PUSH_URL_MAX = 512;

export type QueuedPush = typeof pushOutbox.$inferSelect;

export interface PushRequest {
  owner: string;
  agent: string;
  approval: string;
  title: string;
  body: string;
  url: string;
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export async function queuePush(db: Database, push: PushRequest, now: number): Promise<boolean> {
  if (push.url.length > PUSH_URL_MAX) throw new Error('the notification link is too long');
  const row = { id: newId(), owner: push.owner, agent: push.agent, approval: push.approval, title: cut(push.title, PUSH_TEXT_MAX), body: cut(push.body, PUSH_TEXT_MAX), url: push.url, createdAt: now, nextAt: now };
  const inserted = await db.insert(pushOutbox).values(row).onConflictDoNothing().returning({ id: pushOutbox.id });
  return inserted.length > 0;
}

export async function claimPushes(db: Database, now: number, limit: number): Promise<QueuedPush[]> {
  const due = and(isNull(pushOutbox.sentAt), lte(pushOutbox.nextAt, now), lt(pushOutbox.attempts, PUSH_ATTEMPTS_MAX));
  const oldest = db.select({ id: pushOutbox.id }).from(pushOutbox).where(due).orderBy(asc(pushOutbox.nextAt)).limit(limit);
  return db
    .update(pushOutbox)
    .set({ sentAt: now, attempts: sql`${pushOutbox.attempts} + 1` })
    .where(and(inArray(pushOutbox.id, oldest), due))
    .returning();
}

export async function releasePush(db: Database, id: string, nextAt: number): Promise<void> {
  await db.update(pushOutbox).set({ sentAt: null, nextAt }).where(eq(pushOutbox.id, id));
}

export async function prunePushes(db: Database, now: number): Promise<number> {
  const removed = await db.delete(pushOutbox).where(lt(pushOutbox.createdAt, now - PUSH_KEEP_MS)).returning({ id: pushOutbox.id });
  return removed.length;
}
