import { filled, isRecord } from './read.js';
import { call } from './client.js';

type AttachStep = 'code' | 'password' | 'scan' | 'pair' | 'device' | 'browser';

export interface AttachSession {
  attachId: string;
  station: string;
  status: 'pending' | 'done' | 'failed';
  step: AttachStep | null;
  prompt: string;
  qr: string | null;
  pairingCode: string | null;
  userCode: string | null;
  verificationUri: string | null;
  authorizeUrl: string | null;
  accountId: string | null;
  identity: Record<string, string>;
  activated: boolean;
  error: string | null;
}

const DEVICE_LOGIN = 'https://microsoft.com/devicelogin';

export function signInPage(uri: string | null): string {
  return uri?.startsWith('https://') === true ? uri : DEVICE_LOGIN;
}

const STEPS: AttachStep[] = ['code', 'password', 'scan', 'pair', 'device', 'browser'];


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
    qr: filled(body.qr),
    pairingCode: filled(body.pairingCode),
    userCode: filled(body.userCode),
    verificationUri: filled(body.verificationUri),
    authorizeUrl: filled(body.authorizeUrl),
    accountId: filled(body.accountId),
    identity: toIdentity(body.identity),
    activated: body.activated === true,
    error: filled(body.error),
  };
}

export interface StepBody {
  code?: string;
  password?: string;
  mode?: 'device';
}

export function stateOf(authorizeUrl: string): string {
  try {
    return new URL(authorizeUrl).searchParams.get('state') ?? '';
  } catch {
    return '';
  }
}

const sessionPath = (agentId: string, attachId: string): string =>
  `/${agentId}/accounts/${encodeURIComponent(attachId)}`;

export async function pollAttachSession(
  agentId: string,
  attachId: string,
): Promise<AttachSession> {
  return toSession(
    await call({ method: 'GET', path: sessionPath(agentId, attachId) }),
  );
}

export async function submitAttachStep(
  agentId: string,
  attachId: string,
  input: StepBody,
): Promise<AttachSession> {
  return toSession(
    await call({
      method: 'POST',
      path: `${sessionPath(agentId, attachId)}/step`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function cancelAttachSession(
  agentId: string,
  attachId: string,
): Promise<void> {
  await call({
    method: 'DELETE',
    path: sessionPath(agentId, attachId),
  });
}
