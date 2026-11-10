import { errMsg, log } from '@metro-labs/core/log';
import { sameCall, type CallRoute, type CallSource } from '@metro-labs/core/call';
import { APPROVAL_TTL_MS } from '@metro-labs/http/approval-rules';
import { previewMatches } from './preview.js';

export type Behavior = 'allow' | 'deny';

export type AnsweredVia = 'chat' | 'page' | 'expiry';

export type SettledVia = AnsweredVia | 'cancel';

export interface PendingPrompt {
  requestId: string;
  tool: string;
  description: string;
  preview: string;
  line: string | undefined;
  at: number;
  call?: CallSource;
  origin?: 'mcp-server' | 'channel';
}

export type SendAnswer = (behavior: Behavior, via: SettledVia) => Promise<void>;

interface Held extends PendingPrompt {
  owner: object;
  send: SendAnswer;
  tell: ((text: string) => Promise<void>) | undefined;
}

const ANSWERED = {
  claude: 'approvals: a Claude Code permission prompt answered',
  'mcp-server': 'approvals: an mcp.metro.box approval answered',
  channel: 'approvals: a channel approval answered',
} as const;

const PENDING_MAX = 500;
const SWEEP_MS = 60_000;

const held = new Map<string, Held>();

const shown = ({ requestId, tool, description, preview, line, at }: Held): PendingPrompt => ({
  requestId,
  tool,
  description,
  preview,
  line,
  at,
});

function makeRoom(): void {
  while (held.size > PENDING_MAX) {
    const oldest = [...held.values()].find((entry) => entry.origin === undefined);
    if (oldest === undefined) return;
    held.delete(oldest.requestId);
    log.warn({ requestId: oldest.requestId, tool: oldest.tool }, 'approvals: too many prompts are waiting, so the oldest one was dropped');
  }
}

export function holdPrompt(
  prompt: PendingPrompt,
  owner: object,
  send: SendAnswer,
  tell?: (text: string) => Promise<void>,
): boolean {
  const current = held.get(prompt.requestId);
  if (current !== undefined && current.owner !== owner) {
    log.warn({ requestId: prompt.requestId, tool: prompt.tool }, 'approvals: this id already belongs to another prompt, so the new one was refused');
    return false;
  }
  held.set(prompt.requestId, { ...prompt, owner, send, tell });
  makeRoom();
  return true;
}

export const pendingPrompts = (): PendingPrompt[] => [...held.values()].map(shown).sort((a, b) => b.at - a.at);

export const promptLine = (requestId: string): string | undefined => held.get(requestId)?.line;

export const isPromptHeld = (requestId: string): boolean => held.has(requestId);

function chatNotice(via: AnsweredVia, behavior: Behavior): string | undefined {
  if (via === 'expiry') return 'Expired, denied.';
  if (via === 'page') return behavior === 'allow' ? 'Approved on the page.' : 'Denied on the page.';
  return undefined;
}

async function tellChat(entry: Held, via: AnsweredVia, behavior: Behavior): Promise<void> {
  const text = chatNotice(via, behavior);
  if (text === undefined || entry.tell === undefined) return;
  await entry.tell(text).catch((err: unknown) => {
    log.warn({ requestId: entry.requestId, err: errMsg(err) }, 'approvals: the chat could not be told the answer');
  });
}

export async function answerPrompt(
  requestId: string,
  behavior: Behavior,
  via: AnsweredVia,
  who: string = via,
): Promise<PendingPrompt | undefined> {
  const entry = held.get(requestId);
  if (entry === undefined) return undefined;
  held.delete(requestId);
  log.info({ requestId, tool: entry.tool, behavior, by: who === via ? via : `${via} ${who}` }, ANSWERED[entry.origin ?? 'claude']);
  await entry.send(behavior, via);
  await tellChat(entry, via, behavior);
  return shown(entry);
}

export function forgetPromptsOf(owner: object): void {
  for (const [id, entry] of held) if (entry.owner === owner) held.delete(id);
}

export function cancelPrompt(requestId: string, owner: object): void {
  const entry = held.get(requestId);
  if (entry?.owner !== owner) return;
  held.delete(requestId);
  entry.send('deny', 'cancel').catch((err: unknown) => {
    log.warn({ requestId, err: errMsg(err) }, 'approvals: cancelled prompt could not be answered');
  });
}

export function revokeCallPrompts(route: CallRoute): void {
  for (const entry of [...held.values()])
    if (entry.call !== undefined && sameCall(entry.call.route, route)) cancelPrompt(entry.requestId, entry.owner);
}

export const settlePromptsFor = (name: string, args: Record<string, unknown>): void => {
  for (const [id, entry] of held)
    if (entry.origin === undefined && entry.tool.endsWith(`__${name}`) && previewMatches(entry.preview, args)) {
      held.delete(id);
      log.info({ requestId: id, tool: entry.tool }, 'approvals: the call reached metro, so Claude Code already closed the prompt');
    }
};

export async function expirePrompts(now = Date.now(), ttl = APPROVAL_TTL_MS): Promise<number> {
  const overdue = [...held.values()].filter((entry) => now - entry.at >= ttl);
  for (const entry of overdue)
    await answerPrompt(entry.requestId, 'deny', 'expiry').catch((err: unknown) => {
      log.warn({ requestId: entry.requestId, err: errMsg(err) }, 'approvals: the expiry answer could not be sent');
    });
  return overdue.length;
}

export function startPromptExpiry(): () => void {
  const timer = setInterval(() => {
    expirePrompts().catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'approvals: the expiry sweep failed');
    });
  }, SWEEP_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

export function forgetAllPrompts(): void {
  held.clear();
}
