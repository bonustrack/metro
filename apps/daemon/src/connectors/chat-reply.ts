import type { ChatReply } from '@metro-labs/core/chat';
import { readAgentKey, type AgentKey } from './agent-key.js';
import { agentCall, METRO_API, MetroApiRefusal, type MetroApi } from './metro-api.js';

const PATH = '/api/agents/chats/reply';
const TIMEOUT_MS = 30_000;
const RETRIED: ReadonlySet<number> = new Set([401, 408, 425, 429]);

export async function postChatReply(chat: string, message: string, reply: ChatReply, api: MetroApi = METRO_API, key: AgentKey | null = readAgentKey()): Promise<void> {
  if (key === null) throw new Error('this box has no agent key yet, so metro.box cannot take the reply');
  await agentCall(api, key, PATH, { chat, message, reply }, { timeoutMs: TIMEOUT_MS });
}

export const enrolledServer = (key: AgentKey | null = readAgentKey()): string | null => key?.enrollment?.server ?? null;

export const replyRefused = (err: unknown): boolean =>
  err instanceof MetroApiRefusal && err.upstreamStatus >= 400 && err.upstreamStatus < 500 && !RETRIED.has(err.upstreamStatus);
