import { TrainError } from '@metro-labs/core/train-error';

export const STAGE_NAMES_PARENT = 'stage.base.eth';
export const STAGE_PROXY = 'https://proxy.stage.box';
const LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN = 6;
const MAX = 32;
const HEADERS = { 'content-type': 'application/json', 'x-stage-client': '1' };

export const proxyBase = (): string => process.env.METRO_STAGE_PROXY ?? STAGE_PROXY;

export const stageNameOf = (label: string): string => `${label}.${STAGE_NAMES_PARENT}`;

export function parseLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (label.length < MIN) throw new TrainError('bad_request', `a name needs at least ${String(MIN)} characters`);
  if (label.length > MAX) throw new TrainError('bad_request', `a name can have at most ${String(MAX)} characters`);
  if (!LABEL_RE.test(label)) throw new TrainError('bad_request', 'a name is lowercase letters, digits and single inner hyphens');
  return label;
}

export const claimMessage = (label: string, address: string, issuedAt: number): string =>
  `Claim ${stageNameOf(label)} for ${address.toLowerCase()} at ${String(issuedAt)}`;

async function ask(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${proxyBase()}/names/${path}`, { ...init, headers: HEADERS, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new TrainError('names_unreachable', `could not reach the stage name service: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: unknown = await res.json().catch(() => null);
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (!res.ok) throw new TrainError('names_refused', typeof record.error === 'string' ? record.error : `the stage name service answered ${String(res.status)}`);
  return record;
}

export async function nameOf(address: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const body = await ask(`status?address=${encodeURIComponent(address)}`, {}, fetchImpl);
  return typeof body.name === 'string' && body.name !== '' ? body.name : null;
}

export async function checkLabel(label: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const body = await ask(`check?label=${encodeURIComponent(label)}`, {}, fetchImpl);
  if (body.valid !== true) throw new TrainError('bad_request', typeof body.reason === 'string' ? body.reason : `${stageNameOf(label)} is not a valid name`);
  if (body.available !== true) throw new TrainError('name_taken', `${stageNameOf(label)} is already taken`);
}

export async function claimName(
  label: string,
  address: string,
  sign: (message: string) => Promise<string>,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  await checkLabel(label, fetchImpl);
  const signature = await sign(claimMessage(label, address, now));
  const body = await ask('claim', { method: 'POST', body: JSON.stringify({ label, address, issuedAt: now, signature }) }, fetchImpl);
  if (typeof body.name !== 'string' || body.name === '') throw new TrainError('names_refused', 'the stage name service issued no name');
  return body.name;
}
