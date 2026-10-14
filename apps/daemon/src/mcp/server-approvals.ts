import type { MetroEvent } from '@metro-labs/core/events';
import { errMsg, log } from '@metro-labs/core/log';
import type { McpApproval, McpDecision } from '@metro-labs/http/mcp-server-protocol';
import { holdPrompt, isPromptHeld, type Behavior } from '../approvals/pending.js';
import { ownerLine } from '../approvals/owner-line.js';
import { metroNotice } from '../channels/notice.js';
import { announcedLine, noteAnnounced } from '../mcp-server/announced.js';
import type { AnswerOutcome } from '../mcp-server/link.js';
import { serverPromptBody } from './permission-prompt.js';
import { metroSend, relayLine } from './permission-relay.js';
import { channelLog, type McpSession } from './session.js';

const RECENT_MS = 10 * 60_000;
const RECENT_MAX = 1_000;

const owner = {};
const recent = new Map<string, number>();
let current: () => McpSession | undefined = () => undefined;

export function connectServerApprovals(session: () => McpSession | undefined): void {
  current = session;
}

function promptLineFor(requestId: string): string | undefined {
  const session = current();
  if (session === undefined) return undefined;
  return relayLine({ relay: session.relay, inScope: (line) => session.inScope(line), live: session.live, log: channelLog }, requestId);
}

const noticeLineFor = (line: string | undefined): string | undefined => line ?? current()?.relay.knownLine ?? ownerLine()?.line;

function remember(id: string, now = Date.now()): void {
  for (const [seen, at] of recent) if (now - at >= RECENT_MS) recent.delete(seen);
  recent.set(id, now);
  while (recent.size > RECENT_MAX) {
    const oldest = recent.keys().next();
    if (oldest.done) break;
    recent.delete(oldest.value);
  }
}

const answeredRecently = (id: string, now = Date.now()): boolean => now - (recent.get(id) ?? -Infinity) < RECENT_MS;

const noticeText = (tool: string, id: string, behavior: Behavior): string =>
  behavior === 'allow' ? `Approved: ${tool} (${id}). Call tool_call again with the same arguments and approval: "${id}".` : `Denied: ${tool} (${id}).`;

const requestedAt = (at: number, now = Date.now()): number => (Number.isFinite(at) && at > 0 ? Math.min(at, now) : now);

interface Held {
  id: string;
  tool: string;
  line: string | undefined;
  answer: (decision: McpDecision) => Promise<AnswerOutcome>;
  publish: (event: MetroEvent) => void;
}

async function deliver(held: Held, behavior: Behavior): Promise<void> {
  const outcome = await held.answer(behavior);
  if (outcome !== 'acknowledged') {
    log.info({ id: held.id, outcome }, 'mcp-server: the answer was not taken, so the agent is not told');
    return;
  }
  const line = noticeLineFor(held.line);
  if (line === undefined) {
    log.warn({ id: held.id }, 'mcp-server: no chat is known to tell the agent the answer');
    return;
  }
  held.publish(metroNotice(line, noticeText(held.tool, held.id, behavior)));
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

export function holdServerApproval(approval: McpApproval, answer: Held['answer'], publish: Held['publish']): boolean {
  if (isPromptHeld(approval.id) || answeredRecently(approval.id)) return false;
  const tool = `${approval.connector}.${approval.tool}`;
  const announced = announcedLine(approval.id);
  const line = announced ?? promptLineFor(approval.id);
  const held: Held = { id: approval.id, tool, line, answer, publish };
  holdPrompt(
    { requestId: approval.id, tool, description: approval.connector, preview: approval.preview, line, at: requestedAt(approval.requestedAt), origin: 'mcp-server' },
    owner,
    sender(held),
    line === undefined ? undefined : async (text) => metroSend(line, text),
  );
  log.info({ id: approval.id, tool, inChat: line !== undefined, announced: announced !== undefined }, 'mcp-server: an approval is waiting for the owner');
  if (line !== undefined && announced === undefined) announce(approval.id, line, serverPromptBody({ requestId: approval.id, tool, preview: approval.preview }));
  return true;
}

export function forgetServerApprovals(): void {
  recent.clear();
}
