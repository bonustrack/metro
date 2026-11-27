import { focusManager, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { forOrganization } from '@metro-labs/client/auth/org-route';
import { HttpError } from '@metro-labs/client/api/client';
import { fetchChat, fetchChats, postChatMessage, type Chat, type ChatMessage, type ChatPage } from '@metro-labs/client/api/chats';
import type { Server, ServerStatus } from '@metro-labs/client/api/servers';
import { olderThan } from '@metro-labs/client/api/version';
import { rememberSend } from './chat-sends.js';
import { logError } from './log.js';
import { orgKey, useServerStatuses } from './queries.js';

const CHAT_SINCE = '0.1.0-beta.341';

const LIST_POLL_MS = 30_000;
const WORKING_POLL_MS = 10_000;
const CHAT_POLL_MS = 10_000;

const chatsKey = (): string[] => orgKey('chats');
const chatKey = (id: string): string[] => orgKey('chat', id);

const orgOf = (key: string[]): string | null => (key[1] === undefined || key[1] === 'none' ? null : key[1]);

export function useChatsQuery(): UseQueryResult<Chat[]> {
  const key = chatsKey();
  return useQuery({ queryKey: key, queryFn: () => forOrganization(orgOf(key), fetchChats), staleTime: 10_000, refetchInterval: (query) => (query.state.data?.some((chat) => chat.activity === 'working') === true ? WORKING_POLL_MS : LIST_POLL_MS) });
}

export function useChatQuery(id: string): UseQueryResult<ChatPage> {
  const client = useQueryClient();
  const key = chatKey(id);
  return useQuery({ queryKey: key, queryFn: () => forOrganization(orgOf(key), () => fetchChat(id, focusManager.isFocused())).then((page) => noteActivity(client, page)), staleTime: 5_000, refetchInterval: CHAT_POLL_MS });
}

async function rewrite<T>(client: QueryClient, key: string[], change: (now: T) => T): Promise<void> {
  if (client.getQueryData<T>(key) === undefined) return;
  await client.cancelQueries({ queryKey: key, exact: true });
  client.setQueryData<T>(key, (now) => (now === undefined ? now : change(now)));
}

export async function noteActivity(client: QueryClient, page: ChatPage): Promise<ChatPage> {
  const listed = client.getQueryData<Chat[]>(chatsKey())?.find((c) => c.id === page.chat.id);
  if (listed !== undefined && listed.activity !== page.chat.activity) {
    await rewrite<Chat[]>(client, chatsKey(), (list) => list.map((c) => (c.id === page.chat.id ? { ...c, activity: page.chat.activity } : c)));
  }
  return page;
}

export async function putChat(client: QueryClient, chat: Chat): Promise<void> {
  await rewrite<Chat[]>(client, chatsKey(), (list) => (list.some((c) => c.id === chat.id) ? list.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...list]));
  await rewrite<ChatPage>(client, chatKey(chat.id), (page) => ({ ...page, chat }));
}

export const addMessage = (client: QueryClient, id: string, message: ChatMessage): Promise<void> =>
  rewrite<ChatPage>(client, chatKey(id), (page) => (page.messages.some((m) => m.id === message.id) ? page : { ...page, messages: [...page.messages, message] }));

export async function dropChat(client: QueryClient, id: string): Promise<void> {
  await rewrite<Chat[]>(client, chatsKey(), (list) => list.filter((c) => c.id !== id));
  client.removeQueries({ queryKey: chatKey(id) });
}

export const refreshChat = (client: QueryClient, id: string): Promise<void> => client.invalidateQueries({ queryKey: chatKey(id) });

export const refreshChats = (client: QueryClient): Promise<void> => client.invalidateQueries({ queryKey: chatsKey() });

export async function showSent(client: QueryClient, id: string, message: ChatMessage): Promise<void> {
  await addMessage(client, id, message);
  refreshChat(client, id).catch(logError('chat refresh'));
}

export async function sendChatMessage(client: QueryClient, id: string, text: string): Promise<void> {
  const sent = await postChatMessage(id, text).catch((err: unknown) => {
    if (err instanceof HttpError && err.status === 409) refreshChat(client, id).catch(logError('chat refresh'));
    throw err;
  });
  rememberSend(sent.message.id, sent.ticket, text);
  await showSent(client, id, sent.message);
  refreshChats(client).catch(logError('chat list'));
}

export function unanswered(messages: readonly ChatMessage[]): ChatMessage | null {
  const last = messages.at(-1);
  if (last?.role !== 'user') return null;
  return messages.some((m) => m.replyTo === last.id) ? null : last;
}

export const useBoxStatus = (host: string | null): ServerStatus | undefined => useServerStatuses(host === null ? [] : [host])[0]?.data;

export type ChatGate = { kind: 'wait' } | { kind: 'open' } | { kind: 'closed'; why: string };

const closed = (why: string): ChatGate => ({ kind: 'closed', why });

export function chatGate(server: Server | undefined, status: ServerStatus | undefined): ChatGate {
  if (server === undefined) return closed('This agent is not in your organization any more.');
  if (server.kind === 'remote') return closed('This agent has no server, so it cannot chat yet.');
  if (status === undefined) return { kind: 'wait' };
  if (status.state === 'offline') return closed("The agent's server is offline.");
  if (status.state === 'stopped') return closed('The agent is stopped. Start it to chat.');
  if (status.state === 'updating') return closed('The agent is updating. Try again in a minute.');
  return olderThan(status.version, CHAT_SINCE) ? closed('Update this agent to chat with it here.') : { kind: 'open' };
}
