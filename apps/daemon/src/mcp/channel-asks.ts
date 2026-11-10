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
import { onPoliciesChanged, policyFor, type PolicyTarget } from '../policy/policy.js';
import { sharedCalls } from '../voice/shared.js';
import { errResult } from './ctx.js';
import { canTellAgent, ownerPromptLine, tellAgent } from './owner-route.js';
import { channelQuestion } from './permission-prompt.js';
import { chatTeller, metroSend } from './permission-relay.js';
import { allowedAgents, currentIdentity } from './request-identity.js';
import { toolGroupOf } from './tool-catalog.js';

const CALL_ENDED = 'The call or its authorized source has ended or changed. Nothing was spoken.';

const owner = {};
const ledger = new AskLedger();

const nameOf = (ask: AskedCall): string => `${ask.station} (${ask.tool})`;

const repeat = (ask: Ask): string => `${ask.tool} again with the same arguments and approval: "${ask.id}"`;

const SPENT: Record<Spent, string> = {
  unknown: 'is not known here, perhaps because Metro restarted since it was asked.',
  other: 'was given for another call (another tool, channel or arguments), so it does not cover this one.',
  late: 'was answered more than 10 minutes ago, so it no longer counts.',
  expired: 'expired: the owner did not answer within 24 hours.',
  withdrawn: 'was withdrawn before it was used.',
  used: 'was already used, and an approval works once.',
};

function waitingText(ask: Ask, note: string, before: boolean): string {
  const where = ask.line === undefined ? "on the agent's page on metro.box" : 'in chat';
  const told = canTellAgent(ask.line) ? `Keep working: metro tells you the answer. Once approved, call ${repeat(ask)}.` : `Metro cannot tell you the answer right now: to see it, call ${repeat(ask)}.`;
  return `Needs the owner's approval for ${nameOf(ask)}. ${note}The owner was asked ${where}${before ? ' and has not answered yet' : ''}, approval id "${ask.id}". ${told}`;
}

const approvedText = (ask: Ask, note: string): string =>
  `Already approved by the owner for ${nameOf(ask)}, approval id "${ask.id}". ${note}Nothing ran yet: call ${repeat(ask)} (once, within 10 minutes of the answer).`;

const NOTICE: Record<AskAnswer, (ask: Ask) => string> = {
  allow: (ask) => `Approved: ${ask.tool} on ${ask.station} (${ask.id}). Call ${repeat(ask)}.`,
  deny: (ask) => `Denied: ${ask.tool} on ${ask.station} (${ask.id}).`,
  expired: (ask) => `Expired: ${ask.tool} on ${ask.station} (${ask.id}). The owner did not answer within 24 hours, so it counts as denied.`,
};

function settled(id: string, behavior: Behavior, via: SettledVia): Promise<void> {
  const answer = via === 'expiry' ? 'expired' : behavior;
  const ask = via === 'cancel' ? undefined : ledger.settle(id, answer, Date.now());
  if (ask !== undefined) tellAgent(NOTICE[answer](ask), ask.line);
  return Promise.resolve();
}

function freshId(): string {
  for (;;) {
    const id = approvalId();
    if (!ledger.has(id) && !isPromptHeld(id)) return id;
  }
}

function open(call: AskedCall, args: Record<string, unknown>, bound: CallSource | undefined): Ask | string {
  const preview = previewText(args);
  if (preview.length > PREVIEW_MAX)
    return `Its arguments are too large to show the owner (${String(preview.length)} characters, ${String(PREVIEW_MAX)} at most), so nothing was asked: make the call smaller.`;
  const id = freshId();
  const line = ownerPromptLine(id, bound?.route.line);
  const ask = ledger.ask(id, call, { line, call: bound });
  if (ask === undefined) return TOO_MANY_PENDING;
  holdPrompt({ requestId: id, tool: `mcp__metro__${call.tool}`, description: '', preview, line, at: Date.now(), origin: 'channel' }, owner, (behavior, via) => settled(id, behavior, via), chatTeller(line));
  log.info({ id, tool: call.tool, station: call.station, inChat: line !== undefined }, 'approvals: a channel call waits for the owner');
  if (line !== undefined)
    metroSend(line, channelQuestion(id, call.tool, args)).catch((err: unknown) => {
      log.warn({ id, err: errMsg(err) }, 'approvals: the approval question could not be posted in chat, it waits on the page');
    });
  return ask;
}

function asking(call: AskedCall, args: Record<string, unknown>, bound: CallSource | undefined, note: string): string {
  const held = ledger.standing(call, Date.now());
  if (held?.state === 'allow') return approvedText(held, note);
  const asked = held ?? open(call, args, bound);
  return typeof asked === 'string' ? `Needs the owner's approval for ${nameOf(call)}. ${note}${asked}` : waitingText(asked, note, held !== undefined);
}

function boundCall(tool: string, args: Record<string, unknown>): CallSource | null | undefined {
  if (tool !== 'send' || args.speech === undefined) return undefined;
  const target = speechTarget(args.speech);
  return target === null ? null : sharedCalls.source(str(args.line), target, allowedAgents(currentIdentity()));
}

type Presented = 'run' | { refusal: string } | { note: string };

function presented(approval: unknown, call: AskedCall): Presented {
  const id = str(approval);
  if (id === '') return { note: '' };
  if (!APPROVAL_ID_RE.test(id)) return { note: 'The approval given is not an approval id (5 letters). ' };
  const now = Date.now();
  const verdict = ledger.judge(id, call, now);
  if (verdict.kind === 'ready' && ledger.use(verdict.ask, now)) return 'run';
  if (verdict.kind === 'denied') return { refusal: `Denied by the owner for ${nameOf(call)}, approval "${id}". Do not repeat it.` };
  return { note: verdict.kind === 'spent' ? `Approval "${id}" ${SPENT[verdict.why]} ` : '' };
}

export function askOwner(tool: string, target: PolicyTarget, args: Record<string, unknown>, approval?: unknown): ToolResult | undefined {
  const bound = boundCall(tool, args);
  if (bound === null) return errResult(CALL_ENDED);
  const call: AskedCall = { tool, digest: argsDigest(args), station: target.station, account: target.account, agent: currentIdentity()?.agentId ?? '' };
  const answer = presented(approval, call);
  if (answer !== 'run') return errResult('refusal' in answer ? answer.refusal : asking(call, args, bound, answer.note));
  log.info({ id: str(approval), tool, station: target.station }, 'approvals: an approved channel call runs');
  return undefined;
}

function withdraw(ask: Ask, why: string): void {
  if (!ledger.withdraw(ask)) return;
  cancelPrompt(ask.id, owner);
  log.info({ id: ask.id, tool: ask.tool, station: ask.station, why }, 'approvals: a channel approval was withdrawn');
}

export function revokeCallAsks(route: CallRoute): void {
  for (const ask of ledger.live()) if (ask.call !== undefined && sameCall(ask.call.route, route)) withdraw(ask, 'its voice call ended');
}

onPoliciesChanged(() => {
  for (const ask of ledger.live()) {
    if (policyFor({ kind: 'channel', station: ask.station, account: ask.account }, { name: ask.tool, group: toolGroupOf(ask.tool) }) === 'ask') continue;
    const waiting = ask.state === 'pending';
    withdraw(ask, 'its rule no longer asks');
    if (waiting) tellAgent(`Withdrawn: ${ask.tool} on ${ask.station} (${ask.id}). The owner changed the rule. Call ${ask.tool} again, without the approval, to see what applies now.`, ask.line);
  }
});

export function forgetChannelAsks(): void {
  ledger.clear();
}
