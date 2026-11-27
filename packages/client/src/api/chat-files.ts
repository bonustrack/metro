import { baseFromSegment } from '../auth/daemon.js';
import { call, callRaw } from './client.js';

export type ChatFileBody = Blob | ArrayBuffer;

const CHAT_TICKET_HEADER = 'x-metro-chat-ticket';

const filesUrl = (host: string, first: string, second: string): string => `${baseFromSegment(host)}/api/chat/files/${encodeURIComponent(first)}/${encodeURIComponent(second)}`;

export async function uploadChatFile(host: string, message: string, file: string, ticket: string, body: ChatFileBody): Promise<void> {
  await call({ method: 'PUT', base: filesUrl(host, message, file), headers: { [CHAT_TICKET_HEADER]: ticket, 'content-type': 'application/octet-stream' }, body });
}

export async function fetchChatFile(host: string, chat: string, file: string, ticket: string): Promise<Blob> {
  const res = await callRaw({ method: 'GET', base: filesUrl(host, chat, file), headers: { [CHAT_TICKET_HEADER]: ticket } });
  return res.blob();
}
