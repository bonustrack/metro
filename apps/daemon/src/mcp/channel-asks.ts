import { sameCall, speechTarget, type CallRoute, type CallSource } from '@metro-labs/core/call';
import { approvalId } from '@metro-labs/core/ids';
import { errMsg, log } from '@metro-labs/core/log';
import { str } from '@metro-labs/core/str';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { argsDigest } from '@metro-labs/http/args-digest';
import { APPROVAL_ID_RE, TOO_MANY_PENDING } from '@metro-labs/http/approval-rules';
import { AskLedger, type Ask, type AskAnswer, type AskedCall, type Spent } from '../approvals/ledger.js';
import { cancelPrompt, holdPrompt, isPromptHeld, type Behavior, type SettledVia } from '../approvals/pending.js';
import { PREVIEW_MAX, previewText } from '../approvals/preview.js';
import { sharedCalls } from '../voice/shared.js';
import { errResult } from './ctx.js';
import { agentHearsNotices, ownerPromptLine, tellAgent } from './owner-route.js';
import { promptBody } from './permission-prompt.js';
import { metroSend } from './permission-relay.js';
import { allowedAgents, currentIdentity } from './request-identity.js';

export interface AskTarget {
  station: string;
  account: string;
}

export interface AskedOfOwner {
  tool: string;
  target: AskTarget;
  args: Record<string, unknown>;
  approval?: unknown;
}

interface Asked {
  call: AskedCall;
  args: Record<string, unknown>;
  bound: CallSource | undefined;
  now: number;
}

type Presented = { run: true } | { run: false; refusal?: string; note: string };

const NOT_AN_ID = 'The approval given is not an approval id (5 letters). ';
const CALL_ENDED = 'The call or its authorized source has ended or changed. Nothing was spoken.';

const owner = {};
const ledger = new AskLedger();

const nameOf = (ask: AskedCall): string => `${ask.station} (${ask.tool})`;

const repeat = (ask: Ask): string => `${ask.tool} again with the same arguments and approval: "${ask.id}"`;

const SPENT: Record<Spent, (id: string) => string> = {
  unknown: (id) => `Approval "${id}" is not known here, perhaps because Metro restarted since it was asked.`,
  other: (id) => `Approval "${id}" was given for another call (another tool, channel or arguments), so it does not cover this one.`,
  late: (id) => `Approval "${id}" was answered more than 10 minutes ago, so it no longer counts.`,
  expired: (id) => `Approval "${id}" expired: the owner did not answer within 24 hours.`,
  withdrawn: (id) => `Approval "${id}" was withdrawn before it was used.`,
  used: (id) => `Approval "${id}" was already used, and an approval works once.`,
};

const whereAsked = (ask: Ask, before: boolean): string =>
  `The owner was asked ${ask.line === undefined ? "on the agent's page on metro.box" : 'in chat'}${before ? ' and has not answered yet' : ''}`;

const howAnswered = (ask: Ask): string =>
  agentHearsNotices()
    ? `Keep working: metro tells you the answer. Once approved, call ${repeat(ask)}.`
    : `Messages are paused, so metro cannot tell you the answer: to see it, call ${repeat(ask)}.`;

const waitingText = (ask: Ask, note: string, before: boolean): string =>
  `Needs the owner's approval for ${nameOf(ask)}. ${note}${whereAsked(ask, before)}, approval id "${ask.id}". ${howAnswered(ask)}`;

const approvedText = (ask: Ask, note: string): string =>
  `Already approved by the owner for ${nameOf(ask)}, approval id "${ask.id}". ${note}Nothing ran yet: call ${repeat(ask)} (once, within 10 minutes of the answer).`;

const deniedText = (ask: Ask): string => `Denied by the owner for ${nameOf(ask)}, approval "${ask.id}". Do not repeat it.`;

const tooLarge = (call: AskedCall, size: number): string =>
  `Needs the owner's approval for ${nameOf(call)}, but its arguments are too large to show the owner (${String(size)} characters, ${String(PREVIEW_MAX)} at most). Nothing was asked: make the call smaller.`;

const NOTICE: Record<Exclude<AskAnswer, 'withdrawn'>, (ask: Ask) => string> = {
  allow: (ask) => `Approved: ${ask.tool} on ${ask.station} (${ask.id}). Call ${repeat(ask)}.`,
  deny: (ask) => `Denied: ${ask.tool} on ${ask.station} (${ask.id}).`,
  expired: (ask) => `Expired: ${ask.tool} on ${ask.station} (${ask.id}). The owner did not answer within 24 hours, so it counts as denied.`,
};

function answerOf(behavior: Behavior, via: SettledVia): AskAnswer {
  if (via === 'cancel') return 'withdrawn';
  return via === 'expiry' ? 'expired' : behavior;
}

