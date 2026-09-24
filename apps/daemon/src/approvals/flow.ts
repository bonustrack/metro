import { errMsg, log } from '@metro-labs/core/log';
import { subscribeEvents, type MetroEvent } from '@metro-labs/core/events';
import { targetLabel, type PolicyTarget } from '../policy/policy.js';
import {
  addApproval,
  getApproval,
  overdueApprovals,
  saveApprovals,
  type ApprovalOutcome,
  type ApprovalRecord,
} from './store.js';
import { announceDecision } from './announce.js';
import { PERMISSION_REPLY_RE } from '../channels/reply-id.js';

export type Decision = 'approve' | 'reject';

export interface ApprovalHandler {
  execute: (rec: ApprovalRecord) => Promise<ApprovalOutcome>;
}

export interface ApprovalChat {
  post: (line: string, text: string) => Promise<void>;
  promptable: (line: string) => boolean;
  replyCounts: (line: string, from: string, verified: boolean | undefined) => boolean;
}

const SWEEP_MS = 60_000;

const handlers = new Map<PolicyTarget['kind'], ApprovalHandler>();
let chat: ApprovalChat | undefined;

export function registerApprovalHandler(kind: PolicyTarget['kind'], handler: ApprovalHandler): void {
  handlers.set(kind, handler);
}

export function setApprovalChat(next: ApprovalChat | undefined): void {
  chat = next;
}

export interface ApprovalRequest {
  target: PolicyTarget;
  label?: string;
  tool: string;
  args: Record<string, unknown>;
  agentId: string;
  agentName: string;
  preview: string;
  requesterLine?: string;
}

export const waitingText = (id: string): string =>
  `Waiting for the owner's approval (id ${id}). You will get a message when it is decided; do not retry it.`;

const promptText = (rec: ApprovalRecord, agentName: string): string =>
  `${agentName} wants to ${rec.tool} on ${rec.label}${rec.preview === '' ? '' : `: ${rec.preview}`}. ` +
  `Reply yes ${rec.id} or no ${rec.id}.`;

export async function requestApproval(req: ApprovalRequest): Promise<ApprovalRecord> {
  const line = req.requesterLine;
  const promptLine = line !== undefined && chat?.promptable(line) === true ? line : undefined;
  const rec = addApproval({
    target: req.target,
    label: req.label ?? targetLabel(req.target),
    tool: req.tool,
    args: req.args,
    agentId: req.agentId,
    preview: req.preview,
    ...(line === undefined ? {} : { requesterLine: line }),
    ...(promptLine === undefined ? {} : { promptLine }),
  });
  log.info({ id: rec.id, tool: rec.tool, target: rec.target, promptLine: promptLine ?? null }, 'approvals: waiting for the owner');
  if (promptLine !== undefined && chat !== undefined)
    await chat.post(promptLine, promptText(rec, req.agentName)).catch((err: unknown) => {
      log.warn({ id: rec.id, line: promptLine, err: errMsg(err) }, 'approvals: the chat prompt was not posted; the page still has it');
    });
  return rec;
}

async function execute(rec: ApprovalRecord): Promise<ApprovalOutcome> {
  const handler = handlers.get(rec.target.kind);
  if (handler === undefined) return { ok: false, text: `nothing can run a ${rec.target.kind} call on this box` };
  try {
    return await handler.execute(rec);
  } catch (err) {
    return { ok: false, text: errMsg(err) };
  }
}

function settle(rec: ApprovalRecord, status: ApprovalRecord['status'], by: string): void {
  rec.status = status;
  rec.decidedAt = new Date().toISOString();
  rec.decidedBy = by;
  saveApprovals();
  log.info({ id: rec.id, tool: rec.tool, target: rec.target, decision: status, by }, 'approvals: decided');
}

export async function decideApproval(id: string, decision: Decision, by: string): Promise<ApprovalRecord | undefined> {
  const rec = getApproval(id);
  if (rec?.status !== 'pending') return rec;
  if (decision === 'reject' || Date.parse(rec.expiresAt) <= Date.now()) {
    settle(rec, decision === 'reject' ? 'rejected' : 'expired', by);
    announceDecision(rec);
    return rec;
  }
  settle(rec, 'approved', by);
  rec.outcome = await execute(rec);
  saveApprovals();
  log.info({ id: rec.id, tool: rec.tool, ok: rec.outcome.ok }, 'approvals: approved call ran');
  announceDecision(rec);
  return rec;
}

export function expireOverdue(now = Date.now()): ApprovalRecord[] {
  const overdue = overdueApprovals(now);
  for (const rec of overdue) {
    settle(rec, 'expired', 'expiry');
    announceDecision(rec);
  }
  return overdue;
}

function chatReply(text: string, line: string): { id: string; decision: Decision } | undefined {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  const rec = getApproval(m[2].toLowerCase());
  if (rec?.promptLine !== line) return undefined;
  return { id: rec.id, decision: m[1].toLowerCase().startsWith('y') ? 'approve' : 'reject' };
}

export function isApprovalReply(text: string, line: string, from: string, verified: boolean | undefined): boolean {
  return chatReply(text, line) !== undefined && chat?.replyCounts(line, from, verified) === true;
}

const isMessage = (ev: MetroEvent): boolean => ev.event === undefined || ev.event.type === 'msg' || ev.event.type === 'reply';

export function answerFromChat(ev: MetroEvent): Promise<ApprovalRecord | undefined> {
  const text = ev.text ?? '';
  const line = String(ev.line);
  const from = String(ev.from);
  if (!isMessage(ev) || !isApprovalReply(text, line, from, ev.senderVerified)) return Promise.resolve(undefined);
  const reply = chatReply(text, line);
  if (reply === undefined) return Promise.resolve(undefined);
  return decideApproval(reply.id, reply.decision, `chat ${from}`);
}

export function startApprovals(): () => void {
  const sweep = (): void => {
    try {
      expireOverdue();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'approvals: expiry sweep failed');
    }
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();
  const unsubscribe = subscribeEvents((ev) => {
    answerFromChat(ev).catch((err: unknown) => {
      log.warn({ err: errMsg(err), line: ev.line }, 'approvals: a chat answer failed');
    });
  });
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
