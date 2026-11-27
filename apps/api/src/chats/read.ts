import { CHAT_FILES_MAX, CHAT_TEXT_MAX, chatFileOf, chatTitleOf, type ChatFile } from '@metro-labs/core/chat';
import { newId, parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { ApiError } from '@metro-labs/http/api-error';
import type { ChatSigner } from '@metro-labs/http/chat-ticket';
import type { Session } from '@metro-labs/http/user-token';
import type { Database } from '../db/client.js';
import {
  CHAT_MEMBERS_MAX,
  CHATS_PER_PERSON_MAX,
  chatAgentOf,
  chatsStartedBy,
  chatOf,
  insertChat,
  lastMessagesOf,
  markSeen,
  membersAmong,
  membersOf,
  messagesOf,
  peopleOf,
  pinsOf,
  seenOf,
  visibleChats,
  type ChatRow,
  type LastMessage,
  type MessageRow,
  type Person,
} from '../db/chats.js';
import {
  canSee,
  chatKeysOf,
  chatView,
  isGroup,
  messageView,
  sealBody,
  sealTitle,
  sendTicket,
  viewTicket,
  type ChatActivity,
  type ChatKeys,
  type ChatView,
  type MessageView,
} from './model.js';

export interface ChatsDeps {
  db: () => Database;
  seal: () => Buffer | null;
  signer: () => ChatSigner | null;
  now: () => number;
}

export interface Caller {
  session: Session;
  owner: string;
}

export interface OpenChat {
  row: ChatRow;
  members: string[];
  keys: ChatKeys;
}

export const keysOf = (deps: ChatsDeps): ChatKeys => chatKeysOf(deps.seal(), deps.signer());

const NOT_FOUND = (): ApiError => new ApiError('no such chat', 404);

export async function openChat(deps: ChatsDeps, caller: Caller, rawId: string): Promise<OpenChat> {
  const id = parseId(rawId);
  if (id === null) throw NOT_FOUND();
  const keys = keysOf(deps);
  const row = await chatOf(deps.db(), caller.owner, id);
  if (row === null) throw NOT_FOUND();
  const members = (await membersOf(deps.db(), [row.id])).get(row.id) ?? [];
  if (!canSee(row, caller.session.userId, members)) throw NOT_FOUND();
  return { row, members, keys };
}

export interface MessageInput {
  text: string;
  files: ChatFile[];
}

function newFilesOf(value: unknown): ChatFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CHAT_FILES_MAX) throw new ApiError(`files must be a list of at most ${String(CHAT_FILES_MAX)}`, 400);
  return value.map((raw) => {
    const file = chatFileOf({ ...(isRecord(raw) ? raw : {}), id: newId() });
    if (file === null) throw new ApiError('each file needs a name and a size of at most 20 MB', 400);
    return file;
  });
}

export function messageInputOf(body: unknown): MessageInput {
  const files = newFilesOf(isRecord(body) ? body.files : undefined);
  const text = isRecord(body) && typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '' && files.length === 0) throw new ApiError('text must not be empty', 400);
  if (text.length > CHAT_TEXT_MAX) throw new ApiError(`text must be at most ${String(CHAT_TEXT_MAX)} characters`, 400);
  return { text, files };
}

export const bodyOf = (input: MessageInput): Record<string, unknown> => (input.files.length === 0 ? { text: input.text } : { text: input.text, files: input.files });

export async function validMembers(deps: ChatsDeps, owner: string, creator: string, value: unknown, kept: readonly string[] = []): Promise<string[]> {
  if (!Array.isArray(value) || value.length > CHAT_MEMBERS_MAX || !value.every((user): user is string => typeof user === 'string')) throw new ApiError(`members must be a list of at most ${String(CHAT_MEMBERS_MAX)} user ids`, 400);
  const wanted = [...new Set(value)].filter((user) => user !== creator);
  const known = await membersAmong(deps.db(), owner, wanted);
  if (wanted.some((user) => !known.has(user) && !kept.includes(user))) throw new ApiError('every member must belong to this organization', 400);
  return wanted.filter((user) => known.has(user));
}

export const nameOf = (person: Person | undefined): string => person?.name ?? person?.email ?? 'A member';

export const isAdmin = (caller: Caller): boolean => caller.session.role === 'admin';

export const senderOf = (person: Person | undefined): { name: string; email: string | null } => ({ name: nameOf(person), email: person?.email ?? null });

export async function callerSender(deps: ChatsDeps, caller: Caller): Promise<{ name: string; email: string | null }> {
  const [person] = await peopleOf(deps.db(), [caller.session.userId]);
  return senderOf(person);
}

const WORKING_MS = 130 * 60_000;

export function activityOf(last: LastMessage | undefined, seen: number, now: number, touched: number): ChatActivity {
  if (last === undefined) return null;
  if (last.role === 'user') return now - Math.max(last.at, touched) < WORKING_MS ? 'working' : null;
  return last.seq > seen ? 'unread' : null;
}

