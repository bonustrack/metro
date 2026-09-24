import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSecureDir, writeSecure } from '@metro-labs/core/secure-fs';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import type { PolicyTarget } from '../policy/policy.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalOutcome {
  ok: boolean;
  text: string;
}

export interface ApprovalRecord {
  id: string;
  target: PolicyTarget;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  agentId: string;
  preview: string;
  requesterLine?: string;
  promptLine?: string;
  requestedAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  decidedBy?: string;
  outcome?: ApprovalOutcome;
}

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz';
const ID_LENGTH = 5;
const RECENT_MAX = 50;
const FILE = 'approvals.json';

const records = new Map<string, ApprovalRecord>();
let loadedFrom: string | undefined;

const filePath = (): string => join(agentsDir(), FILE);

const isTarget = (raw: unknown): raw is PolicyTarget =>
  isRecord(raw) &&
  ((raw.kind === 'channel' && typeof raw.station === 'string' && typeof raw.account === 'string') ||
    (raw.kind === 'connector' && typeof raw.id === 'string'));

const STATUSES = new Set<string>(['pending', 'approved', 'rejected', 'expired']);

const TEXT_FIELDS = ['id', 'tool', 'agentId', 'requestedAt', 'expiresAt', 'label', 'preview'] as const;

function recordOf(raw: unknown): ApprovalRecord | undefined {
  if (!isRecord(raw) || !isTarget(raw.target) || !isRecord(raw.args)) return undefined;
  if (TEXT_FIELDS.some((field) => typeof raw[field] !== 'string')) return undefined;
  return typeof raw.status === 'string' && STATUSES.has(raw.status) ? (raw as unknown as ApprovalRecord) : undefined;
}

function load(): void {
  const path = filePath();
  if (loadedFrom === path) return;
  loadedFrom = path;
  records.clear();
  if (!existsSync(path)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const list = isRecord(parsed) && Array.isArray(parsed.approvals) ? parsed.approvals : [];
    for (const raw of list) {
      const rec = recordOf(raw);
      if (rec === undefined) log.warn({ path }, 'approvals: a stored approval is not valid, dropped');
      else records.set(rec.id, rec);
    }
  } catch (err) {
    log.warn({ path, err: errMsg(err) }, 'approvals: the approvals file cannot be read, starting empty');
  }
}

function trimDecided(): void {
  const decided = [...records.values()]
    .filter((r) => r.status !== 'pending')
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  for (const old of decided.slice(RECENT_MAX)) records.delete(old.id);
}

export function saveApprovals(): void {
  trimDecided();
  const path = filePath();
  ensureSecureDir(agentsDir());
  writeSecure(path, `${JSON.stringify({ version: 1, approvals: [...records.values()] }, null, 2)}\n`);
}

function freshId(): string {
  for (;;) {
    let id = '';
    for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET.charAt(randomInt(ID_ALPHABET.length));
    if (!records.has(id)) return id;
  }
}

export type NewApproval = Omit<ApprovalRecord, 'id' | 'requestedAt' | 'expiresAt' | 'status'>;

export function addApproval(input: NewApproval, now = Date.now()): ApprovalRecord {
  load();
  const rec: ApprovalRecord = {
    ...input,
    id: freshId(),
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    status: 'pending',
  };
  records.set(rec.id, rec);
  saveApprovals();
  return rec;
}

export function getApproval(id: string): ApprovalRecord | undefined {
  load();
  return records.get(id);
}

export function listApprovals(): ApprovalRecord[] {
  load();
  return [...records.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export function overdueApprovals(now = Date.now()): ApprovalRecord[] {
  load();
  return [...records.values()].filter((r) => r.status === 'pending' && Date.parse(r.expiresAt) <= now);
}

export function forgetLoadedApprovals(): void {
  records.clear();
  loadedFrom = undefined;
}
