import { chatFilesOf, chatReplyOf, type ChatFile, type ChatReply } from '@metro-labs/core/chat';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { signChatTicket, textDigest, type ChatSigner } from '@metro-labs/http/chat-ticket';
import type { Session } from '@metro-labs/http/user-token';
import { openSecret, sealSecret } from '@metro-labs/connectors/secrets';
import type { ChatRow, ChatShared, MessageRow } from '../db/chats.js';

export type ChatActivity = 'working' | 'unread' | null;

export interface ChatView {
  id: string;
  agent: string;
  title: string;
  createdBy: string;
  shared: ChatShared;
  members: string[];
  pinned: boolean;
  manage: boolean;
  activity: ChatActivity;
  createdAt: number;
  updatedAt: number;
}

export interface MessageView {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  author: string | null;
  replyTo: string | null;
  at: number;
  text: string | null;
  files: ChatFile[];
  reply: ChatReply | null;
}

export interface ChatKeys {
  seal: Buffer;
  signer: ChatSigner;
}

const notSetUp = (what: string): ApiError => new ApiError(`Chats are not set up on this server: ${what} is unset.`, 503);

export function chatKeysOf(seal: Buffer | null, signer: ChatSigner | null): ChatKeys {
  if (seal === null) throw notSetUp('METRO_CONNECTORS_KEY');
  if (signer === null) throw notSetUp('METRO_AUTH_SIGNING_KEY');
  return { seal, signer };
}

export const canSee = (chat: ChatRow, user: string, members: readonly string[]): boolean =>
  chat.createdBy === user || chat.shared === 'organization' || members.includes(user);

export const canManage = (chat: ChatRow, session: Session): boolean => chat.createdBy === session.userId || session.role === 'admin';

export const isGroup = (chat: ChatRow, members: readonly string[]): boolean => chat.shared === 'organization' || members.some((user) => user !== chat.createdBy);

export const sealTitle = (keys: ChatKeys, owner: string, chat: string, title: string): string => sealSecret(keys.seal, owner, `${chat}/title`, title, 'chat');

const UNREADABLE_TITLE = 'This title could not be read.';

function openTitle(keys: ChatKeys, row: ChatRow): string {
  try {
    const value = openSecret(keys.seal, row.owner, `${row.id}/title`, row.title, 'chat');
    return typeof value === 'string' && value !== '' ? value : UNREADABLE_TITLE;
  } catch {
    log.warn({ chat: row.id }, 'chats: a chat title could not be opened');
    return UNREADABLE_TITLE;
  }
}

export const sealBody = (keys: ChatKeys, owner: string, chat: string, message: string, body: unknown): string =>
  sealSecret(keys.seal, owner, `${chat}/${message}`, body, 'chat');

function openBody(keys: ChatKeys, owner: string, row: MessageRow): unknown {
  try {
    return openSecret(keys.seal, owner, `${row.chat}/${row.id}`, row.body, 'chat');
  } catch {
    log.warn({ chat: row.chat, message: row.id }, 'chats: a chat message could not be opened');
    return null;
  }
}

const UNREADABLE: ChatReply = { parts: [], state: 'error', error: 'This reply could not be read.' };

export function messageView(keys: ChatKeys, owner: string, row: MessageRow): MessageView {
  const body = openBody(keys, owner, row);
  const base = { id: row.id, seq: row.seq, role: row.role, author: row.author, replyTo: row.replyTo, at: row.at };
  if (row.role === 'user') return { ...base, text: isRecord(body) && typeof body.text === 'string' ? body.text : null, files: (isRecord(body) ? chatFilesOf(body.files) : null) ?? [], reply: null };
  return { ...base, text: null, files: [], reply: chatReplyOf(body) ?? UNREADABLE };
}

export function chatView(keys: ChatKeys, row: ChatRow, session: Session, members: readonly string[], pinned: boolean, activity: ChatActivity): ChatView {
  return {
    id: row.id,
    agent: row.agent,
    title: openTitle(keys, row),
    createdBy: row.createdBy,
    shared: row.shared,
    members: [...members],
    pinned,
    manage: canManage(row, session),
    activity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface TicketContext {
  chat: ChatRow;
  session: Session;
  name: string;
  email: string | null;
  admin: boolean;
  group: boolean;
}

const claimsOf = (ctx: TicketContext) => ({
  organization: ctx.chat.owner,
  agent: ctx.chat.agent,
  chat: ctx.chat.id,
  user: ctx.session.userId,
  name: ctx.name,
  email: ctx.email,
  admin: ctx.admin,
  group: ctx.group,
});

export const viewTicket = (keys: ChatKeys, ctx: TicketContext, now: number): string =>
  signChatTicket(keys.signer, { ...claimsOf(ctx), act: 'view', message: null, digest: null, files: [] }, now);

export const sendTicket = (keys: ChatKeys, ctx: TicketContext, message: string, input: { text: string; files: ChatFile[] }, now: number): string =>
  signChatTicket(keys.signer, { ...claimsOf(ctx), act: 'send', message, digest: textDigest(input.text), files: input.files }, now);