export async function activitiesOf(deps: ChatsDeps, user: string, rows: readonly ChatRow[]): Promise<Map<string, ChatActivity>> {
  const ids = rows.map((row) => row.id);
  const [last, seen] = await Promise.all([lastMessagesOf(deps.db(), ids), seenOf(deps.db(), user, ids)]);
  const now = deps.now();
  return new Map(rows.map((row) => [row.id, activityOf(last.get(row.id), seen.get(row.id) ?? 0, now, row.updatedAt)]));
}

export async function listChats(deps: ChatsDeps, caller: Caller): Promise<{ chats: ChatView[] }> {
  const keys = keysOf(deps);
  const rows = await visibleChats(deps.db(), caller.owner, caller.session.userId);
  const ids = rows.map((row) => row.id);
  const [members, pins, activities] = await Promise.all([membersOf(deps.db(), ids), pinsOf(deps.db(), caller.session.userId, ids), activitiesOf(deps, caller.session.userId, rows)]);
  return { chats: rows.map((row) => chatView(keys, row, caller.session, members.get(row.id) ?? [], pins.has(row.id), activities.get(row.id) ?? null)) };
}

async function boxAgent(deps: ChatsDeps, owner: string, body: unknown): Promise<string> {
  const agent = parseId(isRecord(body) ? body.agent : undefined);
  const row = agent === null ? null : await chatAgentOf(deps.db(), owner, agent);
  if (row === null) throw new ApiError('no such agent', 404);
  if (row.kind !== 'box' || row.host === null) throw new ApiError('Only an agent with a server can chat for now.', 409);
  return row.id;
}

export async function createChat(deps: ChatsDeps, caller: Caller, body: unknown): Promise<{ chat: ChatView; message: MessageView; ticket: string }> {
  const keys = keysOf(deps);
  const input = messageInputOf(body);
  const agent = await boxAgent(deps, caller.owner, body);
  if ((await chatsStartedBy(deps.db(), caller.owner, caller.session.userId)) >= CHATS_PER_PERSON_MAX) throw new ApiError(`You have ${String(CHATS_PER_PERSON_MAX)} chats in this organization. Delete some to start a new one.`, 409);
  const now = deps.now();
  const id = newId();
  const messageId = newId();
  const row: ChatRow = { id, owner: caller.owner, agent, createdBy: caller.session.userId, title: sealTitle(keys, caller.owner, id, chatTitleOf(input.text === '' ? (input.files[0]?.name ?? '') : input.text)), shared: 'private', createdAt: now, updatedAt: now };
  const first = { id: messageId, chat: id, seq: 1, role: 'user' as const, author: caller.session.userId, replyTo: null, body: sealBody(keys, caller.owner, id, messageId, bodyOf(input)), at: now };
  const members = await validMembers(deps, caller.owner, caller.session.userId, isRecord(body) && body.members !== undefined ? body.members : []);
  const sender = await callerSender(deps, caller);
  await insertChat(deps.db(), row, first, members);
  const ctx = { chat: row, session: caller.session, ...sender, admin: isAdmin(caller), group: members.length > 0 };
  return { chat: chatView(keys, row, caller.session, members, false, 'working'), message: messageView(keys, caller.owner, first), ticket: sendTicket(keys, ctx, messageId, input, now) };
}

export interface ChatPage {
  chat: ChatView;
  messages: MessageView[];
  people: Person[];
  ticket: string;
}

async function readUpTo(deps: ChatsDeps, caller: Caller, chat: string, newest: MessageRow | undefined): Promise<number> {
  if (newest === undefined) return (await seenOf(deps.db(), caller.session.userId, [chat])).get(chat) ?? 0;
  await markSeen(deps.db(), chat, caller.session.userId, newest.seq);
  return newest.seq;
}

export async function readChat(deps: ChatsDeps, caller: Caller, rawId: string, seen = true): Promise<ChatPage> {
  const { row, members, keys } = await openChat(deps, caller, rawId);
  const [rows, pins] = await Promise.all([messagesOf(deps.db(), row.id), pinsOf(deps.db(), caller.session.userId, [row.id])]);
  const authors = rows.flatMap((m) => (m.author === null ? [] : [m.author]));
  const people = await peopleOf(deps.db(), [row.createdBy, ...members, ...authors, caller.session.userId]);
  const me = people.find((person) => person.id === caller.session.userId);
  const ctx = { chat: row, session: caller.session, ...senderOf(me), admin: isAdmin(caller), group: isGroup(row, members) };
  const last = rows.at(-1);
  const read = await readUpTo(deps, caller, row.id, seen ? last : undefined);
  return {
    chat: chatView(keys, row, caller.session, members, pins.has(row.id), activityOf(last, read, deps.now(), row.updatedAt)),
    messages: rows.map((m) => messageView(keys, row.owner, m)),
    people,
    ticket: viewTicket(keys, ctx, deps.now()),
  };
}
