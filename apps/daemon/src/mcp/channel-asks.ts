import { speechTarget, type CallSource } from '@metro-labs/core/call';
import type { MetroEvent } from '@metro-labs/core/events';
import { approvalId } from '@metro-labs/core/ids';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { str } from '@metro-labs/core/str';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { argsDigest } from '@metro-labs/http/args-digest';
import { holdPrompt, isPromptHeld, type Behavior } from '../approvals/pending.js';
import { ownerLine } from '../approvals/owner-line.js';
import { agentIdForLine } from '../agents/map.js';
import { metroNotice } from '../channels/notice.js';
import { sharedCalls } from '../voice/shared.js';
import { errResult } from './ctx.js';
import { promptBody } from './permission-prompt.js';
import { metroSend } from './permission-relay.js';

export interface AskDeps {
  promptLine: (requestId: string, callLine?: string) => string | undefined;
  knownLine: () => string | undefined;
  publish: (event: MetroEvent) => void;
}

type AskState = 'pending' | Behavior | 'used';

interface Ask {
  id: string;
  tool: string;
  station: string;
  digest: string;
  line: string | undefined;
  call: CallSource | undefined;
  state: AskState;
  answeredAt: number;
}

const USE_WINDOW_MS = 10 * 60_000;
const KEPT_MAX = 500;
const LONG = 600;
const HEAD = 300;
const TAIL = 200;
const CALL_ENDED = 'The call or its authorized source has ended or changed. Nothing was spoken.';

const owner = {};
const asks = new Map<string, Ask>();
let deps: AskDeps | undefined;

export function connectChannelAsks(next: AskDeps | undefined): void {
  deps = next;
}

export const withoutApproval = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'approval'));

function elided(value: unknown): unknown {
  if (typeof value === 'string') {
    const points = Array.from(value);
    if (points.length <= LONG) return value;
    return `${points.slice(0, HEAD).join('')}\n⋯ ${String(points.length - HEAD - TAIL)} code points elided ⋯\n${points.slice(-TAIL).join('')}`;
  }
  if (Array.isArray(value)) return value.map(elided);
  return isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, elided(inner)])) : value;
}

export const previewText = (args: Record<string, unknown>): string => JSON.stringify(elided(args));

function callOf(tool: string, args: Record<string, unknown>): CallSource | null | undefined {
  if (tool !== 'send' || args.speech === undefined) return undefined;
  const target = speechTarget(args.speech);
  const line = str(args.line);
  const agentId = line ? agentIdForLine(line) : undefined;
  return target === null || agentId === undefined ? null : sharedCalls.source(line, target, new Set([agentId]));
}

const waitingText = (ask: Ask): string =>
  `Needs the owner's approval for ${ask.station} (${ask.tool}). The owner was asked ${ask.line === undefined ? "on the agent's page on metro.box" : 'in chat'}, ` +
  `approval id "${ask.id}". Keep working: metro tells you the answer. Once approved, call ${ask.tool} again with the same arguments and approval: "${ask.id}".`;

const deniedText = (ask: Ask): string => `Denied by the owner for ${ask.station} (${ask.tool}), approval "${ask.id}".`;

const noticeText = (ask: Ask, behavior: Behavior): string =>
  behavior === 'allow'
    ? `Approved: ${ask.tool} on ${ask.station} (${ask.id}). Call ${ask.tool} again with the same arguments and approval: "${ask.id}".`
    : `Denied: ${ask.tool} on ${ask.station} (${ask.id}).`;

function tell(ask: Ask, behavior: Behavior): void {
  const line = ask.line ?? deps?.knownLine() ?? ownerLine()?.line;
  if (deps === undefined || line === undefined) {
    log.warn({ id: ask.id }, 'approvals: no chat is known to tell the agent the answer');
    return;
  }
  deps.publish(metroNotice(line, noticeText(ask, behavior)));
}

const answered = (ask: Ask) => (behavior: Behavior): Promise<void> => {
  ask.state = behavior;
  ask.answeredAt = Date.now();
  tell(ask, behavior);
  return Promise.resolve();
};

function prune(now: number): void {
  for (const [id, ask] of asks)
    if (ask.state === 'used' || (ask.state !== 'pending' && now - ask.answeredAt >= USE_WINDOW_MS)) asks.delete(id);
  while (asks.size >= KEPT_MAX) {
    const oldest = asks.keys().next();
    if (oldest.done) break;
    asks.delete(oldest.value);
  }
}

function freshId(): string {
  for (;;) {
    const id = approvalId();
    if (!asks.has(id) && !isPromptHeld(id)) return id;
  }
}

function post(id: string, line: string, text: string): void {
  metroSend(line, text).catch((err: unknown) => {
    log.warn({ id, err: errMsg(err) }, 'approvals: the approval question could not be posted');
  });
}

function open(tool: string, station: string, digest: string, args: Record<string, unknown>, call: CallSource | undefined): Ask {
  const id = freshId();
  const line = deps?.promptLine(id, call?.route.line);
  const ask: Ask = { id, tool, station, digest, line, call, state: 'pending', answeredAt: 0 };
  asks.set(id, ask);
  const preview = previewText(args);
  holdPrompt(
    { requestId: id, tool: `mcp__metro__${tool}`, description: station, preview, line, at: Date.now(), origin: 'channel', ...(call === undefined ? {} : { call }) },
    owner,
    answered(ask),
    line === undefined ? undefined : async (text) => metroSend(line, text),
  );
  log.info({ id, tool, station, inChat: line !== undefined }, 'approvals: a channel call waits for the owner');
  if (line !== undefined) post(id, line, promptBody({ request_id: id, tool_name: `mcp__metro__${tool}`, description: '', input_preview: preview }));
  return ask;
}

function redeem(ask: Ask, now: number): ToolResult | undefined | 'again' {
  if (ask.state === 'pending') return isPromptHeld(ask.id) ? errResult(waitingText(ask)) : 'again';
  if (ask.state === 'deny') return errResult(deniedText(ask));
  if (ask.state === 'used' || now - ask.answeredAt >= USE_WINDOW_MS) return 'again';
  if (ask.call !== undefined && !sharedCalls.valid(ask.call)) return errResult(CALL_ENDED);
  ask.state = 'used';
  log.info({ id: ask.id, tool: ask.tool, station: ask.station }, 'approvals: an approved channel call runs');
  return undefined;
}

export function askOwner(tool: string, station: string, args: Record<string, unknown>, now = Date.now()): ToolResult | undefined {
  const plain = withoutApproval(args);
  const digest = argsDigest(plain);
  const call = callOf(tool, plain);
  if (call === null) return errResult(CALL_ENDED);
  const presented = asks.get(str(args.approval));
  if (presented?.tool === tool && presented.digest === digest) {
    const answer = redeem(presented, now);
    if (answer !== 'again') return answer;
  }
  prune(now);
  const waiting = [...asks.values()].find((ask) => ask.state === 'pending' && ask.tool === tool && ask.digest === digest && isPromptHeld(ask.id));
  return errResult(waitingText(waiting ?? open(tool, station, digest, plain, call)));
}
