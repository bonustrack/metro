import { chatFileOf, chatReplyOf, type ChatFile, type ChatReply } from '@metro-labs/core/chat';
import { builtInDaemon } from '../auth/daemon.js';
import { filled, isRecord, str } from '../read.js';
import { call, JSON_HEADERS } from './client.js';

export type ChatShared = 'private' | 'organization';

export type ChatActivity = 'working' | 'unread' | null;

export interface Chat {
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

export interface ChatMessage {
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

export type ChatFileInput = Pick<ChatFile, 'name' | 'type' | 'size'>;

export interface ChatPerson {
  id: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

export interface ChatPage {
  chat: Chat;
  messages: ChatMessage[];
  people: ChatPerson[];
  ticket: string;
}

interface SentMessage {
  message: ChatMessage;
  ticket: string;
}

const chatsUrl = (): string => `${builtInDaemon()}/api/chats`;
const unexpected = (): Error => new Error('metro.box returned an unexpected answer.');

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const filesOf = (value: unknown): ChatFile[] => (Array.isArray(value) ? value.map(chatFileOf).filter((f): f is ChatFile => f !== null) : []);
const fileInputs = (files: readonly ChatFileInput[]): { files?: ChatFileInput[] } => (files.length === 0 ? {} : { files: files.map(({ name, type, size }) => ({ name, type, size })) });

export function toChat(value: unknown): Chat {
  if (!isRecord(value) || typeof value.id !== 'string') throw unexpected();
  return {
    id: value.id,
    agent: str(value.agent),
    title: str(value.title),
    createdBy: str(value.createdBy),
    shared: value.shared === 'organization' ? 'organization' : 'private',
    members: strings(value.members),
    pinned: value.pinned === true,
    manage: value.manage === true,
    activity: value.activity === 'working' || value.activity === 'unread' ? value.activity : null,
    createdAt: num(value.createdAt),
    updatedAt: num(value.updatedAt),
  };
}

export function toChatMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || typeof value.id !== 'string') throw unexpected();
  const role = value.role === 'assistant' ? 'assistant' : 'user';
  return {
    id: value.id,
    seq: num(value.seq),
    role,
    author: filled(value.author),
    replyTo: filled(value.replyTo),
    at: num(value.at),
    text: role === 'user' && typeof value.text === 'string' ? value.text : null,
    files: role === 'user' ? filesOf(value.files) : [],
    reply: role === 'assistant' ? (chatReplyOf(value.reply) ?? { parts: [], state: 'error', error: 'This reply could not be read.' }) : null,
  };
}

const toPerson = (value: unknown): ChatPerson | null =>
  isRecord(value) && typeof value.id === 'string' ? { id: value.id, name: filled(value.name), email: filled(value.email), picture: filled(value.picture) } : null;

const ticketOf = (body: unknown): string => {
  if (!isRecord(body) || typeof body.ticket !== 'string') throw unexpected();
  return body.ticket;
};

export async function fetchChats(): Promise<Chat[]> {
  const body = await call({ method: 'GET', base: chatsUrl() });
  if (!isRecord(body) || !Array.isArray(body.chats)) throw unexpected();
  return body.chats.map(toChat);
}

export async function startChat(agent: string, text: string, members: readonly string[] = [], files: readonly ChatFileInput[] = []): Promise<SentMessage & { chat: Chat }> {
  const body = await call({ method: 'POST', base: chatsUrl(), headers: JSON_HEADERS, body: JSON.stringify({ agent, text, ...(members.length === 0 ? {} : { members }), ...fileInputs(files) }) });
  if (!isRecord(body)) throw unexpected();
  return { chat: toChat(body.chat), message: toChatMessage(body.message), ticket: ticketOf(body) };
}

export async function fetchChat(id: string, seen = true): Promise<ChatPage> {
  const body = await call({ method: 'GET', base: `${chatsUrl()}/${id}${seen ? '' : '?seen=0'}` });
  if (!isRecord(body) || !Array.isArray(body.messages) || !Array.isArray(body.people)) throw unexpected();
  return {
    chat: toChat(body.chat),
    messages: body.messages.map(toChatMessage),
    people: body.people.map(toPerson).filter((p): p is ChatPerson => p !== null),
    ticket: ticketOf(body),
  };
}

interface ChatChange {
  title?: string;
  shared?: ChatShared;
  members?: string[];
}

export async function changeChat(id: string, change: ChatChange): Promise<Chat> {
  const body = await call({ method: 'PATCH', base: `${chatsUrl()}/${id}`, headers: JSON_HEADERS, body: JSON.stringify(change) });
  return toChat(isRecord(body) ? body.chat : null);
}

export async function deleteChat(id: string): Promise<void> {
  await call({ method: 'DELETE', base: `${chatsUrl()}/${id}` });
}

export async function pinChat(id: string, pinned: boolean): Promise<void> {
  await call({ method: pinned ? 'PUT' : 'DELETE', base: `${chatsUrl()}/${id}/pin` });
}

export async function postChatMessage(id: string, text: string, files: readonly ChatFileInput[] = []): Promise<SentMessage> {
  const body = await call({ method: 'POST', base: `${chatsUrl()}/${id}/messages`, headers: JSON_HEADERS, body: JSON.stringify({ text, ...fileInputs(files) }) });
  if (!isRecord(body)) throw unexpected();
  return { message: toChatMessage(body.message), ticket: ticketOf(body) };
}

export async function retryTicket(id: string, message: string): Promise<string> {
  return ticketOf(await call({ method: 'POST', base: `${chatsUrl()}/${id}/messages/${message}/ticket` }));
}

export async function viewTicket(id: string): Promise<string> {
  return ticketOf(await call({ method: 'POST', base: `${chatsUrl()}/${id}/ticket` }));
}

export const personName = (person: ChatPerson | undefined): string => person?.name ?? person?.email ?? 'A member';
