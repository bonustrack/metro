import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { isUniqueViolation } from '@metro-labs/connectors/db/errors';
import type { Database } from './client.js';
import { agents, chatMembers, chatMessages, chatPins, chatReads, chats, memberships, users } from './schema.js';

const CHATS_LISTED_MAX = 200;
const CHAT_MESSAGES_MAX = 500;
const PAGE_BYTES_MAX = 4 * 1024 * 1024;
export const CHATS_PER_PERSON_MAX = 5_000;
export const CHAT_MEMBERS_MAX = 50;
const SEQ_TRIES = 4;

export type ChatShared = 'private' | 'organization';

export interface ChatRow {
  id: string;
  owner: string;
  agent: string;
  createdBy: string;
  title: string;
  shared: ChatShared;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRow {
  id: string;
  chat: string;
  seq: number;
  role: 'user' | 'assistant';
  author: string | null;
  replyTo: string | null;
  body: string;
  at: number;
}

export interface Person {
  id: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

interface ChatAgent {
  id: string;
  host: string | null;
  kind: string;
}

const chatColumns = {
  id: chats.id,
  owner: chats.owner,
  agent: chats.agent,
  createdBy: chats.createdBy,
  title: chats.title,
  shared: chats.shared,
  createdAt: chats.createdAt,
  updatedAt: chats.updatedAt,
};

export async function chatAgentOf(db: Database, owner: string, agent: string): Promise<ChatAgent | null> {
  const rows = await db.select({ id: agents.id, host: agents.host, kind: agents.kind }).from(agents).where(and(eq(agents.id, agent), eq(agents.owner, owner))).limit(1);
  return rows[0] ?? null;
}

const memberOf = (user: string) =>
  sql`exists (select 1 from ${chatMembers} where ${chatMembers.chat} = ${chats.id} and ${chatMembers.userId} = ${user})`;

const pinnedBy = (user: string) =>
  sql<boolean>`exists (select 1 from ${chatPins} where ${chatPins.chat} = ${chats.id} and ${chatPins.userId} = ${user})`;

export async function visibleChats(db: Database, owner: string, user: string): Promise<ChatRow[]> {
  return db
    .select(chatColumns)
    .from(chats)
    .innerJoin(agents, and(eq(agents.id, chats.agent), eq(agents.owner, chats.owner)))
    .where(and(eq(chats.owner, owner), or(eq(chats.createdBy, user), eq(chats.shared, 'organization'), memberOf(user))))
    .orderBy(desc(pinnedBy(user)), desc(chats.updatedAt), asc(chats.id))
    .limit(CHATS_LISTED_MAX);
}

export async function chatOf(db: Database, owner: string, id: string): Promise<ChatRow | null> {
  const rows = await db
    .select(chatColumns)
    .from(chats)
    .innerJoin(agents, and(eq(agents.id, chats.agent), eq(agents.owner, chats.owner)))
    .where(and(eq(chats.id, id), eq(chats.owner, owner)))
    .limit(1);
  return rows[0] ?? null;
}

export async function membersOf(db: Database, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await db.select({ chat: chatMembers.chat, user: chatMembers.userId }).from(chatMembers).where(inArray(chatMembers.chat, [...ids])).orderBy(asc(chatMembers.addedAt), asc(chatMembers.userId));
  for (const row of rows) out.set(row.chat, [...(out.get(row.chat) ?? []), row.user]);
  return out;
}

export async function pinsOf(db: Database, user: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ chat: chatPins.chat }).from(chatPins).where(and(eq(chatPins.userId, user), inArray(chatPins.chat, [...ids])));
  return new Set(rows.map((row) => row.chat));
}

export async function setPinned(db: Database, user: string, chat: string, pinned: boolean, now: number): Promise<void> {
  if (!pinned) {
    await db.delete(chatPins).where(and(eq(chatPins.userId, user), eq(chatPins.chat, chat)));
    return;
  }
  await db.insert(chatPins).values({ userId: user, chat, pinnedAt: now }).onConflictDoNothing();
}

export async function insertChat(db: Database, chat: ChatRow, first: MessageRow, members: readonly string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(chats).values(chat);
    await tx.insert(chatMessages).values(first);
    if (members.length > 0) await tx.insert(chatMembers).values(members.map((userId) => ({ chat: chat.id, userId, addedBy: chat.createdBy, addedAt: chat.createdAt })));
  });
}

export async function updateChat(db: Database, id: string, set: Partial<Pick<ChatRow, 'title' | 'shared'>>): Promise<void> {
  if (Object.keys(set).length === 0) return;
  await db.update(chats).set(set).where(eq(chats.id, id));
}

export async function setMembers(db: Database, chat: string, list: readonly string[], by: string, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(chatMembers).where(eq(chatMembers.chat, chat));
    if (list.length > 0) await tx.insert(chatMembers).values(list.map((userId) => ({ chat, userId, addedBy: by, addedAt: now })));
  });
}

export async function deleteChat(db: Database, id: string): Promise<boolean> {
  const removed = await db.delete(chats).where(eq(chats.id, id)).returning({ id: chats.id });
  return removed.length > 0;
}

