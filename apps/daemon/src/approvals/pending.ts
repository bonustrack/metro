import { errMsg, log } from '@metro-labs/core/log';
import { previewMatches } from './preview.js';

export const NEEDS_APPROVAL = (where: string, tool: string): string =>
  `Needs the owner's approval for ${where} (${tool}). Make this exact call from a background worker so Claude Code asks the owner in chat, and wait for the answer. An approval given only in the terminal does not count.`;

export type Behavior = 'allow' | 'deny';

export type AnsweredVia = 'chat' | 'page' | 'expiry';

export interface PendingPrompt {
  requestId: string;
  tool: string;
  description: string;
  preview: string;
  line: string | undefined;
  at: number;
}

interface Held extends PendingPrompt {
  owner: object;
  send: (behavior: Behavior) => Promise<void>;
  tell: ((text: string) => Promise<void>) | undefined;
}

const PENDING_MAX = 500;
const SWEEP_MS = 60_000;
const APPROVAL_TTL_MS = 24 * 3_600_000;

const held = new Map<string, Held>();

interface Grant {
  tool: string;
  preview: string;
  at: number;
}

const GRANT_TTL_MS = 10 * 60_000;
const GRANTS_MAX = 200;
let grants: Grant[] = [];

function grant(entry: Held, now = Date.now()): void {
  grants = [...grants.filter((g) => now - g.at < GRANT_TTL_MS), { tool: entry.tool, preview: entry.preview, at: now }].slice(-GRANTS_MAX);
}

export function takeGrant(toolMatches: (tool: string) => boolean, args: Record<string, unknown>, now = Date.now()): boolean {
  const at = grants.findIndex((g) => now - g.at < GRANT_TTL_MS && toolMatches(g.tool) && previewMatches(g.preview, args));
  if (at < 0) return false;
  grants = grants.filter((_, i) => i !== at);
  return true;
}

const shown = ({ requestId, tool, description, preview, line, at }: Held): PendingPrompt => ({
  requestId,
  tool,
  description,
  preview,
  line,
  at,
});

export function holdPrompt(
  prompt: PendingPrompt,
  owner: object,
  send: (behavior: Behavior) => Promise<void>,
  tell?: (text: string) => Promise<void>,
): void {
  held.set(prompt.requestId, { ...prompt, owner, send, tell });
  while (held.size > PENDING_MAX) {
    const oldest = held.keys().next();
    if (oldest.done) break;
    held.delete(oldest.value);
  }
}

export const pendingPrompts = (): PendingPrompt[] => [...held.values()].map(shown).sort((a, b) => b.at - a.at);

export const promptLine = (requestId: string): string | undefined => held.get(requestId)?.line;

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
  if (behavior === 'allow' && via !== 'expiry') grant(entry);
  log.info({ requestId, tool: entry.tool, behavior, by: who === via ? via : `${via} ${who}` }, 'approvals: a Claude Code permission prompt answered');
  await entry.send(behavior);
  await tellChat(entry, via, behavior);
  return shown(entry);
}

export function forgetPromptsOf(owner: object): void {
  for (const [id, entry] of held) if (entry.owner === owner) held.delete(id);
}

export function settlePrompts(toolMatches: (tool: string) => boolean, args: Record<string, unknown>): void {
  for (const [id, entry] of held)
    if (toolMatches(entry.tool) && previewMatches(entry.preview, args)) {
      held.delete(id);
      log.info({ requestId: id, tool: entry.tool }, 'approvals: the call reached metro, so Claude Code already closed the prompt');
    }
}

export const settlePromptsFor = (name: string, args: Record<string, unknown>): void => {
  settlePrompts((tool) => tool.endsWith(`__${name}`), args);
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
  grants = [];
}
