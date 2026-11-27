import { errMsg, log } from '@metro-labs/core/log';
import { keyAsker } from '@metro-labs/core/approval-fields';
import type { McpApproval, McpDecision } from '@metro-labs/http/mcp-server-protocol';
import { APPROVAL_USE_MS } from '@metro-labs/http/approval-rules';
import { holdPrompt, isPromptHeld, type Behavior } from '../approvals/pending.js';
import { capSize } from '../channels/pending.js';
import { announcedLine, noteAnnounced } from '../mcp-server/announced.js';
import { askedByChat } from '../mcp-server/chat-marks.js';
import type { AnswerOutcome } from '../mcp-server/link.js';
import { ownerPromptLine, tellAgent } from './owner-route.js';
import { serverNotice } from './permission-prompt.js';
import { chatTeller, metroSend } from './permission-relay.js';

const RECENT_MAX = 1_000;

const owner = {};
const recent = new Map<string, number>();

function remember(id: string, now = Date.now()): void {
  for (const [seen, at] of recent) if (now - at >= APPROVAL_USE_MS) recent.delete(seen);
  recent.set(id, now);
  capSize(recent, RECENT_MAX);
}

const answeredRecently = (id: string, now = Date.now()): boolean => now - (recent.get(id) ?? -Infinity) < APPROVAL_USE_MS;

const noticeText = (tool: string, id: string, behavior: Behavior): string =>
  behavior === 'allow' ? `Approved: ${tool} (${id}). Call tool_call again with the same arguments and approval: "${id}".` : `Denied: ${tool} (${id}).`;

const askerOf = (approval: McpApproval): { requestedBy?: string } => (approval.origin === 'key' ? { requestedBy: keyAsker(approval.keyLabel) } : {});

interface Place {
  line: string | undefined;
  announced: string | undefined;
}

type Asker = 'session' | 'key' | 'chat';

const askerKind = (approval: McpApproval): Asker => (approval.origin === 'key' ? 'key' : askedByChat(approval) ? 'chat' : 'session');

function placeOf(approval: McpApproval, asker: Asker): Place {
  if (asker !== 'session') return { line: undefined, announced: undefined };
  const announced = announcedLine(approval.id);
  return { line: announced ?? ownerPromptLine(approval.id), announced };
}

const requestedAt = (at: number, now = Date.now()): number => (Number.isFinite(at) && at > 0 ? Math.min(at, now) : now);

interface Held {
  id: string;
  tool: string;
  line: string | undefined;
  asker: Asker;
  answer: (decision: McpDecision) => Promise<AnswerOutcome>;
}

async function deliver(held: Held, behavior: Behavior): Promise<void> {
  const outcome = await held.answer(behavior);
  if (outcome !== 'acknowledged') {
    log.info({ id: held.id, outcome }, 'mcp-server: the answer was not taken, so the agent is not told');
    return;
  }
  if (held.asker !== 'session') {
    log.info({ id: held.id, asker: held.asker }, 'mcp-server: the call did not come from this agent\'s session, so the session is not told');
    return;
  }
  tellAgent(noticeText(held.tool, held.id, behavior), held.line);
}

function sender(held: Held): (behavior: Behavior) => Promise<void> {
  return (behavior) => {
    remember(held.id);
    deliver(held, behavior).catch((err: unknown) => {
      log.warn({ id: held.id, err: errMsg(err) }, 'mcp-server: the answer could not be delivered');
    });
    return Promise.resolve();
  };
}

function announce(id: string, line: string, text: string): void {
  metroSend(line, text).then(() => {
    noteAnnounced(id, line);
  }).catch((err: unknown) => {
    log.warn({ id, err: errMsg(err) }, 'mcp-server: the approval prompt could not be posted');
  });
}

export function holdServerApproval(approval: McpApproval, answer: Held['answer']): boolean {
  if (isPromptHeld(approval.id) || answeredRecently(approval.id)) return false;
  const tool = `${approval.connector}.${approval.tool}`;
  const asker = askerKind(approval);
  const { line, announced } = placeOf(approval, asker);
  const held: Held = { id: approval.id, tool, line, asker, answer };
  holdPrompt(
    { requestId: approval.id, tool, description: approval.connectorName ?? approval.connector, preview: approval.preview, line, at: requestedAt(approval.requestedAt), origin: 'mcp-server', ...askerOf(approval) },
    owner,
    sender(held),
    chatTeller(line),
  );
  log.info({ id: approval.id, tool, origin: approval.origin ?? null, asker, inChat: line !== undefined, announced: announced !== undefined }, asker === 'session' ? 'mcp-server: an approval is waiting for the owner' : 'mcp-server: an approval asked outside the agent session waits on metro.box only, never in a chat');
  if (line !== undefined && announced === undefined) announce(approval.id, line, serverNotice(approval));
  return true;
}

export function forgetServerApprovals(): void {
  recent.clear();
}
