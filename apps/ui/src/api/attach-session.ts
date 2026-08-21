import { call } from './client';
import { isRecord } from './accounts';

export type AttachStep = 'code' | 'password' | 'scan' | 'pair';

export interface AttachSession {
  attachId: string;
  station: string;
  status: 'pending' | 'done' | 'failed';
  step: AttachStep | null;
  prompt: string;
  qr: string | null;
  pairingCode: string | null;
  accountId: string | null;
  identity: Record<string, string>;
  activated: boolean;
  error: string | null;
}

const STEPS: AttachStep[] = ['code', 'password', 'scan', 'pair'];

const text = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

export function toIdentity(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value))
    if (typeof raw === 'string' && raw !== '') out[key] = raw;
  return out;
}

export function isAttachSession(body: unknown): body is Record<string, unknown> {
  return isRecord(body) && typeof body.attachId === 'string';
}

export function toSession(body: unknown): AttachSession {
  if (!isAttachSession(body))
    throw new Error('Metro returned an unexpected response.');
  const status = body.status;
  const step = body.step;
  return {
    attachId: body.attachId as string,
    station: typeof body.station === 'string' ? body.station : '',
    status:
      status === 'done' || status === 'failed' ? status : 'pending',
    step: STEPS.find((s) => s === step) ?? null,
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    qr: text(body.qr),
    pairingCode: text(body.pairingCode),
    accountId: text(body.accountId),
    identity: toIdentity(body.identity),
    activated: body.activated === true,
    error: text(body.error),
  };
}

const sessionPath = (agentId: string, attachId: string): string =>
  `/${agentId}/accounts/${encodeURIComponent(attachId)}`;

export async function pollAttachSession(
  token: string,
  agentId: string,
  attachId: string,
): Promise<AttachSession> {
  return toSession(
    await call(token, { method: 'GET', path: sessionPath(agentId, attachId) }),
  );
}

export async function submitAttachStep(
  token: string,
  agentId: string,
  attachId: string,
  input: { code?: string; password?: string },
): Promise<AttachSession> {
  return toSession(
    await call(token, {
      method: 'POST',
      path: `${sessionPath(agentId, attachId)}/step`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function cancelAttachSession(
  token: string,
  agentId: string,
  attachId: string,
): Promise<void> {
  await call(token, {
    method: 'DELETE',
    path: sessionPath(agentId, attachId),
  });
}