function settled(id: string, behavior: Behavior, via: SettledVia): Promise<void> {
  const answer = answerOf(behavior, via);
  const ask = ledger.settle(id, answer, Date.now());
  if (ask !== undefined && answer !== 'withdrawn') tellAgent(NOTICE[answer](ask), ask.line);
  return Promise.resolve();
}

function hold(ask: Ask, preview: string): void {
  const { line } = ask;
  holdPrompt(
    { requestId: ask.id, tool: `mcp__metro__${ask.tool}`, description: '', preview, line, at: ask.askedAt, origin: 'channel', ...(ask.call === undefined ? {} : { call: ask.call }) },
    owner,
    (behavior, via) => settled(ask.id, behavior, via),
    line === undefined ? undefined : (text) => metroSend(line, text),
  );
}

function freshId(): string {
  for (;;) {
    const id = approvalId();
    if (!ledger.has(id) && !isPromptHeld(id)) return id;
  }
}

function post(ask: Ask, line: string, preview: string): void {
  metroSend(line, promptBody({ request_id: ask.id, tool_name: `mcp__metro__${ask.tool}`, description: '', input_preview: preview })).catch((err: unknown) => {
    log.warn({ id: ask.id, err: errMsg(err) }, 'approvals: the approval question could not be posted in chat, it waits on the page');
  });
}

function open(asked: Asked, preview: string): Ask | undefined {
  if (ledger.full) return undefined;
  const id = freshId();
  const line = ownerPromptLine(id, asked.bound?.route.line);
  const ask = ledger.ask(id, asked.call, { line, call: asked.bound }, asked.now);
  if (ask === undefined) return undefined;
  hold(ask, preview);
  log.info({ id, tool: ask.tool, station: ask.station, inChat: line !== undefined }, 'approvals: a channel call waits for the owner');
  if (line !== undefined) post(ask, line, preview);
  return ask;
}

function askedAgain(asked: Asked, note: string): string {
  const standing = ledger.standing(asked.call, asked.now);
  if (standing?.state === 'allow') return approvedText(standing, note);
  if (standing !== undefined) {
    if (!isPromptHeld(standing.id)) hold(standing, previewText(asked.args));
    return waitingText(standing, note, true);
  }
  const preview = previewText(asked.args);
  if (preview.length > PREVIEW_MAX) return tooLarge(asked.call, preview.length);
  const opened = open(asked, preview);
  return opened === undefined ? `Needs the owner's approval for ${nameOf(asked.call)}. ${note}${TOO_MANY_PENDING}` : waitingText(opened, note, false);
}

function boundCall(tool: string, args: Record<string, unknown>): CallSource | null | undefined {
  if (tool !== 'send' || args.speech === undefined) return undefined;
  const target = speechTarget(args.speech);
  return target === null ? null : sharedCalls.source(str(args.line), target, allowedAgents(currentIdentity()));
}

function presented(given: unknown, asked: Asked): Presented {
  const id = str(given);
  if (id === '') return { run: false, note: '' };
  if (!APPROVAL_ID_RE.test(id)) return { run: false, note: NOT_AN_ID };
  const verdict = ledger.judge(id, asked.call, asked.now);
  if (verdict.kind === 'ready' && ledger.use(verdict.ask, asked.now)) return { run: true };
  if (verdict.kind === 'denied') return { run: false, refusal: deniedText(verdict.ask), note: '' };
  return { run: false, note: verdict.kind === 'spent' ? `${SPENT[verdict.why](id)} ` : '' };
}

export function askOwner({ tool, target, args, approval }: AskedOfOwner, now = Date.now()): ToolResult | undefined {
  const bound = boundCall(tool, args);
  if (bound === null) return errResult(CALL_ENDED);
  const call: AskedCall = { tool, digest: argsDigest(args), station: target.station, account: target.account, agent: currentIdentity()?.agentId ?? '' };
  const asked: Asked = { call, args, bound, now };
  ledger.sweep(now);
  const answer = presented(approval, asked);
  if (!answer.run) return errResult(answer.refusal ?? askedAgain(asked, answer.note));
  log.info({ id: str(approval), tool, station: target.station }, 'approvals: an approved channel call runs');
  return undefined;
}

function withdraw(match: (ask: Ask) => boolean, why: string): void {
  for (const ask of ledger.withdraw(match, Date.now())) {
    cancelPrompt(ask.id, owner);
    log.info({ id: ask.id, tool: ask.tool, station: ask.station, why }, 'approvals: a channel approval was withdrawn');
  }
}

export function withdrawAsksFor(tool: string, args: Record<string, unknown>): void {
  if (!ledger.waitsOn(tool)) return;
  const digest = argsDigest(args);
  withdraw((ask) => ask.tool === tool && ask.digest === digest, 'the rule for this call no longer asks');
}

export function revokeCallAsks(route: CallRoute): void {
  withdraw((ask) => ask.call !== undefined && sameCall(ask.call.route, route), 'its voice call ended');
}

export function forgetChannelAsks(): void {
  ledger.clear();
}
