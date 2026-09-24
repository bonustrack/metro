import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { mintId } from '@metro-labs/core/ids';
import type { Line } from '@metro-labs/core/lines';
import type { ApprovalRecord } from './store.js';

export const APPROVALS_LINE = 'metro://claude/approvals';
export const APPROVAL_SOURCE = 'approval';
const RESULT_MAX = 2000;

export type ApprovalVerdict = 'done' | 'failed' | 'rejected' | 'expired';

export interface ApprovalNotice {
  approvalId: string;
  tool: string;
  verdict: ApprovalVerdict;
}

const cut = (text: string): string => (text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}…` : text);

export function verdictOf(rec: ApprovalRecord): ApprovalVerdict {
  if (rec.status === 'rejected') return 'rejected';
  if (rec.status === 'expired') return 'expired';
  return rec.outcome?.ok === true ? 'done' : 'failed';
}

export function decisionText(rec: ApprovalRecord): string {
  const what = `${rec.tool} on ${rec.label} (approval ${rec.id})`;
  const verdict = verdictOf(rec);
  if (verdict === 'rejected') return `The owner rejected ${what}. It did not run.`;
  if (verdict === 'expired') return `Nobody answered ${what} within 24 hours, so it expired. It did not run.`;
  const result = cut(rec.outcome?.text ?? '');
  return verdict === 'done'
    ? `The owner approved ${what} and it ran: ${result}`
    : `The owner approved ${what}, but it failed: ${result}`;
}

export function announceDecision(rec: ApprovalRecord): void {
  const line = (rec.requesterLine ?? APPROVALS_LINE) as Line;
  const notice: ApprovalNotice = { approvalId: rec.id, tool: rec.tool, verdict: verdictOf(rec) };
  const event: MetroEvent = {
    id: mintId(),
    ts: new Date().toISOString(),
    station: line.split('/')[2] ?? 'claude',
    line,
    from: APPROVALS_LINE as Line,
    to: line,
    text: decisionText(rec),
    event: { type: 'system', source: APPROVAL_SOURCE },
    payload: { approval: notice },
  };
  publishEvent(event);
}