export async function dropAgentChats(db: Database, agent: string): Promise<void> {
  await db.delete(chats).where(eq(chats.agent, agent));
}

const messageColumns = {
  id: chatMessages.id,
  chat: chatMessages.chat,
  seq: chatMessages.seq,
  role: chatMessages.role,
  author: chatMessages.author,
  replyTo: chatMessages.replyTo,
  body: chatMessages.body,
  at: chatMessages.at,
};

function firstSeqWithin(sizes: readonly { seq: number; size: number }[]): number {
  let total = 0;
  let first = sizes[0]?.seq ?? 0;
  for (const row of sizes) {
    total += row.size;
    if (total > PAGE_BYTES_MAX) break;
    first = row.seq;
  }
  return first;
}

export async function messagesOf(db: Database, chat: string): Promise<MessageRow[]> {
  const sizes = await db
    .select({ seq: chatMessages.seq, size: sql<number>`length(${chatMessages.body})` })
    .from(chatMessages)
    .where(eq(chatMessages.chat, chat))
    .orderBy(desc(chatMessages.seq))
    .limit(CHAT_MESSAGES_MAX);
  if (sizes.length === 0) return [];
  return db.select(messageColumns).from(chatMessages).where(and(eq(chatMessages.chat, chat), gte(chatMessages.seq, firstSeqWithin(sizes)))).orderBy(asc(chatMessages.seq));
}

export async function chatsStartedBy(db: Database, owner: string, user: string): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(chats).where(and(eq(chats.owner, owner), eq(chats.createdBy, user)));
  return rows[0]?.count ?? 0;
}

export async function messageOf(db: Database, chat: string, id: string): Promise<MessageRow | null> {
  const rows = await db.select(messageColumns).from(chatMessages).where(and(eq(chatMessages.chat, chat), eq(chatMessages.id, id))).limit(1);
  return rows[0] ?? null;
}

export async function replyOf(db: Database, chat: string, message: string): Promise<MessageRow | null> {
  const rows = await db.select(messageColumns).from(chatMessages).where(and(eq(chatMessages.chat, chat), eq(chatMessages.replyTo, message))).limit(1);
  return rows[0] ?? null;
}

async function insertNext(db: Database, row: Omit<MessageRow, 'seq'>): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [top] = await tx.select({ seq: chatMessages.seq, role: chatMessages.role }).from(chatMessages).where(eq(chatMessages.chat, row.chat)).orderBy(desc(chatMessages.seq)).limit(1);
    if (row.role === 'user' && top?.role === 'user') return null;
    const seq = (top?.seq ?? 0) + 1;
    await tx.insert(chatMessages).values({ ...row, seq });
    await tx.update(chats).set({ updatedAt: row.at }).where(eq(chats.id, row.chat));
    return seq;
  });
}

export async function appendMessage(db: Database, row: Omit<MessageRow, 'seq'>): Promise<number | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await insertNext(db, row);
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= SEQ_TRIES) throw err;
    }
  }
}

export async function replaceReply(db: Database, chat: string, id: string, body: string, at: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(chatMessages).set({ body, at }).where(and(eq(chatMessages.chat, chat), eq(chatMessages.id, id)));
    await tx.update(chats).set({ updatedAt: at }).where(eq(chats.id, chat));
  });
}

export interface LastMessage {
  role: 'user' | 'assistant';
  seq: number;
  at: number;
}

export async function lastMessagesOf(db: Database, ids: readonly string[]): Promise<Map<string, LastMessage>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([chatMessages.chat], { chat: chatMessages.chat, role: chatMessages.role, seq: chatMessages.seq, at: chatMessages.at })
    .from(chatMessages)
    .where(inArray(chatMessages.chat, [...ids]))
    .orderBy(chatMessages.chat, desc(chatMessages.seq));
  return new Map(rows.map((row) => [row.chat, { role: row.role, seq: row.seq, at: row.at }]));
}

export async function seenOf(db: Database, user: string, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ chat: chatReads.chat, seq: chatReads.seenSeq }).from(chatReads).where(and(eq(chatReads.userId, user), inArray(chatReads.chat, [...ids])));
  return new Map(rows.map((row) => [row.chat, row.seq]));
}

export async function markSeen(db: Database, chat: string, user: string, seq: number): Promise<void> {
  await db
    .insert(chatReads)
    .values({ chat, userId: user, seenSeq: seq })
    .onConflictDoUpdate({ target: [chatReads.chat, chatReads.userId], set: { seenSeq: seq }, setWhere: sql`${chatReads.seenSeq} < ${seq}` });
}

export async function peopleOf(db: Database, ids: readonly string[]): Promise<Person[]> {
  if (ids.length === 0) return [];
  return db.select({ id: users.id, name: users.name, email: users.email, picture: users.picture }).from(users).where(inArray(users.id, [...new Set(ids)])).orderBy(asc(users.id));
}

export async function membersAmong(db: Database, owner: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.select({ user: memberships.userId }).from(memberships).where(and(eq(memberships.organization, owner), inArray(memberships.userId, [...ids])));
  return new Set(rows.map((row) => row.user));
}
