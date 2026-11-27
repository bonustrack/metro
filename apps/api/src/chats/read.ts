import { CHAT_TEXT_MAX, chatTitleOf } from '@metro-labs/core/chat';
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
  membersAmong,
  membersOf,
  messagesOf,
  peopleOf,
  pinsOf,
  visibleChats,
  type ChatRow,
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

export function textOf(body: unknown): string {
  const text = isRecord(body) && typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '') throw new ApiError('text must not be empty', 400);
  if (text.length > CHAT_TEXT_MAX) throw new ApiError(`text must be at most ${String(CHAT_TEXT_MAX)} characters`, 400);
  return text;
}

export async function validMembers(deps: ChatsDeps, owner: string, creator: string, value: unknown, kept: readonly string[] = []): Promise<string[]> {
  if (!Array.isArray(value) || value.length > CHAT_MEMBERS_MAX || !value.every((user): user is string => typeof user === 'string')) throw new ApiError(`members must be a list of at most ${String(CHAT_MEMBERS_MAX)} user ids`, 400);
  const wanted = [...new Set(value)].filter((user) => user !== creator);
  const known = await membersAmong(deps.db(), owner, wanted);
  if (wanted.some((user) => !known.has(user) && !kept.includes(user))) throw new ApiError('every member must belong to this organization', 400);
  return wanted.filter((user) => known.has(user));
}

export const nameOf = (person: Person | undefined): string => person?.name ?? person?.email ?? 'A member';

export const senderOf = (person: Person | undefined): { name: string; email: string | null } => ({ name: nameOf(person), email: person?.email ?? null });

export async function callerSender(deps: ChatsDeps, caller: Caller): Promise<{ name: string; email: string | null }> {
  const [person] = await peopleOf(deps.db(), [caller.session.userId]);
  return senderOf(person);
}

export async function listChats(deps: ChatsDeps, caller: Caller): Promise<{ chats: ChatView[] }> {
  const keys = keysOf(deps);
  const rows = await visibleChats(deps.db(), caller.owner, caller.session.userId);
  const ids = rows.map((row) => row.id);
  const [members, pins] = await Promise.all([membersOf(deps.db(), ids), pinsOf(deps.db(), caller.session.userId, ids)]);
  return { chats: rows.map((row) => chatView(keys, row, caller.session, members.get(row.id) ?? [], pins.has(row.id))) };
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
  const text = textOf(body);
  const agent = await boxAgent(deps, caller.owner, body);
  if ((await chatsStartedBy(deps.db(), caller.owner, caller.session.userId)) >= CHATS_PER_PERSON_MAX) throw new ApiError(`You have ${String(CHATS_PER_PERSON_MAX)} chats in this organization. Delete some to start a new one.`, 409);
  const now = deps.now();
  const id = newId();
  const messageId = newId();
  const row: ChatRow = { id, owner: caller.owner, agent, createdBy: caller.session.userId, title: sealTitle(keys, caller.owner, id, chatTitleOf(text)), shared: 'private', createdAt: now, updatedAt: now };
  const first = { id: messageId, chat: id, seq: 1, role: 'user' as const, author: caller.session.userId, replyTo: null, body: sealBody(keys, caller.owner, id, messageId, { text }), at: now };
  const members = await validMembers(deps, caller.owner, caller.session.userId, isRecord(body) && body.members !== undefined ? body.members : []);
  const sender = await callerSender(deps, caller);
  await insertChat(deps.db(), row, first, members);
  const ctx = { chat: row, session: caller.session, ...sender, group: members.length > 0 };
  return { chat: chatView(keys, row, caller.session, members, false), message: messageView(keys, caller.owner, first), ticket: sendTicket(keys, ctx, messageId, text, now) };
}

export interface ChatPage {
  chat: ChatView;
  messages: MessageView[];
  people: Person[];
  ticket: string;
}

export async function readChat(deps: ChatsDeps, caller: Caller, rawId: string): Promise<ChatPage> {
  const { row, members, keys } = await openChat(deps, caller, rawId);
  const [rows, pins] = await Promise.all([messagesOf(deps.db(), row.id), pinsOf(deps.db(), caller.session.userId, [row.id])]);
  const authors = rows.flatMap((m) => (m.author === null ? [] : [m.author]));
  const people = await peopleOf(deps.db(), [row.createdBy, ...members, ...authors, caller.session.userId]);
  const me = people.find((person) => person.id === caller.session.userId);
  const ctx = { chat: row, session: caller.session, ...senderOf(me), group: isGroup(row, members) };
  return {
    chat: chatView(keys, row, caller.session, members, pins.has(row.id)),
    messages: rows.map((m) => messageView(keys, row.owner, m)),
    people,
    ticket: viewTicket(keys, ctx, deps.now()),
  };
}
