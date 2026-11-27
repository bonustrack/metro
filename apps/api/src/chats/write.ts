import { CHAT_TITLE_MAX } from '@metro-labs/core/chat';
import { newId, parseId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import {
  appendMessage,
  deleteChat,
  messageOf,
  peopleOf,
  pinsOf,
  replyOf,
  setMembers,
  setPinned,
  updateChat,
  type ChatShared,
} from '../db/chats.js';
import { canManage, chatView, isGroup, messageView, sealBody, sealTitle, sendTicket, viewTicket, type ChatView, type MessageView } from './model.js';
import { activitiesOf, callerName, nameOf, validMembers, openChat, textOf, type Caller, type ChatsDeps, type OpenChat } from './read.js';

function managed(open: OpenChat, caller: Caller): void {
  if (!canManage(open.row, caller.session)) throw new ApiError('Only the person who started this chat or an admin can change it.', 403);
}

function sharedOf(value: unknown): ChatShared | undefined {
  if (value === undefined) return undefined;
  if (value === 'private' || value === 'organization') return value;
  throw new ApiError('shared must be private or organization', 400);
}

function titleOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (title === '' || title.length > CHAT_TITLE_MAX) throw new ApiError(`title must be 1 to ${String(CHAT_TITLE_MAX)} characters`, 400);
  return title;
}

export async function changeChat(deps: ChatsDeps, caller: Caller, rawId: string, body: unknown): Promise<{ chat: ChatView }> {
  const open = await openChat(deps, caller, rawId);
  managed(open, caller);
  const input = isRecord(body) ? body : {};
  const title = titleOf(input.title);
  const shared = sharedOf(input.shared);
  const members = input.members === undefined ? undefined : await validMembers(deps, caller.owner, open.row.createdBy, input.members, open.members);
  const now = deps.now();
  const sealed = title === undefined ? {} : { title: sealTitle(open.keys, caller.owner, open.row.id, title) };
  await updateChat(deps.db(), open.row.id, { ...sealed, ...(shared === undefined ? {} : { shared }) });
  if (members !== undefined) await setMembers(deps.db(), open.row.id, members, caller.session.userId, now);
  log.info({ chat: open.row.id, by: caller.session.userId, shared, members: members?.length, renamed: title !== undefined }, 'chats: a chat changed');
  const row = { ...open.row, ...sealed, ...(shared === undefined ? {} : { shared }) };
  const pinned = (await pinsOf(deps.db(), caller.session.userId, [row.id])).has(row.id);
  const activity = (await activitiesOf(deps, caller.session.userId, [row.id])).get(row.id) ?? null;
  return { chat: chatView(open.keys, row, caller.session, members ?? open.members, pinned, activity) };
}

export async function removeChat(deps: ChatsDeps, caller: Caller, rawId: string): Promise<{ deleted: boolean }> {
  const open = await openChat(deps, caller, rawId);
  managed(open, caller);
  const deleted = await deleteChat(deps.db(), open.row.id);
  log.info({ chat: open.row.id, by: caller.session.userId }, 'chats: a chat was deleted');
  return { deleted };
}

export async function pinChat(deps: ChatsDeps, caller: Caller, rawId: string, pinned: boolean): Promise<{ pinned: boolean }> {
  const open = await openChat(deps, caller, rawId);
  await setPinned(deps.db(), caller.session.userId, open.row.id, pinned, deps.now());
  return { pinned };
}

const contextOf = async (deps: ChatsDeps, caller: Caller, open: OpenChat) => ({
  chat: open.row,
  session: caller.session,
  name: await callerName(deps, caller),
  group: isGroup(open.row, open.members),
});

export async function postMessage(deps: ChatsDeps, caller: Caller, rawId: string, body: unknown): Promise<{ message: MessageView; ticket: string }> {
  const open = await openChat(deps, caller, rawId);
  const text = textOf(body);
  const now = deps.now();
  const id = newId();
  const row = { id, chat: open.row.id, role: 'user' as const, author: caller.session.userId, replyTo: null, body: sealBody(open.keys, caller.owner, open.row.id, id, { text }), at: now };
  const seq = await appendMessage(deps.db(), row);
  if (seq === null) throw new ApiError('The agent is still answering the last message. Wait for its reply, or use Try again on it.', 409);
  const ctx = await contextOf(deps, caller, open);
  return { message: messageView(open.keys, caller.owner, { ...row, seq }), ticket: sendTicket(open.keys, ctx, id, text, now) };
}

export async function retryTicket(deps: ChatsDeps, caller: Caller, rawId: string, rawMessage: string): Promise<{ ticket: string }> {
  const open = await openChat(deps, caller, rawId);
  const id = parseId(rawMessage);
  const message = id === null ? null : await messageOf(deps.db(), open.row.id, id);
  if (message?.role !== 'user') throw new ApiError('no such message', 404);
  if ((await replyOf(deps.db(), open.row.id, message.id)) !== null) throw new ApiError('This message already has a reply.', 409);
  const text = messageView(open.keys, caller.owner, message).text;
  if (text === null) throw new ApiError('This message could not be read, so it cannot be sent again.', 409);
  const [author] = await peopleOf(deps.db(), [message.author ?? caller.session.userId]);
  const ctx = { chat: open.row, session: caller.session, name: nameOf(author), group: isGroup(open.row, open.members) };
  return { ticket: sendTicket(open.keys, ctx, message.id, text, deps.now()) };
}

export async function watchTicket(deps: ChatsDeps, caller: Caller, rawId: string): Promise<{ ticket: string }> {
  const open = await openChat(deps, caller, rawId);
  return { ticket: viewTicket(open.keys, await contextOf(deps, caller, open), deps.now()) };
}
