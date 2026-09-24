import { daemonBase } from '../auth/daemon.js';
import { call } from './client.js';
import { isRecord } from './read.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type Decision = 'approve' | 'reject';

export interface Approval {
  id: string;
  tool: string;
  label: string;
  preview: string;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  outcome: { ok: boolean; text: string } | null;
  inChat: boolean;
}

const STATUSES = new Set<string>(['pending', 'approved', 'rejected', 'expired']);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const orNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === 'string' && STATUSES.has(value);
}

function outcomeOf(value: unknown): Approval['outcome'] {
  return isRecord(value) && typeof value.ok === 'boolean' ? { ok: value.ok, text: text(value.text) } : null;
}

export function approvalOf(raw: unknown): Approval | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.tool !== 'string' || !isApprovalStatus(raw.status)) return null;
  return {
    id: raw.id,
    tool: raw.tool,
    label: text(raw.label),
    preview: text(raw.preview),
    status: raw.status,
    requestedAt: text(raw.requestedAt),
    expiresAt: text(raw.expiresAt),
    decidedAt: orNull(raw.decidedAt),
    decidedBy: orNull(raw.decidedBy),
    outcome: outcomeOf(raw.outcome),
    inChat: typeof raw.promptLine === 'string',
  };
}

export function splitApprovals(list: Approval[]): { pending: Approval[]; recent: Approval[] } {
  return {
    pending: list.filter((a) => a.status === 'pending').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    recent: list.filter((a) => a.status !== 'pending').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')),
  };
}

export function verdictLabel(a: Approval): string {
  if (a.status === 'pending') return 'Waiting';
  if (a.status === 'rejected') return 'Rejected';
  if (a.status === 'expired') return 'Expired';
  return a.outcome?.ok === false ? 'Approved, failed' : 'Approved';
}

const base = (): string => `${daemonBase()}/api/approvals`;

export async function fetchApprovals(): Promise<Approval[]> {
  const body = await call({ method: 'GET', base: base() });
  if (!isRecord(body) || !Array.isArray(body.approvals)) throw new Error('Metro returned an unexpected response.');
  return body.approvals.flatMap((raw) => {
    const a = approvalOf(raw);
    return a === null ? [] : [a];
  });
}

export async function decideApproval(id: string, decision: Decision): Promise<Approval> {
  const body = await call({
    method: 'POST',
    base: base(),
    path: `/${encodeURIComponent(id)}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  const a = isRecord(body) ? approvalOf(body.approval) : null;
  if (a === null) throw new Error('Metro returned an unexpected response.');
  return a;
}
